/**
 * MiniMax 托管网关的签名请求：配额与每日签到共用同一套。
 *
 * 签名是 MiniMax Code 桌面版自己的：两个硬编码常量（`I*7Cf%WZ#S&%1RlZJ&C2`
 * 与 `ooui`）加三个 md5。凭据不参与签名——它只走 `Authorization: Bearer`。
 * 上游出处与同步办法见 `vendor/mcode-runtime/PROVENANCE.md`。
 *
 * 两种查询串，同一签名：
 *
 * - **矩阵调用**（`/matrix/…`、`/v1/api/user/info`）用客户端标记 `desktop`，
 *   这是读额度那条路一直在用的形状；
 * - **公开网关调用**（`/minimax-cloud/…`，签到走这条）用官方那套 `mcode`
 *   标记（`browser_name=mcode`、`desktop_version=…`），抄自上游
 *   `packages/tui/src/runtime/public-gateway.ts`。
 */

import { createHash } from 'node:crypto'
import { matrixOrigin } from './vendor/mcode-runtime/endpoints.ts'
import type { MiniMaxCredential } from './credential.ts'

/** The desktop app's signing secret and salt, copied verbatim (see header). */
export const SIGNING_SECRET = 'I*7Cf%WZ#S&%1RlZJ&C2'
export const SIGNING_SALT = 'ooui'

/** One signed call's shape. */
export type SignedGatewayCall = {
  /** Path on the managed gateway, e.g. `/v1/api/user/info`. */
  readonly path: string
  /** GET when there is no body, POST otherwise. */
  readonly method: 'GET' | 'POST'
  /** Query parameters added on top of the client's own set. */
  readonly query?: Readonly<Record<string, string>>
  /** JSON body; `undefined` means GET. */
  readonly payload?: Record<string, unknown> | undefined
  /** The account's real user id, when the call needs one. */
  readonly realUserID?: string | undefined
}

/** The public-gateway flavour of a call (the `mcode` client markers). */
export type PublicGatewayCall = SignedGatewayCall & {
  /** The MiniMax Code version the request claims to come from. */
  readonly appVersion: string
}

/** The md5 the protocol asks for. */
export function md5(value: string): string {
  return createHash('md5').update(value).digest('hex')
}

/** Take the access token out of a message that is about to be shown. */
export function scrub(text: string, secret: string): string {
  if (secret.length < 8) return text
  return text.split(secret).join('[redacted]')
}

/** Whether an error is the caller's own abort (which must not be rewritten). */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/**
 * The login's real user id, via the signed `/v1/api/user/info`. The gateway
 * refuses requests that name a user it cannot reconcile, so every later call
 * carries this id.
 */
export async function resolveRealUserID(
  credential: MiniMaxCredential,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<string> {
  const body = await signedMatrixGet(credential, '/v1/api/user/info', {}, fetchImpl, signal)
  const data = dataOf(body)
  const user = record(data['userInfo']) ?? record(data['user_info'])
  const realUserID = field(user, 'realUserID', 'real_user_id')
  if (realUserID === undefined) throw new Error('MiniMax user-info answer carried no real user id')
  return realUserID
}

/** A signed GET to the managed gateway (`/v1/api/user/info`). */
export async function signedMatrixGet(
  credential: MiniMaxCredential,
  path: string,
  query: Record<string, string>,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  return signedMatrix(credential, path, query, undefined, fetchImpl, signal)
}

/** A signed POST to the managed gateway with a JSON body. */
export async function signedMatrixPost(
  credential: MiniMaxCredential,
  path: string,
  payload: Record<string, unknown>,
  realUserID: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  return signedMatrix(credential, path, {}, payload, fetchImpl, signal, realUserID)
}

/**
 * One signed managed-gateway call. The signature is the desktop app's: an md5
 * over the encoded path+search, the body (or `{}`), a md5 of the timestamp, and
 * the salt — plus an `x-signature` md5 over the second, the secret, and the
 * body. The token never enters the signature; it rides the Bearer header.
 */
export async function signedMatrix(
  credential: MiniMaxCredential,
  path: string,
  query: Record<string, string>,
  payload: Record<string, unknown> | undefined,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
  realUserID?: string,
): Promise<unknown> {
  const now = Date.now()
  const url = new URL(path, matrixOrigin(credential.baseUrl))
  const language = credential.region === 'cn' ? 'zh' : 'en'
  url.search = new URLSearchParams({
    device_platform: 'web',
    biz_id: '3',
    app_id: '3001',
    version_code: '22201',
    unix: String(now),
    timezone_offset: String(new Date(now).getTimezoneOffset() * -1),
    sys_language: language,
    lang: language,
    device_id: '0',
    user_id: realUserID ?? '0',
    client: 'desktop',
    region: credential.region,
    is_desktop: '1',
    ...query,
  }).toString()
  const body = payload === undefined ? '' : JSON.stringify(payload)
  const second = Math.floor(now / 1000)
  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
    authorization: `Bearer ${credential.accessToken}`,
    yy: md5(`${encodeURIComponent(`${url.pathname}${url.search}`)}_${body || '{}'}${md5(String(now))}${SIGNING_SALT}`),
    'x-timestamp': String(second),
    'x-signature': md5(`${second}${SIGNING_SECRET}${body}`),
  }
  return readAnswer(credential, await send(credential, url, 'POST', headers, body, fetchImpl, signal))
}

/**
 * One signed public-gateway call — the shape the official client uses for
 * `/minimax-cloud/…` (the daily check-in lives there).
 *
 * The query carries the `mcode` client markers and the MiniMax Code version;
 * the signature is the same two md5s as the matrix calls.
 */
export async function signedPublicGateway(
  credential: MiniMaxCredential,
  call: PublicGatewayCall,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const now = Date.now()
  const url = new URL(call.path, matrixOrigin(credential.baseUrl))
  const language = credential.region === 'cn' ? 'zh' : 'en'
  url.search = new URLSearchParams({
    device_platform: 'web',
    biz_id: '3',
    app_id: '3001',
    version_code: '22201',
    is_desktop: '1',
    desktop_version: call.appVersion,
    unix: String(now),
    timezone_offset: String(new Date().getTimezoneOffset() * -60),
    sys_language: language,
    lang: language,
    device_id: '0',
    os_name: process.platform,
    browser_name: 'mcode',
    user_id: call.realUserID ?? '0',
    client: 'mcode',
    ...(call.query ?? {}),
  }).toString()
  const body = call.payload === undefined ? '' : JSON.stringify(call.payload)
  const second = Math.floor(now / 1000)
  const pathWithSearch = `${url.pathname}${url.search}`
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'MiniMaxCode',
    Authorization: `Bearer ${credential.accessToken}`,
    yy: md5(`${encodeURIComponent(pathWithSearch)}_${body || '{}'}${md5(String(now))}${SIGNING_SALT}`),
    'x-timestamp': String(second),
    'x-signature': md5(`${second}${SIGNING_SECRET}${body}`),
  }
  return readAnswer(credential, await send(credential, url, call.method, headers, body, fetchImpl, signal))
}

/** One request, with the caller's abort left alone and everything else scrubbed. */
async function send(
  credential: MiniMaxCredential,
  url: URL,
  method: 'GET' | 'POST',
  headers: Record<string, string>,
  body: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<Response> {
  try {
    return await fetchImpl(url, {
      method,
      headers,
      ...(body === '' ? {} : { body }),
      ...(signal === undefined ? {} : { signal }),
    })
  } catch (error) {
    if (isAbortError(error) || signal?.aborted === true) throw error
    throw new Error(scrub(error instanceof Error ? error.message : String(error), credential.accessToken))
  }
}

/** The answer as JSON, with the token scrubbed out of every message. */
async function readAnswer(credential: MiniMaxCredential, response: Response): Promise<unknown> {
  if (!response.ok) {
    const detail = scrub(await response.text().catch(() => ''), credential.accessToken).slice(0, 500)
    throw new Error(`MiniMax request failed (${String(response.status)})${detail === '' ? '' : `: ${detail}`}`)
  }
  try {
    return await response.json()
  } catch (error) {
    throw new Error(scrub(`MiniMax answer was not JSON: ${error instanceof Error ? error.message : String(error)}`, credential.accessToken))
  }
}

/** The answer's payload: the `data` envelope when present, else the body itself. */
export function dataOf(body: unknown): Record<string, unknown> {
  const root = record(body) ?? {}
  return record(root['data']) ?? root
}

/** A record, or nothing. */
export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** The first of `keys` that carries a non-empty string. */
export function field(value: unknown, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const candidate = record(value)?.[key]
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
  }
  return undefined
}
