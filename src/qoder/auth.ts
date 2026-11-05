/**
 * Qoder 国际版的登录：设备码 + PKCE。
 *
 * 核对时间：2026-11-05。来源是本机 Qoder.app 内置的 worker
 * （`@qoder-ai/qoder-agent-sdk/dist/_worker/qoder-worker-runtime.obf.mjs`）。
 *
 * 四步（worker 里的原样）：
 *
 *  1. 生成 verifier / challenge / nonce / machine_id，浏览器打开
 *     `{loginBase}/device/selectAccounts?challenge&challenge_method=S256&nonce&machine_id&client_id`；
 *  2. 轮询 `{openapiBase}/api/v1/deviceToken/poll?nonce&verifier&challenge_method=S256`；
 *  3. **HTTP 404 表示「用户还没在浏览器里授权」**——是等待态，不是错误；
 *  4. 拿到 `token` 之后，它同时充当 `security_oauth_token` 与 `access_token`，
 *     直接作模型请求的 Bearer，中间不换票。
 *
 * 续期是 `{openapiBase}/api/v1/deviceToken/refresh`，体 `{refresh_token, machine_id}`，
 * 应答里的令牌字段叫 `device_token`（不是 `token`）——两处字段名不一样，混用会
 * 一直拿到旧令牌。
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { resolveEndpoints } from './endpoints.ts'
import type { QoderEndpoints } from './endpoints.ts'

/** 国际版 prod 的 client_id（worker 里的 `Ppl`）。 */
export const QODER_CLIENT_ID = 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb'

/** 一次登录的凭据。 */
export type QoderCredential = {
  /** 模型请求的 Bearer（worker 叫它 security_oauth_token / access_token）。 */
  readonly accessToken: string
  /** 续期用的令牌。 */
  readonly refreshToken?: string | undefined
  /** 令牌到期时间（毫秒时间戳）。 */
  readonly expiresAt?: number | undefined
  /** 这台机器的标识：续期时必须一起带上。 */
  readonly machineId: string
  /** 账号。 */
  readonly account?: { readonly uid: string; readonly nickname?: string | undefined } | undefined
}

/** 一次设备码流程。 */
export type QoderLogin = {
  /** 浏览器要打开的地址。 */
  readonly url: string
  /** 本次流程的随机量。 */
  readonly nonce: string
  /** PKCE 的 verifier（只留在宿主进程里，不进浏览器）。 */
  readonly verifier: string
  /** 这台机器的标识。 */
  readonly machineId: string
}

/**
 * 起一次设备码流程。
 * @param options - 端点与机器标识（测试可注入）。
 * @returns 授权地址与轮询所需的随机量。
 */
export function startLogin(options: { endpoints?: QoderEndpoints | undefined; machineId?: string | undefined } = {}): QoderLogin {
  const endpoints = options.endpoints ?? resolveEndpoints()
  const verifier = randomBytes(48).toString('base64url')
  const nonce = randomUUID()
  const machineId = options.machineId ?? randomUUID()
  const params = new URLSearchParams({
    challenge: createHash('sha256').update(verifier).digest('base64url'),
    challenge_method: 'S256',
    nonce,
    machine_id: machineId,
    client_id: QODER_CLIENT_ID,
  })
  return { url: `${endpoints.loginBase}/device/selectAccounts?${params.toString()}`, nonce, verifier, machineId }
}

/**
 * 轮询直到用户授权。
 * @param login - 一次设备码流程。
 * @param options - fetch 实现、取消信号、超时与轮询间隔。
 * @returns 凭据。
 */
export async function pollForToken(
  login: QoderLogin,
  options: {
    readonly fetchImpl?: typeof fetch | undefined
    readonly signal?: AbortSignal | undefined
    readonly timeoutMs?: number | undefined
    readonly intervalMs?: number | undefined
    readonly endpoints?: QoderEndpoints | undefined
  } = {},
): Promise<QoderCredential> {
  const endpoints = options.endpoints ?? resolveEndpoints()
  const fetchImpl = options.fetchImpl ?? fetch
  const signal = AbortSignal.any([
    AbortSignal.timeout(options.timeoutMs ?? 300_000),
    ...(options.signal ? [options.signal] : []),
  ])
  const params = new URLSearchParams({ nonce: login.nonce, verifier: login.verifier, challenge_method: 'S256' })
  const url = `${endpoints.pollUrl}?${params.toString()}`
  while (true) {
    signal.throwIfAborted()
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal,
    })
    if (response.status === 404) {
      // 还没在浏览器里授权：等一会儿再问。
      await response.body?.cancel()
      await delay(options.intervalMs ?? 1000, undefined, { signal })
      continue
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`Qoder 登录失败（HTTP ${response.status}）`)
    }
    return credentialOfPoll(await response.json(), login.machineId)
  }
}

/**
 * 解析轮询应答。
 *
 * 应答是**顶层**的 `{token, refresh_token, expires_at | expires_in, user_id, user_name}`——
 * 没有 `data` 外壳。
 */
export function credentialOfPoll(payload: unknown, machineId: string): QoderCredential {
  const data = record(payload)
  const token = data['token']
  if (typeof token !== 'string' || token === '') throw new Error('Qoder 登录应答里没有令牌')
  const expiresAt = expiresAtOf(data)
  const refreshToken = data['refresh_token']
  const uid = data['user_id']
  const nickname = data['user_name']
  return {
    accessToken: token,
    machineId,
    ...(typeof refreshToken === 'string' && refreshToken !== '' ? { refreshToken } : {}),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(typeof uid === 'string' && uid !== '' ? {
      account: { uid, ...(typeof nickname === 'string' && nickname !== '' ? { nickname } : {}) },
    } : {}),
  }
}

/**
 * 解析续期应答。
 *
 * 续期的令牌字段叫 `device_token`（轮询那次叫 `token`）。
 */
export function credentialOfRefresh(payload: unknown, machineId: string): QoderCredential {
  const data = record(payload)
  const token = data['device_token']
  if (typeof token !== 'string' || token === '') throw new Error('Qoder 续期应答里没有令牌')
  const expiresAt = expiresAtOf(data)
  const refreshToken = data['refresh_token']
  return {
    accessToken: token,
    machineId,
    ...(typeof refreshToken === 'string' && refreshToken !== '' ? { refreshToken } : {}),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  }
}

/**
 * 续期。
 * @param old - 现在的凭据（要带 refresh_token 与 machine_id）。
 * @param options - fetch 实现。
 * @returns 换过一次的凭据。
 */
export async function refreshCredential(
  old: QoderCredential,
  options: { readonly fetchImpl?: typeof fetch | undefined; readonly endpoints?: QoderEndpoints | undefined } = {},
): Promise<QoderCredential> {
  if (!old.refreshToken) throw new Error('Qoder 登录已过期，请在设置里重新登录')
  const endpoints = options.endpoints ?? resolveEndpoints()
  const fetchImpl = options.fetchImpl ?? fetch
  const response = await fetchImpl(endpoints.refreshUrl, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ refresh_token: old.refreshToken, machine_id: old.machineId }),
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`Qoder 续期失败（HTTP ${response.status}），请重新登录`)
  }
  const next = credentialOfRefresh(await response.json(), old.machineId)
  // 明确重建，不做展开合并：**旧的到期时间不能跟着新令牌一起留下来**——
  // 留着的话每个后来者都以为它过期，于是每个都去续一次（续期风暴）。
  return {
    accessToken: next.accessToken,
    machineId: next.machineId,
    ...(next.refreshToken ?? old.refreshToken
      ? { refreshToken: next.refreshToken ?? old.refreshToken }
      : {}),
    ...(next.expiresAt === undefined ? {} : { expiresAt: next.expiresAt }),
    ...(old.account === undefined ? {} : { account: old.account }),
  }
}

/** 到期时间：绝对时间串或相对秒数都认。 */
function expiresAtOf(data: Record<string, unknown>): number | undefined {
  const absolute = typeof data['expires_at'] === 'string' ? Date.parse(data['expires_at']) : Number.NaN
  if (Number.isFinite(absolute)) return absolute
  const relative = typeof data['expires_in'] === 'number' ? Date.now() + data['expires_in'] * 1000 : Number.NaN
  return Number.isFinite(relative) ? relative : undefined
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
