/**
 * WorkBuddy 的账号登录、轮询与续期。
 *
 * 它自己的那套流程是四步：站点给一个 state 与一个登录网址 → 浏览器里授权 →
 * 站点把令牌绑在这个 state 上 → 客户端轮询拿令牌。
 *
 * 两个容易踩的点：
 * - **「还在登录中」不是错误**。轮询期间站点回业务码 11217，把它当错误处理，
 *   登录就永远失败。
 * - **登录接口那几个「不要带鉴权」的头必须带**（`X-No-Authorization` 等）。带旧
 *   令牌去要登录凭证，站点会直接拒绝。
 *
 * 响应外壳是 `{ code, msg, requestId, data: { … } }`——真正的内容在 `data` 里，
 * 少读一层就全是 undefined。
 */

import { resolveEndpoints, WORKBUDDY_PLATFORM } from './endpoints.ts'
import type { WorkBuddyEndpoints } from './endpoints.ts'

/** 「还在登录中」的业务码。 */
export const LOGIN_PENDING_CODE = 11217

/** 轮询的默认间隔与上限。 */
const DEFAULT_POLL_INTERVAL_MS = 2_000
const DEFAULT_POLL_TIMEOUT_MS = 5 * 60_000

export type WorkBuddyLoginStart = {
  readonly state: string
  /** 浏览器要打开的授权地址。 */
  readonly url: string
}

export type WorkBuddyAccount = {
  readonly uid: string
  readonly nickname?: string | undefined
  readonly enterpriseId?: string | undefined
}

export type WorkBuddyCredential = {
  readonly accessToken: string
  readonly refreshToken?: string | undefined
  /** 访问令牌的到期时刻（毫秒时间戳）。 */
  readonly expiresAt?: number | undefined
  readonly account?: WorkBuddyAccount | undefined
}

export type AuthOptions = {
  readonly endpoints?: WorkBuddyEndpoints | undefined
  readonly fetchImpl?: typeof fetch | undefined
}

/**
 * 开始一次登录：向站点要 state 与授权地址。
 * @param options - 端点与 fetch 实现（测试注入）。
 * @returns state 与授权地址。
 */
export async function startLogin(options: AuthOptions = {}): Promise<WorkBuddyLoginStart> {
  const endpoints = options.endpoints ?? resolveEndpoints()
  const fetchImpl = options.fetchImpl ?? fetch
  const url = `${endpoints.authStateUrl}?platform=${encodeURIComponent(WORKBUDDY_PLATFORM)}`
  const payload = await postJson(fetchImpl, endpoints, url, {})
  const data = payload['data']
  if (!isRecord(data)) throw new Error('WorkBuddy 登录：站点没给登录地址')
  const state = typeof data['state'] === 'string' ? data['state'] : ''
  const authUrl = typeof data['authUrl'] === 'string' ? data['authUrl'] : ''
  if (state === '' || authUrl === '') throw new Error('WorkBuddy 登录：站点没给登录地址')
  return { state, url: authUrl }
}

/**
 * 轮询直到拿到令牌。
 *
 * pending 继续等；别的业务码直接报错；等到上限还没登录好就说没等到。
 * @param options - state、端点、轮询间隔与上限。
 * @returns 拿到的凭据。
 */
export async function pollForToken(options: {
  readonly state: string
  readonly endpoints?: WorkBuddyEndpoints | undefined
  readonly fetchImpl?: typeof fetch | undefined
  readonly timeoutMs?: number | undefined
  readonly intervalMs?: number | undefined
  readonly signal?: AbortSignal | undefined
}): Promise<WorkBuddyCredential> {
  const endpoints = options.endpoints ?? resolveEndpoints()
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS
  const intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const url = `${endpoints.authTokenUrl}?state=${encodeURIComponent(options.state)}`
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (options.signal?.aborted === true) throw new Error('WorkBuddy 登录：已取消')
    const payload = await getJson(fetchImpl, endpoints, url)
    const code = typeof payload['code'] === 'number' ? payload['code'] : 0
    if (code === LOGIN_PENDING_CODE) {
      await sleep(intervalMs)
      continue
    }
    if (code !== 0) {
      throw new Error(`WorkBuddy 登录：${messageOf(payload, `站点回 ${String(code)}`)}`)
    }
    const credential = credentialOf(payload)
    if (credential !== undefined) return credential
    throw new Error('WorkBuddy 登录：站点没给令牌')
  }
  throw new Error('WorkBuddy 登录：没等到登录完成，请重试')
}

/**
 * 续期：拿刷新令牌换一对新令牌。
 * @param options - 刷新令牌、端点与 fetch 实现。
 * @returns 新的凭据。
 */
export async function refreshSession(options: {
  readonly refreshToken: string
  readonly endpoints?: WorkBuddyEndpoints | undefined
  readonly fetchImpl?: typeof fetch | undefined
}): Promise<WorkBuddyCredential> {
  const endpoints = options.endpoints ?? resolveEndpoints()
  const fetchImpl = options.fetchImpl ?? fetch
  const payload = await postJson(fetchImpl, endpoints, endpoints.authRefreshUrl, {}, {
    'x-refresh-token': options.refreshToken,
    'x-auth-refresh-source': 'plugin',
  })
  const credential = credentialOf(payload)
  if (credential === undefined) throw new Error('WorkBuddy 续期：站点没给令牌')
  return credential
}

/**
 * 取账户信息（用户 id、昵称、企业 id）。
 * @param options - 访问令牌、端点与 fetch 实现。
 * @returns 账户信息。
 */
export async function fetchAccount(options: {
  readonly accessToken: string
  readonly endpoints?: WorkBuddyEndpoints | undefined
  readonly fetchImpl?: typeof fetch | undefined
}): Promise<WorkBuddyAccount> {
  const endpoints = options.endpoints ?? resolveEndpoints()
  const fetchImpl = options.fetchImpl ?? fetch
  const payload = await getJson(fetchImpl, endpoints, endpoints.accountUrl, {
    authorization: `Bearer ${options.accessToken}`,
  })
  const data = payload['data']
  if (!isRecord(data)) throw new Error('WorkBuddy 账户：站点没给账户信息')
  const uid = typeof data['uid'] === 'string' ? data['uid'] : ''
  if (uid === '') throw new Error('WorkBuddy 账户：站点没给账户信息')
  const nickname = typeof data['nickname'] === 'string' ? data['nickname'] : undefined
  const enterpriseId = typeof data['enterpriseId'] === 'string' ? data['enterpriseId'] : undefined
  return {
    uid,
    ...(nickname === undefined ? {} : { nickname }),
    ...(enterpriseId === undefined ? {} : { enterpriseId }),
  }
}

/** 登录类接口的头：声明「不要带鉴权」，并带上站点域名。 */
function authHeaders(endpoints: WorkBuddyEndpoints, extra: Record<string, string> = {}): Record<string, string> {
  let host = ''
  try {
    host = new URL(endpoints.base).host
  } catch {
    host = ''
  }
  return {
    'content-type': 'application/json',
    'x-no-authorization': 'true',
    'x-no-user-id': 'true',
    'x-no-enterprise-id': 'true',
    'x-no-department-info': 'true',
    ...(host === '' ? {} : { 'x-domain': host }),
    ...extra,
  }
}

async function postJson(
  fetchImpl: typeof fetch,
  endpoints: WorkBuddyEndpoints,
  url: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: authHeaders(endpoints, extraHeaders),
    body: JSON.stringify(body),
  })
  return payloadOf(response)
}

async function getJson(
  fetchImpl: typeof fetch,
  endpoints: WorkBuddyEndpoints,
  url: string,
  extraHeaders: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, { method: 'GET', headers: authHeaders(endpoints, extraHeaders) })
  return payloadOf(response)
}

async function payloadOf(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text().catch(() => '')
  if (!response.ok) throw new Error(`WorkBuddy 请求失败（${String(response.status)}）：${text.slice(0, 300)}`)
  try {
    const parsed = JSON.parse(text) as unknown
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** 从响应里取令牌（内容在 `data` 里）。 */
function credentialOf(payload: Record<string, unknown>): WorkBuddyCredential | undefined {
  const data = payload['data']
  if (!isRecord(data)) return undefined
  const accessToken = typeof data['accessToken'] === 'string' ? data['accessToken'] : ''
  if (accessToken === '') return undefined
  const refreshToken = typeof data['refreshToken'] === 'string' ? data['refreshToken'] : undefined
  const expiresIn = typeof data['expiresIn'] === 'number' ? data['expiresIn'] : undefined
  return {
    accessToken,
    ...(refreshToken === undefined ? {} : { refreshToken }),
    ...(expiresIn === undefined ? {} : { expiresAt: Date.now() + expiresIn * 1000 }),
  }
}

function messageOf(payload: Record<string, unknown>, fallback: string): string {
  const msg = payload['msg']
  return typeof msg === 'string' && msg !== '' ? msg : fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>(resolve => setTimeout(resolve, ms))
}
