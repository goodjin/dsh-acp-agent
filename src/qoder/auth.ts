/** Qoder global device flow, verified against bundled worker 1.1.79-hotfix.11 (2026-11-05). */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

export const OPEN_API = 'https://openapi.qoder.sh'
export const MODEL_URL = 'https://api2-v2.qoder.sh/model/v1/chat/completions'
export type Credential = {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  machineId: string
  account?: { uid: string; nickname?: string }
}
export type Login = { url: string; nonce: string; verifier: string; machineId: string }
export function startLogin(): Login {
  const verifier = randomBytes(48).toString('base64url')
  const nonce = randomUUID(), machineId = randomUUID()
  const params = new URLSearchParams({
    challenge: createHash('sha256').update(verifier).digest('base64url'),
    challenge_method: 'S256', nonce, machine_id: machineId,
    client_id: 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb',
  })
  return { url: `https://qoder.com/device/selectAccounts?${params}`, nonce, verifier, machineId }
}
export function credentialOf(value: unknown, machineId: string, refresh = false): Credential {
  const data = record(value)
  const token = data[refresh ? 'device_token' : 'token']
  if (typeof token !== 'string' || !token) throw new Error('Qoder 登录响应缺少令牌')
  const absolute = typeof data.expires_at === 'string' ? Date.parse(data.expires_at) : NaN
  const relative = typeof data.expires_in === 'number' ? Date.now() + data.expires_in * 1000 : NaN
  const expiresAt = Number.isFinite(absolute) ? absolute : relative
  return {
    accessToken: token, machineId,
    ...(typeof data.refresh_token === 'string' ? { refreshToken: data.refresh_token } : {}),
    ...(Number.isFinite(expiresAt) ? { expiresAt } : {}),
    ...(typeof data.user_id === 'string' ? { account: { uid: data.user_id,
      ...(typeof data.user_name === 'string' ? { nickname: data.user_name } : {}) } } : {}),
  }
}
export async function pollForToken(login: Login, options: {
  fetchImpl?: typeof fetch; signal?: AbortSignal; timeoutMs?: number; intervalMs?: number
} = {}): Promise<Credential> {
  const signal = AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? 300_000), ...(options.signal ? [options.signal] : [])])
  const params = new URLSearchParams({ nonce: login.nonce, verifier: login.verifier, challenge_method: 'S256' })
  while (true) {
    signal.throwIfAborted()
    const response = await (options.fetchImpl ?? fetch)(`${OPEN_API}/api/v1/deviceToken/poll?${params}`, {
      headers: { Accept: 'application/json' }, signal, redirect: 'error',
    })
    // This is an expected pending status, measured on the public service.
    if (response.status === 404) {
      await response.body?.cancel()
      await delay(options.intervalMs ?? 1000, undefined, { signal })
      continue
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Qoder 登录失败（HTTP ${response.status}）`) }
    return credentialOf(await response.json(), login.machineId)
  }
}
export async function refreshCredential(old: Credential, fetchImpl: typeof fetch = fetch): Promise<Credential> {
  if (!old.refreshToken) throw new Error('Qoder 登录已过期，请在设置中重新登录')
  const response = await fetchImpl(`${OPEN_API}/api/v1/deviceToken/refresh`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ refresh_token: old.refreshToken, machine_id: old.machineId }),
  })
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Qoder 续期失败（HTTP ${response.status}），请重新登录`) }
  const next = credentialOf(await response.json(), old.machineId, true)
  return { ...old, ...next, refreshToken: next.refreshToken ?? old.refreshToken }
}
export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
