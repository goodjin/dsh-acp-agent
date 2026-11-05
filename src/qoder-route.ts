/** Host-only login flow; the browser receives status and the PKCE challenge, never credentials. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WorkBuddyRouteContext } from './workbuddy-route.ts'
import { attachAccount, fetchModels, pollForToken, readCredential, startLogin, writeCredential } from './qoder/index.ts'
import { fetchQoderAccount } from './qoder/auth.ts'
import { readSelection, writeSelection } from './model-selection.ts'
import { invalidateQoderCatalog, qoderDeclaredModelIds, qoderDeclaredModels, refreshQoderModels } from './qoder-model.ts'

export const name = 'acp-agent-qoder-login'
export const inject = ['webServer', 'connection']
export const SESSION_PATH = '/acp-agent/qoder-global/session'
export const LOGIN_PATH = '/acp-agent/qoder-global/login'
export const MODELS_PATH = '/acp-agent/qoder-global/models'
export function apply(ctx: WorkBuddyRouteContext): void { registerQoderRoutes(ctx) }
/** 这个入口要的动作（窄接口，测试注入假件）。 */
export interface QoderRouteDeps {
  readonly startLogin: typeof startLogin
  readonly pollForToken: typeof pollForToken
  readonly readCredential: typeof readCredential
  readonly writeCredential: typeof writeCredential
  /** 取整份模型清单。 */
  readonly fetchModels?: typeof fetchModels
  /** 读勾选结果。 */
  readonly readSelection?: () => Promise<readonly string[] | undefined>
  /** 写勾选结果。 */
  readonly writeSelection?: (ids: readonly string[]) => Promise<void>
}

export function registerQoderRoutes(ctx: WorkBuddyRouteContext, deps: QoderRouteDeps = { startLogin, pollForToken, readCredential, writeCredential }): void {
  const selectedIds = deps.readSelection ?? (() => readSelection('qoder'))
  const saveSelection = deps.writeSelection ?? ((ids: readonly string[]) => writeSelection('qoder', ids))
  const listModels = deps.fetchModels ?? fetchModels
  // 清单缓存：拉一次要起 Qoder 的进程（几秒），别每开一次设置就起一遍。
  let cachedModels: { at: number; models: Awaited<ReturnType<typeof listModels>> } | undefined
  const modelsWithin = async (credential: Parameters<typeof listModels>[0]['credential']) => {
    if (cachedModels !== undefined && Date.now() - cachedModels.at < 5 * 60_000) return cachedModels.models
    const models = await listModels({ credential }).catch(() => [])
    if (models.length > 0) cachedModels = { at: Date.now(), models }
    return models
  }
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
            let c = await deps.readCredential()
            const authenticated = !!c && (c.expiresAt === undefined || c.expiresAt > Date.now())
            if (c !== undefined && c.account?.nickname === undefined) {
              const who = await fetchQoderAccount({ accessToken: c.accessToken }).catch(() => undefined)
              if (who !== undefined) c = (await attachAccount(who).catch(() => undefined)) ?? c
            }
            send(res, { ok: true, authenticated, pending: !!pending, reason: failure,
              ...(authenticated ? { account: c?.account } : {}) })
            return
          }
          if (!pending) {
            const login = deps.startLogin(), controller = new AbortController()
            const active = { url: login.url, controller }
            pending = active; failure = undefined
            void deps.pollForToken(login, { signal: controller.signal }).then(async c => {
              if (controller.signal.aborted) return
              await deps.writeCredential(c)
              // 令牌里未必有昵称，补一次——界面上显示昵称比显示一串 uid 像样。
              const who = await fetchQoderAccount({ accessToken: c.accessToken }).catch(() => undefined)
              if (who !== undefined && !controller.signal.aborted) await attachAccount(who).catch(() => undefined)
            }).catch(() => { if (!controller.signal.aborted) failure = 'Qoder 登录未完成或失败，请重试' })
              .finally(() => { if (pending === active) pending = undefined })
          }
          send(res, { ok: true, pending: true, url: pending.url })
        } catch { send(res, { ok: false, reason: 'Qoder 账号操作失败，请重试' }) }
      },
    }))
    const modelsRoute = ctx.webServer.register({
      kind: 'exact', path: MODELS_PATH,
      async handler(req, res) {
        const admission = ctx.connection.admit(req)
        if ('rejection' in admission) { res.writeHead(admission.rejection); res.end('unauthorized'); return }
        try {
          if (req.method === 'GET') {
            const credential = await deps.readCredential()
            const fetched = credential === undefined ? [] : await modelsWithin(credential)
            // 站点的整份清单要 Qoder 自己的签名才拿得到；拿不到就用声明的那份，
            // 空着对用户没用。
            const models = fetched.length > 0 ? fetched : qoderDeclaredModels()
            const stored = await selectedIds().catch(() => undefined)
            send(res, {
              ok: true,
              models: models.map(model => ({
                id: model.id,
                name: model.name,
                ...(model.description === undefined ? {} : { description: model.description }),
                ...(model.efforts === undefined ? {} : { efforts: [...model.efforts] }),
                ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
                ...(model.credits === undefined ? {} : { credits: model.credits }),
              })),
              selected: [...(stored ?? qoderDeclaredModelIds())],
              custom: stored !== undefined,
              default: [...qoderDeclaredModelIds()],
            })
            return
          }
          if (req.method === 'POST') {
            const ids = await readIds(req)
            await saveSelection(ids)
            // 勾完立刻重发清单：选择器下一次打开就是新的那份。
            invalidateQoderCatalog()
            await refreshQoderModels().catch(() => undefined)
            send(res, { ok: true, selected: ids })
            return
          }
          res.writeHead(405, { Allow: 'GET, POST' }); res.end('method not allowed')
        } catch { send(res, { ok: false, reason: 'Qoder 模型清单操作失败，请重试' }) }
      },
    })
    return () => { pending?.controller.abort(); for (const dispose of routes) dispose?.(); modelsRoute?.() }
  }, 'qoder-global login routes')
}

/** 读请求体里的勾选结果。 */
async function readIds(req: IncomingMessage): Promise<string[]> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array))
  const text = Buffer.concat(chunks).toString('utf8')
  if (text === '') return []
  try {
    const parsed = JSON.parse(text) as unknown
    if (typeof parsed !== 'object' || parsed === null) return []
    const ids = (parsed as Record<string, unknown>)['ids']
    if (!Array.isArray(ids)) return []
    return ids.filter((id): id is string => typeof id === 'string' && id !== '')
  } catch {
    return []
  }
}

// 重新加载

// 重新加载
