/**
 * MiniMax Token Plan 限额与积分的宿主侧接口。
 *
 * 浏览器画输入框下方的配额胶囊时要读这份限额，但登录令牌只住在宿主进程
 * *（minimaxi-acp 的约定：内存里用、不落盘、不进日志）。所以这一层只做转发：
 * 同源 GET `/acp-agent/minimax/quota` → 宿主用本机登录令牌问一次 MiniMax
 * 的网关（签名查组与积分）+ 开放平台（查两个窗口），把 5 小时、周、积分
 * 的数字原样发回。令牌本身永远不出宿主。
 *
 * 准入与缓存照抄 zcode-quota 这条已经验过的路：官方 /api 同一面 admit，
 * 拒绝时状态码原样、短体固定；成功应答带 30 秒缓存；取数失败或应答形状
 * 不认识都不甩 500——200 + `ok:false` + 原因，浏览器侧据此把胶囊藏起来并在
 * 日志里留一行。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { fetchMiniMaxQuota, isMiniMaxLoginRequired } from './minimaxi/index.ts'
import type { MiniMaxCodingPlanQuota, MiniMaxLoginRequiredError, MiniMaxQuotaRequest } from './minimaxi/index.ts'
import { beginDeviceLogin, cachedLoginPrompt, createLoginManager, loginUrlHint, promptUrl } from './minimaxi/login.ts'

export const name = 'acp-agent-minimaxi-quota'

/** webServer 挂路由；connection 做准入（admit）。 */
export const inject = ['webServer', 'connection']

/** exact 路由路径；浏览器侧的胶囊按这个常量取数。 */
export const QUOTA_ROUTE_PATH = '/acp-agent/minimax/quota'

/** 成功应答的缓存时长；换算成上游被问的频率上限（多标签页也不翻倍）。 */
const CACHE_TTL_MS = 30_000

/** 取一次配额+积分的最小面：无参进去，配额或 null 出来，失败抛错（消息已脱敏）。 */
export type MiniMaxQuotaFetch = () => Promise<MiniMaxCodingPlanQuota | null>

/** 模块级可替换的取数器：生产走真令牌真网络，测试换假件。 */
let quotaFetch: MiniMaxQuotaFetch | undefined

/** 设备授权提示的来源形状（登录模块里 `beginDeviceLogin` 的回值）。 */
type LoginPrompt = { readonly userCode: string; readonly verificationUri: string; readonly verificationUriComplete?: string; readonly expiresInSec: number }
type LoginStarter = (error: MiniMaxLoginRequiredError) => Promise<LoginPrompt>

/** 可替换的「开一次登录」，测试用它避开真实账号端点。 */
let loginStarter: LoginStarter | undefined

/**
 * 换登录发起器（测试注入假件）；传回 `undefined` 恢复生产实现。
 * @param next - 下一只会发起设备授权的函数，或 `undefined`。
 */
export function swapLoginStarter(next: LoginStarter | undefined): void {
  loginStarter = next
}

/**
 * 换取数器（测试注入假件）；传回 `undefined` 恢复真件。
 * @param next - 下一只取数器，或 `undefined` 恢复生产实现。
 */
export function swapQuotaFetch(next: MiniMaxQuotaFetch | undefined): void {
  quotaFetch = next
}

/** 这个入口需要的宿主面（窄接口，测试立桩照这个来）。 */
export interface MiniMaxQuotaContext {
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

/** 注册时可选的注入面；生产空着，测试换缓存时长。 */
export interface MiniMaxQuotaRouteDeps {
  /** 成功应答的缓存时长（毫秒）；缺省 30 秒。 */
  ttlMs?: number
}

/**
 * 装载入口：挂上这条 exact 路由。
 * @param ctx - 宿主上下文（effect / webServer / connection）。
 */
export function apply(ctx: MiniMaxQuotaContext): void {
  registerMiniMaxQuotaRoute(ctx)
}

/**
 * 注册配额路由，走 DSH 插件的登记样式：`ctx.effect(() => ctx.webServer.register(...))`。
 *
 * 缓存在本次注册的闭包里：一次注册一份，重复注册不共享旧账。
 * @param ctx - 宿主上下文（effect / webServer / connection）。
 * @param deps - 可选注入面；缺省时缓存 30 秒。
 */
export function registerMiniMaxQuotaRoute(ctx: MiniMaxQuotaContext, deps: MiniMaxQuotaRouteDeps = {}): void {
  const ttlMs = deps.ttlMs ?? CACHE_TTL_MS
  let cached: { at: number; quota: MiniMaxCodingPlanQuota } | undefined
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: QUOTA_ROUTE_PATH,
        async handler(req, res) {
          // 拒绝分支照抄官方 /api 的写法：状态码原样，短体固定。
          const admission = ctx.connection.admit(req)
          if ('rejection' in admission) {
            res.writeHead(admission.rejection)
            res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden')
            return
          }
          if (req.method !== 'GET') {
            res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET' })
            res.end('method not allowed')
            return
          }
          if (cached !== undefined && Date.now() - cached.at < ttlMs) {
            respondJson(res, 200, JSON.stringify({ ok: true, quota: cached.quota }))
            return
          }
          const fetcher = quotaFetch ?? defaultQuotaFetch
          try {
            const quota = await fetcher()
            if (quota === null) {
              respondJson(res, 200, JSON.stringify({
                ok: false,
                error: 'unrecognised MiniMax answer — no five-hour or weekly window was present',
              }))
              return
            }
            cached = { at: Date.now(), quota }
            respondJson(res, 200, JSON.stringify({ ok: true, quota }))
          } catch (error) {
            // 到这一层的错误消息已在 quota 模块里脱敏（令牌不可能混进来）。
            const message = error instanceof Error ? error.message : String(error)
            if (!isMiniMaxLoginRequired(error)) {
              respondJson(res, 200, JSON.stringify({ ok: false, error: message }))
              return
            }
            // 登录过期：光说「过期了」没用，附一条能点开的授权地址。
            const login = await loginOfferOf(error)
            respondJson(res, 200, JSON.stringify({
              ok: false,
              error: message,
              needsLogin: true,
              ...(login === undefined ? {} : { login }),
            }))
          }
        },
      }),
    'acp-agent-minimaxi-quota: quota route',
  )
}

/** 上游取数超时：挂住的上游不该把这一路接口一起挂住（2026-10-16 审计补漏）。 */
export const QUOTA_UPSTREAM_TIMEOUT_MS = 15_000

/** 生产取数器：令牌、地址、签名全在 quota 模块内解析；自带超时信号。 */
export const defaultQuotaFetch: MiniMaxQuotaFetch = () =>
  fetchMiniMaxQuota({ signal: AbortSignal.timeout(QUOTA_UPSTREAM_TIMEOUT_MS) })

/**
 * 生产取数器的可注入版本：测试传一份现成凭据，就不必碰本机真实登录
 * （真实登录一过期，测试会跟着环境红——2026-11-03 就是这样）。
 * @param request - 覆盖项（凭据、超时信号以外的一切）。
 * @returns 一次配额读数。
 */
export function quotaFetchWith(request: MiniMaxQuotaRequest): Promise<MiniMaxCodingPlanQuota | null> {
  return fetchMiniMaxQuota({ signal: AbortSignal.timeout(QUOTA_UPSTREAM_TIMEOUT_MS), ...request })
}

/** 生产实现：真开一次设备授权（拿到提示就返回，轮询留在后台）。 */
function defaultLoginStarter(error: MiniMaxLoginRequiredError): Promise<LoginPrompt> {
  return error.region === undefined || error.buildEnv === undefined
    ? Promise.reject(new Error('unknown MiniMax login namespace'))
    : beginDeviceLogin({
      manager: createLoginManager({ dataDir: error.dataDir, region: error.region, buildEnv: error.buildEnv }),
    })
}

/**
 * 「去哪儿授权」的那条应答：先看已缓存的提示，没有就现开一次设备授权；
 * 端点不通时退回账户站点，至少给得出一个能打开的地址。
 * @param error - 登录不可用的错误（带着区域与环境）。
 * @returns 浏览器可用的授权信息，或 undefined（连账户站点都算不出来）。
 */
async function loginOfferOf(error: MiniMaxLoginRequiredError): Promise<
  { readonly url: string; readonly userCode?: string; readonly expiresInSec?: number } | undefined
> {
  if (error.region !== undefined && error.buildEnv !== undefined) {
    // 后台开一次设备授权；只等很短一会儿——MiniMax Code 在跑时它握着跨进程锁，
    // 我们这次登录要排队，不能把这一路接口挂在那里。等不到就用缓存/账户站点，
    // 下一轮轮询（30 秒）多半已经拿到带用户码的完整地址。
    const started = (loginStarter ?? defaultLoginStarter)(error).then(
      prompt => ({ url: promptUrl(prompt), userCode: prompt.userCode, expiresInSec: prompt.expiresInSec }),
      () => undefined,
    )
    const arrived = await Promise.race([started, sleepThenUndefined(LOGIN_OFFER_WAIT_MS)])
    if (arrived !== undefined) return arrived
  }
  // 赛跑期间流程可能刚好把提示写进缓存：再读一次，能带上用户码就带上。
  const settled = loginUrlHint(error.region ?? 'cn', error.buildEnv ?? 'prod')
  if (settled === undefined) return undefined
  const prompt = cachedLoginPrompt()
  return prompt !== undefined && promptUrl(prompt) === settled
    ? { url: settled, userCode: prompt.userCode, expiresInSec: prompt.expiresInSec }
    : { url: settled }
}

/** 等设备授权提示的预算：够一次正常往返，又不至于把配额接口挂住。 */
const LOGIN_OFFER_WAIT_MS = 3_000

/** 等一小会儿再给 undefined，用来和登录流程赛跑。 */
function sleepThenUndefined(ms: number): Promise<undefined> {
  return new Promise(resolve => {
    const timer = setTimeout(() => { resolve(undefined) }, ms)
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      (timer as { unref(): void }).unref()
    }
  })
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
