/**
 * 刷新路由：准入、方法、并发锁、未挂载提供方与失败折答。
 *
 * 应答全部是 200 + JSON（ok:false 带原因），浏览器据它折文案；准入照配额路由
 * 的写法（无 cookie 401，Host 不可信 403，拒绝时状态码原样）。并发锁的判据是
 * 硬的：同一提供方第二个请求在第一个完成前到达，必须得到 busy，刷新器只被调
 * 一次——不会起第二个探针进程。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { apply, MODEL_REFRESH_ROUTE_PATH, notMountedOutcome, registerModelRefreshRoute } from '../src/model-refresh-route.ts'
import type { ModelRefreshContext, ModelRefreshRouteDeps } from '../src/model-refresh-route.ts'
import type { ModelRefreshOutcome } from '../src/model-refresh.ts'

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
interface CapturedRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: RouteHandler
}

/** fake connection：照官方 admit 的分支语义。 */
function fakeConnection() {
  const connection = {
    admit(request: { headers?: Record<string, string> }) {
      if ((request.headers?.['cookie'] ?? '') !== 'dsh-session=good') {
        return { rejection: 401 as const }
      }
      return { peer: { role: 'operator' } }
    },
  }
  return { connection }
}

/** 最小宿主面：effect 立即执行，webServer.register 捕获路由。 */
function rig(refresherOf?: ModelRefreshRouteDeps['refresherOf']) {
  const routes: CapturedRoute[] = []
  const admit = fakeConnection()
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
    connection: admit.connection,
  } as unknown as ModelRefreshContext
  registerModelRefreshRoute(ctx, refresherOf === undefined ? {} : { refresherOf })
  return { route: routes[0] }
}

/** POST 进来一次，收回应答的状态码与原始体（JSON 由断言处按需解析）。 */
async function callRoute(
  route: CapturedRoute | undefined,
  init: { method?: string; cookie?: string; body?: string } = {},
): Promise<{ status: number; text: string; body?: unknown }> {
  if (route === undefined) throw new Error('route was not registered')
  const req = {
    method: init.method ?? 'POST',
    headers: { host: '127.0.0.1', ...(init.cookie === undefined ? {} : { cookie: init.cookie }) },
  } as unknown as IncomingMessage
  const res: { statusCode: number; body: string; writeHead(status: number, head?: Record<string, string>): unknown; end(text?: string): unknown } = {
    statusCode: 0,
    body: '',
    writeHead(status) {
      this.statusCode = status
      return this
    },
    end(text) {
      this.body = text ?? ''
      return this
    },
  }
  // 模拟请求体：async iterator 逐块给出。
  const bodyText = init.body ?? JSON.stringify({ preset: 'acp-grok' })
  const chunksBody = [Buffer.from(bodyText)]
  ;(req as unknown as { [Symbol.asyncIterator](): AsyncIterator<Buffer> })[Symbol.asyncIterator] = async function* () {
    while (chunksBody.length > 0) {
      const next = chunksBody.shift()
      if (next !== undefined) yield next
    }
  }
  await route.handler(req, res as unknown as ServerResponse)
  let body: unknown
  try {
    body = JSON.parse(res.body) as unknown
  } catch {
    body = undefined
  }
  return { status: res.statusCode, text: res.body, body }
}

/** 一个记账的假刷新器。 */
function refresherOfOf(table: Record<string, () => Promise<ModelRefreshOutcome>>): ModelRefreshRouteDeps['refresherOf'] {
  return presetId => table[presetId]
}

describe('刷新路由（/acp-agent/models/refresh）', () => {
  it('路径与挂法：exact 路由注册在 effect 里', () => {
    const { route } = rig()
    expect(route?.kind).toBe('exact')
    expect(route?.path).toBe(MODEL_REFRESH_ROUTE_PATH)
  })

  it('POST 转给登记的刷新器，应答原样回 JSON', async () => {
    const { route } = rig(refresherOfOf({
      'acp-zcode': async () => ({ ok: true, kind: 'upstream', agent: 'zcode', total: 13, added: 10, familyWindow: 6, unverifiedWindow: 4 }),
    }))
    const answer = await callRoute(route, { cookie: 'dsh-session=good', body: JSON.stringify({ preset: 'acp-zcode' }) })
    expect(answer.status).toBe(200)
    expect(answer.body).toEqual({ ok: true, kind: 'upstream', agent: 'zcode', total: 13, added: 10, familyWindow: 6, unverifiedWindow: 4 })
  })

  it('codex 的「已重读」附去 dsh-codex 设置段的提示', async () => {
    const { route } = rig(refresherOfOf({
      'acp-codex': async () => ({ ok: true, kind: 'reread', agent: 'codex' }),
    }))
    const answer = await callRoute(route, { cookie: 'dsh-session=good', body: JSON.stringify({ preset: 'acp-codex' }) })
    expect(answer.body).toEqual({ ok: true, kind: 'reread', agent: 'codex', hint: 'codex' })
  })

  it('其它提供方的「已重读」不带提示', async () => {
    const { route } = rig(refresherOfOf({
      'acp-claude': async () => ({ ok: true, kind: 'reread', agent: 'claude' }),
    }))
    const answer = await callRoute(route, { cookie: 'dsh-session=good', body: JSON.stringify({ preset: 'acp-claude' }) })
    expect(answer.body).toEqual({ ok: true, kind: 'reread', agent: 'claude' })
  })

  it('别的插件挂的 provider 回结构化 not-ours，不透内部腔', async () => {
    const { route } = rig(refresherOfOf({}))
    const answer = await callRoute(route, { cookie: 'dsh-session=good' })
    expect(answer.status).toBe(200)
    expect(answer.body).toEqual({
      ok: false,
      code: 'not-ours',
      error: 'acp-grok is mounted by another plugin — refresh it from that plugin\'s settings section',
    })
  })

  it('codex-global / qoder-global 按后缀指路到对应插件的设置段', async () => {
    const codex = notMountedOutcome('acp-codex-global')
    expect(codex).toMatchObject({ ok: false, code: 'not-ours', hint: 'codex' })
    const qoder = notMountedOutcome('acp-qoder-global')
    expect(qoder).toMatchObject({ ok: false, code: 'not-ours', hint: 'qoder' })
    const unknown = notMountedOutcome('deepseek-account')
    expect(unknown).toMatchObject({ ok: false, code: 'not-ours' })
    expect((unknown as { hint?: string }).hint).toBeUndefined()
  })

  it('缺 preset 字段折成 ok:false', async () => {
    const { route } = rig(refresherOfOf({}))
    const answer = await callRoute(route, { cookie: 'dsh-session=good', body: JSON.stringify({}) })
    expect((answer.body as { ok: boolean }).ok).toBe(false)
    expect((answer.body as { error: string }).error).toContain('missing provider preset id')
  })

  it('刷新器抛错折成 ok:false + 原因', async () => {
    const { route } = rig(refresherOfOf({
      'acp-grok': async () => { throw new Error('grok model probe did not answer within 60000ms') },
    }))
    const answer = await callRoute(route, { cookie: 'dsh-session=good' })
    expect(answer.status).toBe(200)
    expect((answer.body as { ok: boolean }).ok).toBe(false)
    expect((answer.body as { error: string }).error).toContain('did not answer')
  })

  it('并发锁：进行中的同一提供方第二个请求得 busy，刷新器只跑一次', async () => {
    let release: (() => void) | undefined
    let runs = 0
    const gate = new Promise<void>(resolve => { release = resolve })
    const { route } = rig(refresherOfOf({
      'acp-grok': async () => {
        runs += 1
        await gate
        return { ok: true, kind: 'reread', agent: 'grok' }
      },
    }))
    const first = callRoute(route, { cookie: 'dsh-session=good' })
    await new Promise(resolve => setTimeout(resolve, 0))
    const second = await callRoute(route, { cookie: 'dsh-session=good' })
    expect((second.body as { code?: string }).code).toBe('busy')
    expect(runs).toBe(1)
    release?.()
    const firstAnswer = await first
    expect((firstAnswer.body as { ok: boolean }).ok).toBe(true)
    // 完成后锁释放：再来一次照常执行（runs 变 2）。
    const third = await callRoute(route, { cookie: 'dsh-session=good' })
    expect((third.body as { ok: boolean }).ok).toBe(true)
    expect(runs).toBe(2)
  })

  it('不同提供方互不挡：各自并发各跑各的', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    const runs: string[] = []
    const { route } = rig(refresherOfOf({
      'acp-grok': async () => { runs.push('grok'); await gate; return { ok: true, kind: 'reread', agent: 'grok' } },
      'acp-zcode': async () => ({ ok: true, kind: 'reread', agent: 'zcode' }),
    }))
    const blocked = callRoute(route, { cookie: 'dsh-session=good', body: JSON.stringify({ preset: 'acp-grok' }) })
    await new Promise(resolve => setTimeout(resolve, 0))
    const other = await callRoute(route, { cookie: 'dsh-session=good', body: JSON.stringify({ preset: 'acp-zcode' }) })
    expect((other.body as { ok: boolean }).ok).toBe(true)
    expect((other.body as { code?: string }).code).toBeUndefined()
    release?.()
    await blocked
    expect(runs).toEqual(['grok'])
  })

  it('GET 405；无凭据 401——照官方 /api 的分支语义（短体固定）', async () => {
    const { route } = rig(refresherOfOf({}))
    const get = await callRoute(route, { method: 'GET', cookie: 'dsh-session=good', body: '' })
    expect(get.status).toBe(405)
    expect(get.text).toBe('method not allowed')
    const noCookie = await callRoute(route, { cookie: 'nope' })
    expect(noCookie.status).toBe(401)
    expect(noCookie.text).toBe('unauthorized')
  })

  it('apply 入口也能装（与其它路由行同款）', () => {
    const routes: CapturedRoute[] = []
    const ctx = {
      effect(factory: () => unknown) { factory(); return () => {} },
      webServer: { register(route: CapturedRoute) { routes.push(route); return () => {} } },
      connection: fakeConnection().connection,
    } as unknown as ModelRefreshContext
    apply(ctx)
    expect(routes[0]?.path).toBe(MODEL_REFRESH_ROUTE_PATH)
  })
})
