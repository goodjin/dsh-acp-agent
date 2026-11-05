/**
 * 宿主侧的登录路由。
 *
 * 浏览器只拿得到两样东西：授权地址，和「登了没」。**凭据不经过浏览器**——
 * 令牌留在宿主进程与本机一份 0600 的文件里。
 */

import { describe, expect, it, vi } from 'vitest'
import { LOGIN_PATH, SESSION_PATH, registerQoderRoutes } from '../src/qoder-route.ts'
import type { WorkBuddyRouteContext } from '../src/workbuddy-route.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'

const credential = { accessToken: 'secret-access', refreshToken: 'secret-refresh', machineId: 'machine', expiresAt: Date.now() + 3600_000 }

interface Harness {
  readonly call: (path: string, method: string, authorized?: boolean) => Promise<{ status: number; body: string }>
  readonly poll: ReturnType<typeof vi.fn>
  readonly routes: Map<string, (req: IncomingMessage, res: ServerResponse) => unknown>
  readonly box: { signal?: AbortSignal }
  dispose: () => void
}

function harness(options: { credential?: typeof credential | undefined; poll?: ReturnType<typeof vi.fn> } = {}): Harness {
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => unknown>()
  const box: { signal?: AbortSignal } = {}
  const poll = options.poll ?? vi.fn((_login, opts) => { box.signal = opts.signal; return new Promise<never>(() => {}) })
  let dispose: (() => void) | undefined
  const ctx: WorkBuddyRouteContext = {
    effect: fn => { dispose = fn() as () => void },
    connection: { admit: req => req.headers.cookie ? { peer: {} } : { rejection: 401 } },
    webServer: { register: route => { routes.set(route.path, route.handler); return () => { routes.delete(route.path) } } },
  }
  registerQoderRoutes(ctx, {
    startLogin: () => ({ url: 'https://qoder.com/device/selectAccounts?x=1', nonce: 'n', verifier: 'v', machineId: 'm' }),
    pollForToken: poll,
    readCredential: async () => options.credential ?? credential,
    writeCredential: vi.fn(),
  })
  const call = async (path: string, method: string, authorized = true): Promise<{ status: number; body: string }> => {
    const result = { status: 0, body: '' }
    await routes.get(path)?.({ method, headers: { cookie: authorized ? 'yes' : '' } } as IncomingMessage,
      { writeHead: (status: number) => { result.status = status }, end: (body: string) => { result.body = body } } as unknown as ServerResponse)
    return result
  }
  return { call, poll, routes, box, dispose: () => dispose?.() }
}

describe('Qoder 国际版的登录路由', () => {
  it('未授权的请求被挡在门外', async () => {
    const h = harness()
    expect((await h.call(LOGIN_PATH, 'POST', false)).status).toBe(401)
    expect((await h.call(SESSION_PATH, 'GET', false)).status).toBe(401)
  })

  it('方法不对就是 405', async () => {
    const h = harness()
    expect((await h.call(LOGIN_PATH, 'GET')).status).toBe(405)
    expect((await h.call(SESSION_PATH, 'POST')).status).toBe(405)
  })

  it('状态里只有「登了没」，没有凭据', async () => {
    const h = harness()
    const body = (await h.call(SESSION_PATH, 'GET')).body
    expect(body).not.toContain('secret')
    expect(JSON.parse(body)).toMatchObject({ ok: true, authenticated: true })
  })

  it('同一次登录只发一个授权地址', async () => {
    const h = harness()
    const first = await h.call(LOGIN_PATH, 'POST')
    const second = await h.call(LOGIN_PATH, 'POST')
    expect(first.body).toBe(second.body)
    expect(h.poll).toHaveBeenCalledTimes(1)
    expect(JSON.parse(first.body)).toMatchObject({ ok: true, pending: true })
  })

  it('路由卸掉时中止轮询', () => {
    const h = harness()
    void h.call(LOGIN_PATH, 'POST')
    h.dispose()
    expect(h.box.signal?.aborted).toBe(true)
    expect(h.routes.size).toBe(0)
  })
})
