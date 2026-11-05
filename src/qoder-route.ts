/** Host-only login flow; the browser receives status and the PKCE challenge, never credentials. */
import type { ServerResponse } from 'node:http'
import type { WorkBuddyRouteContext } from './workbuddy-route.ts'
import { pollForToken, readCredential, startLogin, writeCredential } from './qoder/index.ts'

export const name = 'acp-agent-qoder-login'
export const inject = ['webServer', 'connection']
export const SESSION_PATH = '/acp-agent/qoder-global/session'
export const LOGIN_PATH = '/acp-agent/qoder-global/login'
export function apply(ctx: WorkBuddyRouteContext): void { registerQoderRoutes(ctx) }
export function registerQoderRoutes(ctx: WorkBuddyRouteContext, deps = { startLogin, pollForToken, readCredential, writeCredential }): void {
  ctx.effect(() => {
    let pending: { url: string; controller: AbortController } | undefined
    let failure: string | undefined
    const send = (res: ServerResponse, value: unknown) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(value))
    }
    const routes = [SESSION_PATH, LOGIN_PATH].map(path => ctx.webServer.register({
      kind: 'exact', path,
      async handler(req, res) {
        const admission = ctx.connection.admit(req)
        if ('rejection' in admission) { res.writeHead(admission.rejection); res.end('unauthorized'); return }
        const method = path === SESSION_PATH ? 'GET' : 'POST'
        if (req.method !== method) { res.writeHead(405, { Allow: method }); res.end('method not allowed'); return }
        try {
          if (path === SESSION_PATH) {
            const c = await deps.readCredential()
            const authenticated = !!c && (c.expiresAt === undefined || c.expiresAt > Date.now())
            send(res, { ok: true, authenticated, pending: !!pending, reason: failure,
              ...(authenticated ? { account: c?.account } : {}) })
            return
          }
          if (!pending) {
            const login = deps.startLogin(), controller = new AbortController()
            const active = { url: login.url, controller }
            pending = active; failure = undefined
            void deps.pollForToken(login, { signal: controller.signal }).then(async c => {
              if (!controller.signal.aborted) await deps.writeCredential(c)
            }).catch(() => { if (!controller.signal.aborted) failure = 'Qoder 登录未完成或失败，请重试' })
              .finally(() => { if (pending === active) pending = undefined })
          }
          send(res, { ok: true, pending: true, url: pending.url })
        } catch { send(res, { ok: false, reason: 'Qoder 账号操作失败，请重试' }) }
      },
    }))
    return () => { pending?.controller.abort(); for (const dispose of routes) dispose?.() }
  }, 'qoder-global login routes')
}
