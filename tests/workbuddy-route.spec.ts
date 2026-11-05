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
  WORKBUDDY_LOGIN_ROUTE_PATH,
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
  options: { rejection?: number } = {},
): Promise<Call> {
  const route = routes.find(candidate => candidate.path === path)
  if (route === undefined) throw new Error(`no route for ${path}`)
  const calls: Call[] = []
  const req = { method, headers: { cookie: 'dsh-session=good' } } as unknown as IncomingMessage
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

describe('路由', () => {
  it('两条路由挂在约定的路径上', () => {
    const { ctx, routes } = rig()
    registerWorkBuddyRoutes(ctx)
    expect(routes.map(route => route.path).sort()).toEqual([
      WORKBUDDY_LOGIN_ROUTE_PATH,
      WORKBUDDY_SESSION_ROUTE_PATH,
    ].sort())
  })

  it('宿主按 apply(ctx, config) 调用时挂的也是这两条', () => {
    // 宿主把插件配置当第二个参数传进来；注入面不能占这个位置，
    // 否则配置里的字段会被当成注入面读。
    const { ctx, routes } = rig()
    apply(ctx, { startLogin: async () => ({ state: 'x', url: 'https://x.example' }) })
    expect(routes.map(route => route.path).sort()).toEqual([
      WORKBUDDY_LOGIN_ROUTE_PATH,
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
