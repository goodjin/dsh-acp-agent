/**
 * WorkBuddy 的登录与状态接口（宿主侧）。
 *
 * 浏览器要能问「登了没」，也要能拿到一个能点开的授权地址——这两件事都在宿主这
 * 一侧做，因为令牌不能进浏览器：
 * - `GET /acp-agent/workbuddy/session` → 登了没、是谁；
 * - `POST /acp-agent/workbuddy/login` → 开始一次登录，返回授权地址。
 *
 * 登录的轮询在宿主这边跑（用户点完授权页，站点把令牌绑在 state 上，宿主轮询到
 * 就落盘）。应答里只有状态与地址，永远没有令牌。
 *
 * 准入照官方 /api 的写法：先 admit 后应答，拒绝时状态码原样、短体固定。取数失败
 * 折成 200 + ok:false + 原因，不甩 500——界面上要能显示「去登录」，不是「崩了」。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { fetchAccount, pollForToken, startLogin } from './workbuddy/auth.ts'
import type { WorkBuddyAccount, WorkBuddyCredential, WorkBuddyLoginStart } from './workbuddy/auth.ts'
import { attachAccount, credentialFilePath, readStoredCredential, writeStoredCredential } from './workbuddy/credential.ts'
import { loadCatalog } from './workbuddy/models.ts'
import { readSelection, writeSelection } from './workbuddy/selection.ts'
import { resolveEndpoints } from './workbuddy/endpoints.ts'
import { ensureWorkBuddyModels, invalidateWorkBuddyCatalog, workBuddyDeclaredModelIds } from './workbuddy-model.ts'

export const name = 'acp-agent-workbuddy-login'

/** webServer 挂路由；connection 做准入（admit）。 */
export const inject = ['webServer', 'connection']

/** 登录状态。 */
export const WORKBUDDY_SESSION_ROUTE_PATH = '/acp-agent/workbuddy/session'

/** 开始登录。 */
export const WORKBUDDY_LOGIN_ROUTE_PATH = '/acp-agent/workbuddy/login'

/** 模型清单与勾选。 */
export const WORKBUDDY_MODELS_ROUTE_PATH = '/acp-agent/workbuddy/models'

/** 这个入口需要的宿主面（窄接口，测试立桩照这个来）。 */
export interface WorkBuddyRouteContext {
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

/** 可替换的外部动作（测试注入假件）。 */
export interface WorkBuddyRouteDeps {
  /** 凭据文件；缺省是 DSH 目录下的那个。 */
  readonly credentialFile?: string | undefined
  /** 要 state 与授权地址。 */
  readonly startLogin?: (() => Promise<WorkBuddyLoginStart>) | undefined
  /** 轮询令牌。 */
  readonly pollForToken?: ((state: string) => Promise<WorkBuddyCredential>) | undefined
  /** 读存着的凭据。 */
  readonly readCredential?: (() => Promise<WorkBuddyCredential | undefined>) | undefined
  /** 把拿到的凭据写下来。 */
  readonly writeCredential?: ((credential: WorkBuddyCredential) => Promise<void>) | undefined
  /** 补账户信息（uid、昵称）。 */
  readonly fetchAccount?: ((accessToken: string) => Promise<WorkBuddyAccount | undefined>) | undefined
  /** 把账户信息写回凭据文件。 */
  readonly attachAccount?: ((account: WorkBuddyAccount) => Promise<WorkBuddyCredential | undefined>) | undefined
  /** 刷新模型清单（登录后选择器要马上看到真实清单）。 */
  readonly ensureModels?: (() => Promise<void>) | undefined
  /** 取整份清单（设置里那个列表要全部的模型，不只是勾了的）。 */
  readonly loadCatalog?: (() => Promise<readonly { id: string; name: string; description?: string | undefined; credits?: string | undefined; supportsToolCall?: boolean | undefined }[]>) | undefined
  /** 读勾选结果。 */
  readonly readSelection?: (() => Promise<readonly string[] | undefined>) | undefined
  /** 写勾选结果。 */
  readonly writeSelection?: ((ids: readonly string[]) => Promise<void>) | undefined
}

/**
 * 装载入口：挂上那两条 exact 路由。
 *
 * 宿主按 `apply(ctx, config)` 调用，第二个参数是**插件配置**，不是注入面——所以
 * 注入面另起一个名字（{@link registerWorkBuddyRoutes}），免得配置里的字段被当成
 * 注入面读。这一行不读配置，签名里留着它只是为了与宿主的调用方式一致。
 * @param ctx - 宿主上下文（effect / webServer / connection）。
 * @param _config - 宿主传进来的插件配置；这一行不用它。
 */
export function apply(ctx: WorkBuddyRouteContext, _config?: unknown): void {
  registerWorkBuddyRoutes(ctx)
}

/**
 * 挂上那两条 exact 路由。
 * @param ctx - 宿主上下文（effect / webServer / connection）。
 * @param deps - 可选注入面；缺省走真实的登录与凭据。
 */
export function registerWorkBuddyRoutes(ctx: WorkBuddyRouteContext, deps: WorkBuddyRouteDeps = {}): void {
  const file = deps.credentialFile ?? credentialFilePath()
  const beginLogin = deps.startLogin ?? (() => startLogin())
  const poll = deps.pollForToken ?? ((state: string) => pollForToken({ state }))
  const read = deps.readCredential ?? (() => readStoredCredential(file))
  const write = deps.writeCredential ?? ((credential: WorkBuddyCredential) => writeStoredCredential(credential, file))
  // 名字别叫 account：会话处理器里有一个同名的局部变量会把它盖住。
  const loadAccount = deps.fetchAccount ?? (async (accessToken: string) => {
    const endpoints = resolveEndpoints()
    return fetchAccount({ accessToken, endpoints }).catch(() => undefined)
  })
  const refreshModels = deps.ensureModels ?? (() => ensureWorkBuddyModels())
  const catalog = deps.loadCatalog ?? (async () => {
    const credential = await read().catch(() => undefined)
    if (credential === undefined) return []
    const loaded = await loadCatalog({ credential }).catch(() => undefined)
    return loaded?.models ?? []
  })
  const selectedIds = deps.readSelection ?? (() => readSelection(file))
  const saveSelection = deps.writeSelection ?? ((ids: readonly string[]) => writeSelection(ids, file))
  const saveAccount = deps.attachAccount ?? ((who: WorkBuddyAccount) => attachAccount(who, file))

  ctx.effect(() => {
    ctx.webServer.register({
      kind: 'exact',
      path: WORKBUDDY_SESSION_ROUTE_PATH,
      async handler(req, res) {
        if (!admit(ctx, req, res)) return
        if (req.method !== 'GET') {
          res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET' })
          res.end('method not allowed')
          return
        }
        try {
          const credential = await read()
          if (credential === undefined) {
            respondJson(res, 200, JSON.stringify({ ok: true, authenticated: false, needsLogin: true }))
            return
          }
          // 令牌里没有账户信息时补一次（界面上要显示是谁）。
          if (credential.account === undefined) {
            const who = await loadAccount(credential.accessToken).catch(() => undefined)
            if (who !== undefined) {
              const attached = await saveAccount(who).catch(() => undefined)
              if (attached !== undefined) {
                respondJson(res, 200, JSON.stringify({
                  ok: true,
                  authenticated: true,
                  account: { uid: who.uid, ...(who.nickname === undefined ? {} : { nickname: who.nickname }) },
                }))
                return
              }
            }
          }
          const account = credential.account
          respondJson(res, 200, JSON.stringify({
            ok: true,
            authenticated: true,
            ...(account === undefined ? {} : { account: { uid: account.uid, ...(account.nickname === undefined ? {} : { nickname: account.nickname }) } }),
          }))
        } catch (error) {
          respondJson(res, 200, JSON.stringify({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }))
        }
      },
    })
  }, 'acp-agent-workbuddy-login: session route')

  ctx.effect(() => {
    ctx.webServer.register({
      kind: 'exact',
      path: WORKBUDDY_MODELS_ROUTE_PATH,
      async handler(req, res) {
        if (!admit(ctx, req, res)) return
        if (req.method === 'GET') {
          try {
            const models = await catalog()
            const stored = await selectedIds().catch(() => undefined)
            // 没自己勾过时，生效的是挂载行里声明的那一份——界面照它显示勾选状态。
            const selected = stored ?? workBuddyDeclaredModelIds()
            respondJson(res, 200, JSON.stringify({
              ok: true,
              models: models.map(model => ({
                id: model.id,
                name: model.name,
                ...(model.description === undefined ? {} : { description: model.description }),
                ...(model.credits === undefined ? {} : { credits: model.credits }),
                ...(model.supportsToolCall === undefined ? {} : { supportsToolCall: model.supportsToolCall }),
              })),
              selected: [...selected],
              // 自己勾过没有：界面据此显示「已自定义」并给一个「恢复默认」。
              custom: stored !== undefined,
              // 默认那一份（挂载行里声明的）：界面上「恢复默认」按它存。
              default: [...workBuddyDeclaredModelIds()],
            }))
          } catch (error) {
            respondJson(res, 200, JSON.stringify({
              ok: false,
              reason: error instanceof Error ? error.message : String(error),
            }))
          }
          return
        }
        if (req.method === 'POST') {
          try {
            const body = await readJsonBody(req)
            const ids = Array.isArray(body?.['ids'])
              ? body['ids'].filter((id): id is string => typeof id === 'string' && id !== '')
              : []
            await saveSelection(ids)
            // 勾完立刻重发清单：选择器下一次打开就是新的那份。
            invalidateWorkBuddyCatalog()
            await refreshModels().catch(() => undefined)
            respondJson(res, 200, JSON.stringify({ ok: true, selected: ids }))
          } catch (error) {
            respondJson(res, 200, JSON.stringify({
              ok: false,
              reason: error instanceof Error ? error.message : String(error),
            }))
          }
          return
        }
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, POST' })
        res.end('method not allowed')
      },
    })
  }, 'acp-agent-workbuddy-login: models route')

  ctx.effect(() => {
    ctx.webServer.register({
      kind: 'exact',
      path: WORKBUDDY_LOGIN_ROUTE_PATH,
      async handler(req, res) {
        if (!admit(ctx, req, res)) return
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'POST' })
          res.end('method not allowed')
          return
        }
        try {
          const start = await beginLogin()
          // 轮询在后台跑：用户还没在浏览器里点完，宿主这边先等着。
          void poll(start.state)
            .then(async credential => {
              // 令牌里没有账户信息（uid、昵称），模型请求要带 `X-User-Id`、
              // 界面要显示是谁——补上再存。
              const who = await loadAccount(credential.accessToken).catch(() => undefined)
              const stored = who === undefined ? credential : { ...credential, account: who }
              await write(stored)
              // 新令牌可能能拿到更大的清单，旧的缓存别再挡着。
              invalidateWorkBuddyCatalog()
              await refreshModels().catch(() => undefined)
            })
            .catch(() => { /* 轮询失败就是没登录成，界面会再问一次状态 */ })
          respondJson(res, 200, JSON.stringify({ ok: true, url: start.url, pending: true }))
        } catch (error) {
          respondJson(res, 200, JSON.stringify({
            ok: false,
            reason: error instanceof Error ? error.message : String(error),
          }))
        }
      },
    })
  }, 'acp-agent-workbuddy-login: login route')
}

/** 准入：被拒时状态码原样、短体固定。 */
function admit(ctx: WorkBuddyRouteContext, req: IncomingMessage, res: ServerResponse): boolean {
  const admission = ctx.connection.admit(req)
  if ('rejection' in admission) {
    res.writeHead(admission.rejection)
    res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden')
    return false
  }
  return true
}

/** 读请求体（JSON）。 */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array))
  const text = Buffer.concat(chunks).toString('utf8')
  if (text === '') return undefined
  try {
    const parsed = JSON.parse(text) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

/** JSON 应答：no-store（缓存归宿主管，不许任何一环替我们缓存）+ 固定长度。 */
function respondJson(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}
