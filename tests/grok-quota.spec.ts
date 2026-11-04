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
 *   ok:false 提示 `grok login`，不在宿主侧做刷新。
 *
 * 这一族各测一段：路由与准入照抄 zcode/minimaxi 那两条；折算口径（周窗 + 档位）单独
 * 导出直接测；故障（没登录、401、非 200、坏 JSON、形状不认识）全部折成 ok:false。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import {
  apply,
  foldGrokUsage,
  QUOTA_ROUTE_PATH,
  registerGrokQuotaRoute,
  resetGrokSwaps,
  swapGrokAuth,
  swapGrokFetch,
} from '../src/grok-quota.ts'
import type { GrokQuotaContext } from '../src/grok-quota.ts'

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
interface CapturedRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: RouteHandler
}

/** 假 connection：无 cookie 401，Host 不可信 403，通过则给 peer。 */
function fakeConnection(options: { trustedHost?: string } = {}) {
  const calls = { admit: [] as unknown[] }
  const connection = {
    admit(request: { headers?: Record<string, string> }) {
      calls.admit.push(request)
      if (options.trustedHost !== undefined && request.headers?.['host'] !== options.trustedHost) {
        return { rejection: 403 as const }
      }
      if ((request.headers?.['cookie'] ?? '') !== 'dsh-session=good') {
        return { rejection: 401 as const }
      }
      return { peer: { role: 'operator' } }
    },
  }
  return { calls, connection }
}

/** 最小宿主面：effect 立即执行，webServer.register 捕获路由。apply 后取 routes[0]。 */
function rig(admitSource = fakeConnection()) {
  const routes: CapturedRoute[] = []
  const ctx = {
    effect(factory: () => unknown) {
      factory()
      return () => {}
    },
    webServer: {
      register(route: CapturedRoute) {
        routes.push(route)
        return () => {}
      },
    },
    connection: admitSource.connection,
  } as unknown as GrokQuotaContext
  apply(ctx)
  const route = routes[0]
  if (route === undefined) throw new Error('route was not registered')
  return { ctx, route, calls: admitSource.calls }
}

/** 请进来一次的请求（默认带合法 cookie），收回应答的状态码与体。 */
async function callRoute(
  route: CapturedRoute,
  init: { method?: string; cookie?: string; host?: string } = {},
): Promise<{ status: number; body: unknown }> {
  const req = {
    method: init.method ?? 'GET',
    headers: {
      ...(init.host === undefined ? {} : { host: init.host }),
      cookie: init.cookie ?? 'dsh-session=good',
    },
  } as IncomingMessage
  let status: number | undefined
  let raw = ''
  const res = {
    writeHead(s: number) { status = s },
    end(body?: unknown) { raw = typeof body === 'string' ? body : String(body ?? '') },
  } as unknown as ServerResponse
  await route.handler(req, res)
  let parsed: unknown = raw
  if (raw !== '') {
    try { parsed = JSON.parse(raw) } catch { /* 原样返回短体 */ }
  }
  return { status: status as number, body: parsed }
}

/** grok-cli 代理域的两份应答：billing（周窗）+ user（档位）。 */
const BILLING = {
  config: {
    currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', start: '2026-10-29T01:25:52.116718+00:00', end: '2026-11-05T01:25:52.116718+00:00' },
    creditUsagePercent: 42.5,
    onDemandCap: { val: 0 },
    onDemandUsed: { val: 0 },
    productUsage: [{ product: 'GrokBuild', usagePercent: 42.5 }],
    prepaidBalance: { val: 0 },
    billingPeriodStart: '2026-10-29T01:25:52.116718+00:00',
    billingPeriodEnd: '2026-11-05T01:25:52.116718+00:00',
  },
}
const USER = { userId: 'u-1', subscriptionTier: 'GrokPro' }

/** 假 fetch：按 URL 分流，记下每次请求。 */
function fakeFetch(byUrl: Record<string, { status: number; body: unknown }>, asked: string[] = []) {
  return (async (url: string) => {
    asked.push(url)
    const hit = byUrl[url]
    if (hit === undefined) return { status: 404, text: () => 'not found' }
    return { status: hit.status, text: () => JSON.stringify(hit.body) }
  }) as Parameters<typeof swapGrokFetch>[0]
}

afterEach(() => {
  resetGrokSwaps()
})

describe('路由与准入', () => {
  it('装载即注册一条 exact 路由在固定路径', () => {
    const { route } = rig()
    expect(route).toMatchObject({ kind: 'exact', path: QUOTA_ROUTE_PATH })
    expect(QUOTA_ROUTE_PATH).toBe('/acp-agent/grok/quota')
  })

  it('准入照官方：拒绝时状态码原样、短体固定，不取数', async () => {
    const { calls, route } = rig(fakeConnection({ trustedHost: 'dsh.local' }))
    expect(calls.admit).toHaveLength(0)
    const noCookie = await callRoute(route, { cookie: '', host: 'dsh.local' })
    expect(noCookie.status).toBe(401)
    expect(noCookie.body).toBe('unauthorized')
    const badHost = await callRoute(route, { cookie: 'dsh-session=good', host: 'evil.example' })
    expect(badHost.status).toBe(403)
    expect(badHost.body).toBe('forbidden')
    expect(calls.admit).toHaveLength(2)
  })

  it('非 GET 一律 405', async () => {
    const { route } = rig()
    const post = await callRoute(route, { method: 'POST' })
    expect(post.status).toBe(405)
  })
})

describe('折算口径 foldGrokUsage', () => {
  it('周窗百分比 + 重置时刻 + 窗口时长 + 档位，一样不少', () => {
    const folded = foldGrokUsage(BILLING, USER)
    expect(folded.ok).toBe(true)
    if (!folded.ok) return
    expect(folded.quota.weekly?.kind).toBe('weekly')
    expect(folded.quota.weekly?.percent).toBe(42.5)
    expect(folded.quota.weekly?.resetAt).toBe(Date.parse('2026-11-05T01:25:52.116718+00:00'))
    expect(folded.quota.weekly?.windowSeconds).toBe(7 * 24 * 3600)
    expect(folded.quota.tier).toBe('GrokPro')
  })

  it('user 应答坏了只丢档位，窗口照给', () => {
    const folded = foldGrokUsage(BILLING, { userId: 'u-1' })
    expect(folded.ok).toBe(true)
    if (!folded.ok) return
    expect(folded.quota.tier).toBeUndefined()
    expect(folded.quota.weekly?.percent).toBe(42.5)
  })

  it('billing 缺 creditUsagePercent / 缺 period.end：各自说出缺什么', () => {
    const noPercent = foldGrokUsage({ config: { currentPeriod: { end: '2026-11-05T00:00:00Z' } } }, USER)
    expect(noPercent.ok === false ? noPercent.error : '').toContain('creditUsagePercent')
    const noEnd = foldGrokUsage({ config: { creditUsagePercent: 1 } }, USER)
    expect(noEnd.ok === false ? noEnd.error : '').toContain('period end')
    const noConfig = foldGrokUsage({}, USER)
    expect(noConfig.ok).toBe(false)
  })
})

describe('取数与故障折叠', () => {
  const byUrl = {
    'https://cli-chat-proxy.grok.com/v1/billing?format=credits': { status: 200, body: BILLING },
    'https://cli-chat-proxy.grok.com/v1/user?include=subscription': { status: 200, body: USER },
  }

  it('有凭据时问代理域的两条接口，折出窗口与档位', async () => {
    const asked: string[] = []
    swapGrokFetch(fakeFetch(byUrl, asked))
    swapGrokAuth(() => ({ token: 'tok' }))
    const { route } = rig()
    const answer = await callRoute(route)
    expect(answer.status).toBe(200)
    expect(answer.body).toMatchObject({
      ok: true,
      quota: {
        weekly: { kind: 'weekly', percent: 42.5 },
        tier: 'GrokPro',
      },
    })
    expect(asked).toHaveLength(2)
    expect(asked.some(url => url.includes('billing'))).toBe(true)
    expect(asked.some(url => url.includes('user?include=subscription'))).toBe(true)
  })

  it('同一窗口内第二次请求走缓存，不再打上游', async () => {
    let upstreamCalls = 0
    swapGrokFetch((async (url: string) => {
      upstreamCalls += 1
      return { status: 200, text: () => JSON.stringify((byUrl as Record<string, { body: unknown }>)[url]?.body ?? {}) }
    }) as Parameters<typeof swapGrokFetch>[0])
    swapGrokAuth(() => ({ token: 'tok' }))
    const { route } = rig()
    const first = await callRoute(route)
    const second = await callRoute(route)
    expect(first.status).toBe(200)
    expect(second).toEqual(first)
    expect(upstreamCalls).toBe(2)
  })

  it('没有凭据：ok:false 提示 grok login，不发请求', async () => {
    const asked: string[] = []
    swapGrokFetch(fakeFetch(byUrl, asked))
    swapGrokAuth(() => undefined)
    const { route } = rig()
    const answer = await callRoute(route)
    expect(answer.status).toBe(200)
    expect(answer.body).toMatchObject({ ok: false })
    expect((answer.body as { error?: string }).error).toContain('grok login')
    expect(asked).toHaveLength(0)
  })

  it('401：提示令牌过期要 grok login，不冒充别的故障', async () => {
    swapGrokFetch(fakeFetch({
      'https://cli-chat-proxy.grok.com/v1/billing?format=credits': { status: 401, body: { error: 'unauthorized' } },
      'https://cli-chat-proxy.grok.com/v1/user?include=subscription': { status: 200, body: USER },
    }))
    swapGrokAuth(() => ({ token: 'expired' }))
    const { route } = rig()
    const answer = await callRoute(route)
    expect(answer.body).toMatchObject({ ok: false })
    expect((answer.body as { error?: string }).error).toContain('grok login')
  })

  it('billing 非 200：ok:false 带状态码', async () => {
    swapGrokFetch(fakeFetch({
      'https://cli-chat-proxy.grok.com/v1/billing?format=credits': { status: 502, body: {} },
      'https://cli-chat-proxy.grok.com/v1/user?include=subscription': { status: 200, body: USER },
    }))
    swapGrokAuth(() => ({ token: 'tok' }))
    const { route } = rig()
    const answer = await callRoute(route)
    expect(answer.body).toMatchObject({ ok: false })
    expect((answer.body as { error?: string }).error).toContain('502')
  })

  it('billing 回的不是 JSON：ok:false 说清是坏应答', async () => {
    swapGrokFetch((async (url: string) => (
      url.includes('billing')
        ? { status: 200, text: () => '<html>cloudflare</html>' }
        : { status: 200, text: () => JSON.stringify(USER) }
    )) as Parameters<typeof swapGrokFetch>[0])
    swapGrokAuth(() => ({ token: 'tok' }))
    const { route } = rig()
    const answer = await callRoute(route)
    expect(answer.body).toMatchObject({ ok: false })
    expect((answer.body as { error?: string }).error).toContain('JSON')
  })

  it('上游网络异常：ok:false 不抛出', async () => {
    swapGrokFetch((async () => {
      throw new Error('socket hang up')
    }) as Parameters<typeof swapGrokFetch>[0])
    swapGrokAuth(() => ({ token: 'tok' }))
    const { route } = rig()
    const answer = await callRoute(route)
    expect(answer.body).toMatchObject({ ok: false })
    expect((answer.body as { error?: string }).error).toContain('socket hang up')
  })
})
