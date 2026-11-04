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
import { pollForToken, startLogin } from './workbuddy/auth.ts'
import type { WorkBuddyCredential, WorkBuddyLoginStart } from './workbuddy/auth.ts'
import { credentialFilePath, readStoredCredential, writeStoredCredential } from './workbuddy/credential.ts'

export const name = 'acp-agent-workbuddy-login'

/** webServer 挂路由；connection 做准入（admit）。 */
export const inject = ['webServer', 'connection']

/** 登录状态。 */
export const WORKBUDDY_SESSION_ROUTE_PATH = '/acp-agent/workbuddy/session'

/** 开始登录。 */
export const WORKBUDDY_LOGIN_ROUTE_PATH = '/acp-agent/workbuddy/login'

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
              await write(credential)
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

/** JSON 应答：no-store（缓存归宿主管，不许任何一环替我们缓存）+ 固定长度。 */
function respondJson(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}
