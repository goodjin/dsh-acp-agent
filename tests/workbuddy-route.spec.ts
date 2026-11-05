/**
 * WorkBuddy 的登录与状态接口。
 *
 * 浏览器侧要能问「登了没」，也要能拿到一个能点开的授权地址——这两件事都在宿主这
 * 一侧做，因为令牌不能进浏览器。
 *
 * 钉住：准入照官方 /api 的写法（先 admit 后应答，拒绝时状态码原样、短体固定）；
 * 取数失败折成 200 + ok:false 而不是 500；**应答里永远没有令牌**。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import {
  apply,
  registerWorkBuddyRoutes,
  WORKBUDDY_CHECKIN_ROUTE_PATH,
  WORKBUDDY_LOGIN_ROUTE_PATH,
  WORKBUDDY_MODELS_ROUTE_PATH,
  WORKBUDDY_SESSION_ROUTE_PATH,
} from '../src/workbuddy-route.ts'
import type { WorkBuddyRouteContext } from '../src/workbuddy-route.ts'

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
interface CapturedRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: RouteHandler
}

/** 一次请求的记录。 */
interface Call {
  status: number
  body: string
}

/** 假连接：不带会话 cookie 一律 401。 */
function fakeConnection(rejection?: number) {
  return {
    authorizeIndex(): boolean {
      throw new Error('WorkBuddy 路由不应触发 index 令牌交换')
    },
    admit(request: { headers?: Record<string, string> }) {
      if (rejection !== undefined) return { rejection: rejection as 401 | 403 }
      if ((request.headers?.['cookie'] ?? '') !== 'dsh-session=good') return { rejection: 401 as const }
      return { peer: { role: 'operator' } }
    },
  }
}

/** 最小宿主面：effect 立即执行，webServer.register 捕获路由。 */
function rig(options: { rejection?: number } = {}) {
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
    connection: fakeConnection(options.rejection),
  }
  return { ctx: ctx as unknown as WorkBuddyRouteContext, routes }
}

/** 假应答：记下状态码与正文。 */
function fakeResponse(calls: Call[]): ServerResponse {
  return {
    writeHead(status: number) {
      calls.push({ status, body: '' })
      return this
    },
    end(body?: string) {
      const last = calls[calls.length - 1]
      if (last !== undefined) last.body = body ?? ''
    },
  } as unknown as ServerResponse
}

/** 发一次请求。 */
async function call(
  routes: readonly CapturedRoute[],
  path: string,
  method: string,
  options: { rejection?: number; body?: unknown } = {},
): Promise<Call> {
  const route = routes.find(candidate => candidate.path === path)
  if (route === undefined) throw new Error(`no route for ${path}`)
  const calls: Call[] = []
  const payload = options.body === undefined ? '' : JSON.stringify(options.body)
  const req = Object.assign(
    { method, headers: { cookie: 'dsh-session=good' } },
    // 请求体按异步可迭代读（宿主转发的请求就是这样过来的）。
    { [Symbol.asyncIterator]: async function* () { if (payload !== '') yield Buffer.from(payload) } },
  ) as unknown as IncomingMessage
  await route.handler(req, fakeResponse(calls))
  return calls[0] ?? { status: 0, body: '' }
}

describe('登录之后', () => {
  it('把账户信息补上存回去：模型请求要带 X-User-Id，界面要显示是谁', async () => {
    const { ctx, routes } = rig()
    const stored: unknown[] = []
    registerWorkBuddyRoutes(ctx, {
      startLogin: async () => ({ state: 'st-1', url: 'https://www.workbuddy.cn/login?state=st-1' }),
      pollForToken: async () => ({ accessToken: 'ACCESS' }),
      writeCredential: async credential => { stored.push(credential) },
      fetchAccount: async () => ({ uid: 'uid-1', nickname: '某人' }),
    })
    await call(routes, WORKBUDDY_LOGIN_ROUTE_PATH, 'POST')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(stored).toEqual([{ accessToken: 'ACCESS', account: { uid: 'uid-1', nickname: '某人' } }])
  })

  it('登录成功后刷新模型清单：选择器要马上看到真实清单', async () => {
    const { ctx, routes } = rig()
    let refreshed = 0
    registerWorkBuddyRoutes(ctx, {
      startLogin: async () => ({ state: 'st-1', url: 'https://www.workbuddy.cn/login?state=st-1' }),
      pollForToken: async () => ({ accessToken: 'ACCESS' }),
      writeCredential: async () => {},
      fetchAccount: async () => ({ uid: 'uid-1' }),
      ensureModels: async () => { refreshed += 1 },
    })
    await call(routes, WORKBUDDY_LOGIN_ROUTE_PATH, 'POST')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(refreshed).toBe(1)
  })
})

describe('模型清单与勾选', () => {
  it('给的是整份清单（不只勾了的），带着倍率与能不能用工具', async () => {
    const { ctx, routes } = rig()
    registerWorkBuddyRoutes(ctx, {
      loadCatalog: async () => [
        { id: 'glm-5.3', name: 'GLM-5.3', description: '旗舰（积分 x0.69）', credits: 'x0.69', supportsToolCall: true },
        { id: 'hy4free', name: 'Hy4', description: '免费（积分 x0.00）', credits: 'x0.00', supportsToolCall: true },
      ],
      readSelection: async () => ['glm-5.3'],
    })
    const result = await call(routes, WORKBUDDY_MODELS_ROUTE_PATH, 'GET')
    expect(result.status).toBe(200)
    const body = JSON.parse(result.body) as { ok: boolean; models: unknown[]; selected: unknown }
    expect(body.ok).toBe(true)
    expect(body.models).toHaveLength(2)
    expect(body.selected).toEqual(['glm-5.3'])
  })

  it('没自己勾过时：给的是默认那一份，并说明还没自定义', async () => {
    const { ctx, routes } = rig()
    registerWorkBuddyRoutes(ctx, {
      loadCatalog: async () => [{ id: 'glm-5.3', name: 'GLM-5.3' }],
      readSelection: async () => undefined,
    })
    const result = await call(routes, WORKBUDDY_MODELS_ROUTE_PATH, 'GET')
    const body = JSON.parse(result.body) as { selected: string[]; custom: boolean }
    expect(body.custom).toBe(false)
    expect(Array.isArray(body.selected)).toBe(true)
  })

  it('自己勾过时：给的就是勾的那份，并说明已自定义', async () => {
    const { ctx, routes } = rig()
    registerWorkBuddyRoutes(ctx, {
      loadCatalog: async () => [{ id: 'glm-5.3', name: 'GLM-5.3' }],
      readSelection: async () => ['hy4free'],
    })
    const result = await call(routes, WORKBUDDY_MODELS_ROUTE_PATH, 'GET')
    const body = JSON.parse(result.body) as { selected: string[]; custom: boolean }
    expect(body.custom).toBe(true)
    expect(body.selected).toEqual(['hy4free'])
  })

  it('勾完存下来，并立刻重发清单：选择器下一次打开就是新的', async () => {
    const { ctx, routes } = rig()
    const saved: string[][] = []
    let refreshed = 0
    registerWorkBuddyRoutes(ctx, {
      loadCatalog: async () => [{ id: 'glm-5.3', name: 'GLM-5.3' }],
      writeSelection: async (ids) => { saved.push([...ids]) },
      ensureModels: async () => { refreshed += 1 },
    })
    const result = await call(routes, WORKBUDDY_MODELS_ROUTE_PATH, 'POST', { body: { ids: ['glm-5.3', 'hy4free'] } })
    expect(result.status).toBe(200)
    expect(JSON.parse(result.body)).toEqual({ ok: true, selected: ['glm-5.3', 'hy4free'] })
    expect(saved).toEqual([['glm-5.3', 'hy4free']])
    expect(refreshed).toBe(1)
  })

  it('不支持工具调用的模型也在清单里：用户看得见、也能勾', async () => {
    const { ctx, routes } = rig()
    registerWorkBuddyRoutes(ctx, {
      loadCatalog: async () => [{ id: 'kling-video-v3', name: 'Kling-Video-V3', supportsToolCall: false }],
      readSelection: async () => undefined,
    })
    const result = await call(routes, WORKBUDDY_MODELS_ROUTE_PATH, 'GET')
    expect(JSON.parse(result.body).models).toEqual([
      { id: 'kling-video-v3', name: 'Kling-Video-V3', supportsToolCall: false },
    ])
  })
})

describe('路由', () => {
  it('两条路由挂在约定的路径上', () => {
    const { ctx, routes } = rig()
    registerWorkBuddyRoutes(ctx)
    expect(routes.map(route => route.path).sort()).toEqual([
      WORKBUDDY_CHECKIN_ROUTE_PATH,
      WORKBUDDY_LOGIN_ROUTE_PATH,
      WORKBUDDY_MODELS_ROUTE_PATH,
      WORKBUDDY_SESSION_ROUTE_PATH,
    ].sort())
  })

  it('宿主按 apply(ctx, config) 调用时挂的也是这些', () => {
    // 宿主把插件配置当第二个参数传进来；注入面不能占这个位置，
    // 否则配置里的字段会被当成注入面读。
    const { ctx, routes } = rig()
    apply(ctx, { startLogin: async () => ({ state: 'x', url: 'https://x.example' }) })
    expect(routes.map(route => route.path).sort()).toEqual([
      WORKBUDDY_CHECKIN_ROUTE_PATH,
      WORKBUDDY_LOGIN_ROUTE_PATH,
      WORKBUDDY_MODELS_ROUTE_PATH,
      WORKBUDDY_SESSION_ROUTE_PATH,
    ].sort())
  })
})

describe('状态', () => {
  it('没登录时说的是「需要登录」', async () => {
    const { ctx, routes } = rig()
    registerWorkBuddyRoutes(ctx, {
      credentialFile: '/tmp/workbuddy-does-not-exist.json',
    })
    const result = await call(routes, WORKBUDDY_SESSION_ROUTE_PATH, 'GET')
    expect(result.status).toBe(200)
    expect(JSON.parse(result.body)).toEqual({ ok: true, authenticated: false, needsLogin: true })
  })

  it('令牌里没有账户信息时补一次，界面上要显示是谁', async () => {
    const { ctx, routes } = rig()
    registerWorkBuddyRoutes(ctx, {
      credentialFile: '/tmp/workbuddy-session-fixture.json',
      readCredential: async () => ({ accessToken: 'ACCESS' }),
      fetchAccount: async () => ({ uid: 'uid-2', nickname: '补出来的' }),
      attachAccount: async (who) => ({ accessToken: 'ACCESS', account: who }),
    })
    const result = await call(routes, WORKBUDDY_SESSION_ROUTE_PATH, 'GET')
    expect(JSON.parse(result.body)).toEqual({
      ok: true,
      authenticated: true,
      account: { uid: 'uid-2', nickname: '补出来的' },
    })
  })

  it('登了就说清是谁', async () => {
    const { ctx, routes } = rig()
    registerWorkBuddyRoutes(ctx, {
      credentialFile: '/tmp/workbuddy-session-fixture.json',
      readCredential: async () => ({
        accessToken: 'ACCESS',
        account: { uid: 'uid-1', nickname: '某人' },
      }),
    })
    const result = await call(routes, WORKBUDDY_SESSION_ROUTE_PATH, 'GET')
    expect(JSON.parse(result.body)).toEqual({
      ok: true,
      authenticated: true,
      account: { uid: 'uid-1', nickname: '某人' },
    })
    expect(result.body).not.toContain('ACCESS')
  })
})

describe('登录', () => {
  it('给出授权地址，且应答里没有令牌', async () => {
    const { ctx, routes } = rig()
    registerWorkBuddyRoutes(ctx, {
      startLogin: async () => ({ state: 'st-1', url: 'https://www.workbuddy.cn/login?state=st-1' }),
      pollForToken: async () => ({ accessToken: 'ACCESS' }),
      writeCredential: async () => {},
    })
    const result = await call(routes, WORKBUDDY_LOGIN_ROUTE_PATH, 'POST')
    expect(result.status).toBe(200)
    const body = JSON.parse(result.body) as { ok: boolean; url: string }
    expect(body.ok).toBe(true)
    expect(body.url).toBe('https://www.workbuddy.cn/login?state=st-1')
    expect(result.body).not.toContain('ACCESS')
  })

  it('登录没起来时折成 ok:false，不甩 500', async () => {
    const { ctx, routes } = rig()
    registerWorkBuddyRoutes(ctx, {
      startLogin: async () => { throw new Error('站点没给登录地址') },
    })
    const result = await call(routes, WORKBUDDY_LOGIN_ROUTE_PATH, 'POST')
    expect(result.status).toBe(200)
    expect(JSON.parse(result.body)).toEqual({ ok: false, reason: '站点没给登录地址' })
  })

  it('准入被拒时状态码原样、短体固定', async () => {
    const { ctx, routes } = rig({ rejection: 403 })
    apply(ctx)
    const result = await call(routes, WORKBUDDY_SESSION_ROUTE_PATH, 'GET')
    expect(result.status).toBe(403)
    expect(result.body).toBe('forbidden')
  })

  it('方法不对时说清楚', async () => {
    const { ctx, routes } = rig()
    apply(ctx)
    const result = await call(routes, WORKBUDDY_SESSION_ROUTE_PATH, 'POST')
    expect(result.status).toBe(405)
  })
})


describe('每日签到', () => {
  it('GET 给签到状态：今天签没签、连续几天、每天多少积分', async () => {
    const { ctx, routes } = rig()
    registerWorkBuddyRoutes(ctx, {
      checkinStatus: async () => ({
        active: true,
        todayCheckedIn: true,
        streakDays: 13,
        dailyCredit: 100,
        todayCredit: 100,
        isStreakDay: false,
        checkinDates: ['2026-11-05'],
      }),
    })
    const result = await call(routes, WORKBUDDY_CHECKIN_ROUTE_PATH, 'GET')
    expect(result.status).toBe(200)
    const body = JSON.parse(result.body)
    expect(body.ok).toBe(true)
    expect(body.status.todayCheckedIn).toBe(true)
    expect(body.status.streakDays).toBe(13)
    expect(body.status.dailyCredit).toBe(100)
  })

  it('没登录时说的是「需要登录」，不是崩了', async () => {
    const { ctx, routes } = rig()
    registerWorkBuddyRoutes(ctx, {
      checkinStatus: async () => undefined,
    })
    const result = await call(routes, WORKBUDDY_CHECKIN_ROUTE_PATH, 'GET')
    expect(result.status).toBe(200)
    const body = JSON.parse(result.body)
    expect(body.ok).toBe(false)
    expect(String(body.reason)).toContain('登录')
  })

  it('POST 领一次：领到了就说领到多少', async () => {
    const { ctx, routes } = rig()
    registerWorkBuddyRoutes(ctx, {
      claimCheckin: async () => ({ claimed: true, alreadyClaimed: false, credit: 100, streakDays: 14 }),
    })
    const result = await call(routes, WORKBUDDY_CHECKIN_ROUTE_PATH, 'POST')
    const body = JSON.parse(result.body)
    expect(body.ok).toBe(true)
    expect(body.claimed).toBe(true)
    expect(body.credit).toBe(100)
  })

  it('POST 时今天已经领过：说清楚「已经领过了」，不是错误', async () => {
    const { ctx, routes } = rig()
    registerWorkBuddyRoutes(ctx, {
      claimCheckin: async () => ({
        claimed: false,
        alreadyClaimed: true,
        credit: 0,
        streakDays: 13,
        message: '今天已签到，请明天再来',
      }),
    })
    const result = await call(routes, WORKBUDDY_CHECKIN_ROUTE_PATH, 'POST')
    const body = JSON.parse(result.body)
    expect(body.ok).toBe(true)
    expect(body.alreadyClaimed).toBe(true)
    expect(body.message).toBe('今天已签到，请明天再来')
  })

  it('方法不对时说清楚', async () => {
    const { ctx, routes } = rig()
    registerWorkBuddyRoutes(ctx, {})
    const result = await call(routes, WORKBUDDY_CHECKIN_ROUTE_PATH, 'DELETE')
    expect(result.status).toBe(405)
  })

  it('定时器在装载时起，卸载时撤', async () => {
    const started: unknown[] = []
    const stopped: unknown[] = []
    const cleanups: (() => void)[] = []
    const routes: CapturedRoute[] = []
    const ctx = {
      effect(factory: () => unknown) {
        const handle = factory()
        cleanups.push(() => { (handle as (() => void) | undefined)?.() })
        return () => {}
      },
      webServer: {
        register(route: CapturedRoute) {
          routes.push(route)
          return () => {}
        },
      },
      connection: fakeConnection(),
    }
    registerWorkBuddyRoutes(ctx as unknown as WorkBuddyRouteContext, {
      startDaily: (options) => {
        started.push(options)
        return () => { stopped.push(true) }
      },
    })
    expect(started).toHaveLength(1)
    for (const cleanup of cleanups) cleanup()
    expect(stopped).toHaveLength(1)
  })
})
