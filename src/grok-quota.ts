/**
 * Grok 套餐额度的宿主侧接口。
 *
 * grok-cli 的 TUI 里 `/usage` 面板有额度窗口，但 ACP 协议只给档位不给数字（2026-11-04
 * 实测：initialize/authenticate 只有 `subscription_tier`，`context`/`session-info` 是本
 * 会话统计）。数据源是 grok-cli 自己的代理域：
 *
 * - `GET cli-chat-proxy.grok.com/v1/billing?format=credits` — 周窗（currentPeriod 起止）、
 *   `creditUsagePercent`、prepaid/onDemand；直接打 grok.com 会被 Cloudflare 盾拦（403）。
 * - `GET cli-chat-proxy.grok.com/v1/user?include=subscription` — `subscriptionTier` 是档位。
 * - 凭据就是本机 `~/.grok/auth.json` 里的 OAuth 令牌（CLI 登录后写入，带跨进程锁）；
 *   令牌约一小时过期，CLI 自己用 refresh_token 续——这里只用现存令牌，401 就折成
 *   ok:false 提示 `grok login`，不在宿主侧做刷新流程。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'threadharbor-grok-quota'

/** webServer 挂路由；connection 做准入（admit）。 */
export const inject = ['webServer', 'connection']

/** exact 路由路径；浏览器侧的胶囊按这个常量取数。 */
export const QUOTA_ROUTE_PATH = '/threadharbor/grok/quota'

const GROK_BILLING_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits'
const GROK_USER_URL = 'https://cli-chat-proxy.grok.com/v1/user?include=subscription'

/** 成功应答的缓存时长；换算成上游被问的频率上限。 */
const CACHE_TTL_MS = 30_000

/** 折出来给胶囊的形状（与路由应答里的 `quota` 同形）。 */
export interface GrokQuotaFold {
  ok: true
  quota: {
    weekly?: { kind: 'weekly'; percent: number; windowSeconds?: number; resetAt?: number }
    tier?: string
  }
}
export type GrokFoldResult = GrokQuotaFold | { ok: false; error: string }

/** 模块级可替换的取数器：生产走真令牌真网络，测试换假件。 */
type FetchImpl = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ status: number; text(): string }>

let grokFetch: FetchImpl | undefined
let grokAuth: (() => { token: string } | undefined) | undefined

/** 换取数器（测试注入假件）；传回 undefined 恢复真件。 */
export function swapGrokFetch(next: FetchImpl | undefined): void {
  grokFetch = next
}

/** 换凭据读取器（测试注入假件）；传回 undefined 恢复真件。 */
export function swapGrokAuth(next: (() => { token: string } | undefined) | undefined): void {
  grokAuth = next
}

/** 恢复生产实现（afterEach 用）。 */
export function resetGrokSwaps(): void {
  grokFetch = undefined
  grokAuth = undefined
}

/**
 * 读本机 grok-cli 的登录凭据：`~/.grok/auth.json` 按「issuer::账号」分桶，可能不止
 * 一个，取有效期最晚的那只（CLI 刷新后 expires_at 会前移）。
 * @returns 可用的 Bearer 令牌；没有登录时 undefined。
 */
function readAuthToken(): string | undefined {
  if (grokAuth !== undefined) return grokAuth()?.token
  let raw: string
  try {
    raw = readFileSync(join(homedir(), '.grok', 'auth.json'), 'utf8')
  } catch {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  let best: { token: string; expiresAt: number } | undefined
  for (const value of Object.values(parsed as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue
    const entry = value as Record<string, unknown>
    if (typeof entry.key !== 'string' || entry.key === '') continue
    const expiresAt = typeof entry.expires_at === 'string' ? Date.parse(entry.expires_at) : Number.NaN
    const rank = Number.isFinite(expiresAt) ? expiresAt : 0
    if (best === undefined || rank >= best.expiresAt) best = { token: entry.key, expiresAt: rank }
  }
  return best?.token
}

/** 数字或金额壳（`{ val: n }`）；只用来判形状，不进数字。 */
function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'object' && value !== null && 'val' in (value as Record<string, unknown>)) {
    const inner = (value as { val?: unknown }).val
    if (typeof inner === 'number' && Number.isFinite(inner)) return inner
  }
  return undefined
}

/**
 * 把 billing / user 两份应答折成胶囊的应答形状。
 *
 * 单独导出给测试：折算口径是用户看得见的行为——周窗百分比、重置时刻、档位。
 * @param billing - `/v1/billing?format=credits` 的 JSON（`config` 里带窗口与限额）。
 * @param user - `/v1/user?include=subscription` 的 JSON（`subscriptionTier` 是档位）。
 */
export function foldGrokUsage(billing: unknown, user: unknown): GrokFoldResult {
  if (typeof billing !== 'object' || billing === null) return { ok: false, error: 'unrecognised grok billing answer' }
  const config = (billing as { config?: unknown }).config
  if (typeof config !== 'object' || config === null) return { ok: false, error: 'unrecognised grok billing answer — no config' }
  const body = config as Record<string, unknown>
  const percent = asNumber(body.creditUsagePercent)
  const period = (typeof body.currentPeriod === 'object' && body.currentPeriod !== null ? body.currentPeriod : {}) as Record<string, unknown>
  const startMs = typeof period.start === 'string' ? Date.parse(period.start) : Number.NaN
  const endMs = typeof period.end === 'string' ? Date.parse(period.end) : Number.NaN
  if (percent === undefined) return { ok: false, error: 'unrecognised grok billing answer — no creditUsagePercent' }
  if (!Number.isFinite(endMs)) return { ok: false, error: 'unrecognised grok billing answer — no period end' }
  const windowSeconds = Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.round((endMs - startMs) / 1000) : undefined
  const tier = typeof (user as { subscriptionTier?: unknown } | null)?.subscriptionTier === 'string'
    ? (user as { subscriptionTier: string }).subscriptionTier
    : undefined
  return {
    ok: true,
    quota: {
      weekly: {
        kind: 'weekly',
        percent,
        ...(windowSeconds === undefined ? {} : { windowSeconds }),
        ...(Number.isFinite(endMs) ? { resetAt: endMs } : {}),
      },
      ...(tier === undefined ? {} : { tier }),
    },
  }
}

/** 这个入口需要的宿主面（窄接口，测试立桩照这个来）。 */
export interface GrokQuotaContext {
  effect(factory: () => unknown, label?: string): unknown
  webServer: {
    register(route: {
      kind: 'exact'
      path: string
      handler(request: IncomingMessage, response: ServerResponse): void | Promise<void>
    }): (() => void) | void
  }
  connection: {
    admit(request: IncomingMessage): { rejection: number } | { peer: unknown }
  }
}

/** 注册时可选的注入面；生产空着，测试换缓存时长。 */
export interface GrokQuotaRouteDeps {
  /** 成功应答的缓存时长（毫秒）；缺省 30 秒。 */
  ttlMs?: number
}

/** 注册配额路由：effect 挂 webServer.register，缓存在闭包里。 */
export function registerGrokQuotaRoute(ctx: GrokQuotaContext, deps: GrokQuotaRouteDeps = {}): void {
  const ttlMs = deps.ttlMs ?? CACHE_TTL_MS
  let cached: { at: number; payload: unknown } | undefined
  const load = async (): Promise<GrokFoldResult> => {
    const token = readAuthToken()
    if (token === undefined) {
      return { ok: false, error: 'no grok login under ~/.grok/auth.json — run `grok login` first' }
    }
    const headers = {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      'x-grok-client-identifier': 'xai-grok-cli',
    }
    const fetcher = grokFetch ?? (async (url: string, init?: { headers?: Record<string, string> }) => {
      const response = await fetch(url, { headers: init?.headers })
      // 正文先读成字符串再交出去：下游按同步 text() 消费，测试假件也是这个形状。
      const text = await response.text()
      return { status: response.status, text: () => text }
    })
    let billing: { status: number; text(): string }
    let user: { status: number; text(): string }
    try {
      [billing, user] = await Promise.all([
        fetcher(GROK_BILLING_URL, { headers }),
        fetcher(GROK_USER_URL, { headers }),
      ])
    } catch (error) {
      return { ok: false, error: `grok billing request failed: ${error instanceof Error ? error.message : String(error)}` }
    }
    if (billing.status === 401 || user.status === 401) {
      return { ok: false, error: 'grok token expired or rejected — run `grok login` to refresh' }
    }
    if (billing.status !== 200) {
      return { ok: false, error: `HTTP ${String(billing.status)}: the grok billing route answered an error` }
    }
    let billingBody: unknown
    let userBody: unknown
    try {
      billingBody = JSON.parse(billing.text())
    } catch (error) {
      return { ok: false, error: `the grok billing route answered no JSON (${error instanceof Error ? error.message : String(error)})` }
    }
    try {
      userBody = user.status === 200 ? JSON.parse(user.text()) : undefined
    } catch {
      userBody = undefined
    }
    return foldGrokUsage(billingBody, userBody)
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: QUOTA_ROUTE_PATH,
    async handler(req, res) {
      // 拒绝分支照官方 /api 的写法：状态码原样，短体固定。
      const admission = ctx.connection.admit(req)
      if ('rejection' in admission) {
        res.writeHead(admission.rejection)
        res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      if (req.method !== 'GET') {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET' })
        res.end('method not allowed')
        return
      }
      const now = Date.now()
      if (cached !== undefined && now - cached.at < ttlMs) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(cached.payload))
        return
      }
      const result = await load()
      const payload = result.ok
        ? { ok: true, quota: result.quota }
        : { ok: false, error: result.error }
      if (result.ok) cached = { at: now, payload }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(payload))
    },
  }), 'threadharbor-grok-quota: quota route')
}

/** DSH 插件的入口：注册配额路由。 */
export function apply(ctx: GrokQuotaContext): void {
  registerGrokQuotaRoute(ctx)
}
