/**
 * 委派回调路由：外部 agent 的委派调用经桥接进程打到这里。
 *
 * 链路：外部 agent 的 delegate 工具 → bridge/dsh-acp-mcp-bridge.mjs（stdio MCP）
 * → POST /acp-agent/delegation（本路由）→ 宿主服务 superpowers.delegation。
 *
 * 鉴权是本路由自己的令牌（请求头 x-dsh-delegation-token 与行配置 config.token
 * 逐字比），不碰 connection.admit——来回调的是本机子进程，没有浏览器 cookie，
 * admit 会一律 401。测试里的假 connection 因此把 admit 造成「谁问谁 401」，
 * 实现若误用了它，裸请求那条就会红。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { apply, DELEGATION_ROUTE_PATH } from '../src/delegation-route.ts'
import type { DelegationRouteContext } from '../src/delegation-route.ts'
import { DELEGATION_SERVICE } from '../src/delegation-contract.ts'
import type { DelegationResult } from '../src/delegation-contract.ts'

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
interface CapturedRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: RouteHandler
}

/** 行配置里的令牌（唯一来源；测试里桥接进程侧与路由侧共用它）。 */
const TOKEN = 'spec-delegation-token-6f2a'
/** 请求头名（小写：node 把头名归一成小写）。 */
const TOKEN_HEADER = 'x-dsh-delegation-token'

const SESSION_ID = 'session-parent-1'
/** 一份合法的委派请求（带技能名的完整形状）。 */
const REQUEST = {
  sessionId: SESSION_ID,
  skill: 'brainstorming',
  task: '调研缓存行为',
  brief: '把 zcode 配额路由的缓存行为查清楚并回报。',
}
/** 委派服务的标准答案（与 DelegationResult 同形）。 */
const RESULT: DelegationResult = { output: '已查明：30 秒 TTL，命中不打上游。', model: 'glm-5.3', childId: 'child-7' }

/** 委派服务替身：记下每次请求；行为可换（默认回标准答案）。 */
function fakeService(behavior: (request: unknown) => Promise<unknown> = () => Promise.resolve(RESULT)) {
  const calls: unknown[] = []
  return {
    calls,
    service: {
      delegate(request: unknown) {
        calls.push(request)
        return behavior(request)
      },
    },
  }
}

/**
 * 最小宿主面：effect 立即执行、webServer.register 捕获路由、get 只答委派服务。
 * 假 connection 的 admit 谁问谁 401——它是「不该被碰」的探针，不是放行器。
 */
function rig(options: { service?: unknown; token?: string } = {}) {
  const routes: CapturedRoute[] = []
  const admitCalls: unknown[] = []
  const connection = {
    admit(request: unknown) {
      admitCalls.push(request)
      return { rejection: 401 as const }
    },
  }
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
    get(name: string) {
      return name === DELEGATION_SERVICE ? options.service : undefined
    },
    connection,
  } as unknown as DelegationRouteContext
  apply(ctx, { token: options.token ?? TOKEN })
  return { ctx, routes, admitCalls }
}

/** 请进来一次的请求，收回应答的状态码、头与体（JSON 能解析就解析）。 */
async function callRoute(
  route: CapturedRoute | undefined,
  init: {
    method?: string
    /** 令牌头：缺省带对的令牌；false 表示整个头都不带 */
    token?: string | false
    /** 请求体：缺省是合法的完整请求；false 表示零字节的空体 */
    body?: string | false
  } = {},
): Promise<{ status: number; headers: Record<string, string | string[] | number | undefined>; body: unknown; bodyText: string }> {
  if (route === undefined) throw new Error('route was not registered')
  const body = init.body === undefined ? JSON.stringify(REQUEST) : init.body
  const headers: Record<string, string> = init.token === false ? {} : { [TOKEN_HEADER]: init.token ?? TOKEN }
  const req = {
    method: init.method ?? 'POST',
    headers,
    async *[Symbol.asyncIterator]() {
      if (body !== false) yield body
    },
  } as unknown as IncomingMessage
  const captured: Record<string, string | string[] | number | undefined> = {}
  const res = {
    writeHead(status: number, head?: Record<string, unknown>) {
      captured['#status'] = status
      for (const [key, value] of Object.entries(head ?? {})) captured[key] = value as string
    },
    end(chunk?: unknown) {
      captured['#body'] = typeof chunk === 'string' ? chunk : String(chunk ?? '')
    },
  } as unknown as ServerResponse
  await route.handler(req, res)
  const bodyText = captured['#body'] as string
  delete captured['#body']
  let parsed: unknown = bodyText
  if (bodyText !== '') {
    try {
      parsed = JSON.parse(bodyText)
    } catch {
      parsed = bodyText
    }
  }
  return { status: captured['#status'] as number, headers: captured, body: parsed, bodyText }
}

describe('apply（wiring 层）', () => {
  it('注册一条 exact 的 /acp-agent/delegation 路由', () => {
    const { routes } = rig()
    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({ kind: 'exact', path: DELEGATION_ROUTE_PATH })
    expect(DELEGATION_ROUTE_PATH).toBe('/acp-agent/delegation')
  })
})

describe('委派回调（行为层）', () => {
  it('令牌正确且委派服务在场：200 应答服务的结果 JSON，请求四字段原样透传', async () => {
    const fake = fakeService()
    const { routes } = rig({ service: fake.service })
    const answer = await callRoute(routes[0])
    expect(answer.status).toBe(200)
    expect(answer.headers['content-type']).toBe('application/json')
    expect(answer.body).toEqual(RESULT)
    expect(fake.calls).toEqual([REQUEST])
  })

  it('令牌缺失或与配置不符：401，短体固定，不碰委派服务', async () => {
    const fake = fakeService()
    const { routes } = rig({ service: fake.service })
    expect(await callRoute(routes[0], { token: false })).toMatchObject({ status: 401, body: 'unauthorized' })
    expect(await callRoute(routes[0], { token: 'wrong-token' })).toMatchObject({ status: 401, body: 'unauthorized' })
    expect(fake.calls).toHaveLength(0)
  })

  it('行配置里没有令牌时拒绝一切回调（fail closed），带对令牌也不放行', async () => {
    const fake = fakeService()
    const { routes } = rig({ service: fake.service, token: '' })
    expect(await callRoute(routes[0])).toMatchObject({ status: 401, body: 'unauthorized' })
    expect(fake.calls).toHaveLength(0)
  })

  it('body 缺 sessionId/task/brief、不是 JSON 或是空体：一律 400，不碰委派服务', async () => {
    const fake = fakeService()
    const { routes } = rig({ service: fake.service })
    const badBodies: (string | false)[] = [
      JSON.stringify({ sessionId: SESSION_ID, brief: '有 brief 没 task' }),
      JSON.stringify({ task: '有 task 没 sessionId', brief: 'brief 在' }),
      JSON.stringify({ sessionId: SESSION_ID, task: '有 task 没 brief' }),
      'not-json-at-all',
      false,
    ]
    for (const body of badBodies) {
      const answer = await callRoute(routes[0], { body })
      expect(answer.status, `body=${String(body)} 应回 400`).toBe(400)
      expect(String(answer.body)).not.toContain('output')
    }
    expect(fake.calls).toHaveLength(0)
  })

  it('委派服务缺席（get 取不到）：503，body 说明委派服务不可用', async () => {
    const { routes } = rig()
    const answer = await callRoute(routes[0])
    expect(answer.status).toBe(503)
    expect(answer.bodyText).toContain('委派服务不可用')
  })

  it('委派服务抛错：500，body 带错误文本，但绝不含令牌', async () => {
    const fake = fakeService(() => Promise.reject(new Error(`起子代理失败（凭据 ${TOKEN} 被上游拒绝）`)))
    const { routes } = rig({ service: fake.service })
    const answer = await callRoute(routes[0])
    expect(answer.status).toBe(500)
    expect(answer.bodyText).toContain('起子代理失败')
    expect(answer.bodyText).not.toContain(TOKEN)
  })

  it('同一 (sessionId, task) 第二次请求吃缓存：服务只被叫一次，body 仍是第一次的结果', async () => {
    const fake = fakeService()
    const { routes } = rig({ service: fake.service })
    const first = await callRoute(routes[0])
    const second = await callRoute(routes[0])
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(second.body).toEqual(RESULT)
    expect(fake.calls).toHaveLength(1)
  })

  it('缓存按 (sessionId, task) 区分：换 task 或换 sessionId 都会再调服务；没给 skill 就不透传 skill', async () => {
    const fake = fakeService()
    const { routes } = rig({ service: fake.service })
    await callRoute(routes[0], { body: JSON.stringify({ sessionId: SESSION_ID, task: '任务甲', brief: 'brief 甲' }) })
    await callRoute(routes[0], { body: JSON.stringify({ sessionId: SESSION_ID, task: '任务乙', brief: 'brief 乙' }) })
    await callRoute(routes[0], { body: JSON.stringify({ sessionId: 'session-parent-2', task: '任务甲', brief: 'brief 甲' }) })
    expect(fake.calls).toHaveLength(3)
    expect('skill' in (fake.calls[0] as object)).toBe(false)
  })

  it('失败的委派不写缓存：第一次抛错后，第二次请求会再调服务并拿到结果', async () => {
    let fail = true
    const fake = fakeService(() => (fail ? Promise.reject(new Error('第一次失败')) : Promise.resolve(RESULT)))
    const { routes } = rig({ service: fake.service })
    const first = await callRoute(routes[0])
    fail = false
    const second = await callRoute(routes[0])
    expect(first.status).toBe(500)
    expect(second.status).toBe(200)
    expect(second.body).toEqual(RESULT)
    expect(fake.calls).toHaveLength(2)
  })

  it('裸请求（无 cookie、无 Authorization）凭令牌放行到 200，全程不碰 connection.admit', async () => {
    const fake = fakeService()
    const { routes, admitCalls } = rig({ service: fake.service })
    // 模拟桥接进程：只有令牌头，没有任何浏览器凭据。若误用 admit，这里会是 401。
    const answer = await callRoute(routes[0])
    expect(answer.status).toBe(200)
    expect(answer.body).toEqual(RESULT)
    expect(admitCalls).toHaveLength(0)
  })

  it('非 POST 一律 405，并说明只允许 POST', async () => {
    const fake = fakeService()
    const { routes } = rig({ service: fake.service })
    const answer = await callRoute(routes[0], { method: 'GET' })
    expect(answer.status).toBe(405)
    expect(answer.headers['allow']).toBe('POST')
    expect(fake.calls).toHaveLength(0)
  })

  it('服务回了不认识的形状：500（不把垃圾当结果），且不写缓存', async () => {
    let garbage = true
    const fake = fakeService(() => (garbage ? Promise.resolve({ output: 1 }) : Promise.resolve(RESULT)))
    const { routes } = rig({ service: fake.service })
    const first = await callRoute(routes[0])
    garbage = false
    const second = await callRoute(routes[0])
    expect(first.status).toBe(500)
    expect(second.status).toBe(200)
    expect(fake.calls).toHaveLength(2)
  })
})
