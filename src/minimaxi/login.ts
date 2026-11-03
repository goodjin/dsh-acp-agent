/**
 * 「登录过期了去哪儿授权」这件事的唯一出口。
 *
 * 本地登录（`~/.minimax/auth/<buildEnv>/<region>/mcode-public/auth.json`）由
 * MiniMax Code 自己维护；本插件平时只读、必要时借用官方刷新路径。可一旦刷新令牌
 * 也过期（`requiresInteractiveLogin`），再重试多少次都没用——此时唯一有用的是
 * 一条**可以点开的授权地址**。
 *
 * 上游实现里这就是设备授权（device authorization）流程：POST 设备码端点拿到
 * `user_code` 与 `verification_uri_complete`，人在浏览器里确认，客户端轮询令牌端点，
 * 成功后把新凭据写回同一份 `auth.json`（同一把跨进程锁）。本模块把两端接起来：
 *
 * - {@link beginDeviceLogin} 启动一次登录，**拿到提示就返回**，轮询在后台继续；
 *   用户确认后凭据由官方 core 写回，下一次 `resolveCredential` 自然读到新令牌；
 * - 提示按过期时间缓存，配额轮询每秒问一次也不会反复开新流程；
 * - 拿不到提示（离线、端点不通）时退回账户站点，至少给人一个能打开的地址。
 *
 * 令牌不经过这里：`beginDeviceLogin` 只回传设备码与地址。
 */

import { createMCodeAuthManager, resolveMCodeOAuthEndpointConfig } from './vendor/mcode-oauth/index.ts'
import type { AuthBuildEnv, AuthRegion } from './vendor/mcode-oauth/contracts.ts'

/** 上游设备授权提示的形状（与 vendored `DeviceAuthorizationPrompt` 同构）。 */
export type MiniMaxLoginPrompt = {
  readonly userCode: string
  readonly verificationUri: string
  readonly verificationUriComplete?: string
  readonly expiresInSec: number
}

/** 登录流程需要的那一个方法；测试用假实现替换。 */
export type LoginManager = {
  login(options?: { onDeviceAuthorization?: (prompt: MiniMaxLoginPrompt) => void }): Promise<unknown>
}

export type BeginLoginOptions = {
  readonly manager: LoginManager
  /** 现在几点，测试可拨钟。 */
  readonly now?: () => number
  /** 等提示的期限；到点还没拿到就认为这条路不通。 */
  readonly timeoutMs?: number
}

/** 已经拿到、还没过期的提示。 */
let pending: { prompt: MiniMaxLoginPrompt; untilMs: number } | undefined
/** 正在等提示的那一次（并发调用复用同一个流程）。 */
let inFlight: Promise<MiniMaxLoginPrompt> | undefined

/** 等设备授权提示的默认期限：够慢网络回来，又不至于让人等到以为坏了。 */
export const LOGIN_PROMPT_TIMEOUT_MS = 10_000

/** 账户站点（与官方端点表一致；只有 prod 有稳定地址）。 */
export function accountOrigin(region: AuthRegion, buildEnv: AuthBuildEnv): string | undefined {
  if (buildEnv !== 'prod') return undefined
  return region === 'cn' ? 'https://account.minimax.cn' : 'https://account.minimax.io'
}

/** 缓存的授权地址（若还新鲜）。 */
export function cachedLoginPrompt(now: () => number = Date.now): MiniMaxLoginPrompt | undefined {
  return pending !== undefined && pending.untilMs > now() ? pending.prompt : undefined
}

/** 忘掉缓存：测试用，或在人工确认「已经重新登录」后清掉。 */
export function clearLoginPrompt(): void {
  pending = undefined
}

/** 提示里那条最省事的地址：带用户码的完整地址优先。 */
export function promptUrl(prompt: MiniMaxLoginPrompt): string {
  return prompt.verificationUriComplete ?? prompt.verificationUri
}

/**
 * 现在能给出的授权地址：缓存里的提示优先，否则退回账户站点。
 *
 * 不发起网络请求——模型请求的报错路径会调它，那里不该再开一条后台流程。
 * @param region - 登录所属区域。
 * @param buildEnv - 登录所属构建环境。
 * @returns 可点开的地址，连账户站点都给不出时返回 undefined。
 */
export function loginUrlHint(
  region: AuthRegion,
  buildEnv: AuthBuildEnv,
  now: () => number = Date.now,
): string | undefined {
  const prompt = cachedLoginPrompt(now)
  return prompt === undefined ? accountOrigin(region, buildEnv) : promptUrl(prompt)
}

/**
 * 启动一次设备授权登录：拿到提示就返回，轮询在后台继续。
 *
 * 用户确认授权后，官方 core 会把新凭据写回共享的 `auth.json`（同一把跨进程锁），
 * 因此下一次 `resolveCredential` 不需要任何额外交代就能读到新令牌。
 * @param options - 登录管理器与时钟/期限。
 * @returns 设备授权提示。
 * @throws 等不到提示（离线、端点不通）或流程在给出提示前就失败。
 */
export function beginDeviceLogin(options: BeginLoginOptions): Promise<MiniMaxLoginPrompt> {
  const now = options.now ?? Date.now
  const cached = cachedLoginPrompt(now)
  if (cached !== undefined) return Promise.resolve(cached)
  if (inFlight !== undefined) return inFlight

  const timeoutMs = options.timeoutMs ?? LOGIN_PROMPT_TIMEOUT_MS
  inFlight = new Promise<MiniMaxLoginPrompt>((resolve, reject) => {
    let settled = false
    const finish = (settle: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      settle()
    }
    const timer = setTimeout(() => {
      finish(() => { reject(new Error(`the MiniMax authorization endpoint did not answer within ${String(timeoutMs)} ms`)) })
    }, timeoutMs)
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      // 后台流程不该拖住宿主退出。
      (timer as { unref(): void }).unref()
    }
    // 登录流程本身在给出提示之后还要继续轮询；它的失败不该变成未处理拒绝。
    void Promise.resolve()
      .then(() => options.manager.login({
        onDeviceAuthorization: (prompt) => {
          pending = { prompt, untilMs: now() + Math.max(prompt.expiresInSec, 60) * 1000 }
          finish(() => { resolve(prompt) })
        },
      }))
      .catch((error: unknown) => {
        finish(() => { reject(error instanceof Error ? error : new Error(String(error))) })
      })
  }).finally(() => { inFlight = undefined })
  return inFlight
}

/** 为某个登录命名空间建一个登录管理器（与 `resolveCredential` 用同一套端点与存储）。 */
export function createLoginManager(options: {
  readonly dataDir: string
  readonly region: AuthRegion
  readonly buildEnv: AuthBuildEnv
  readonly env?: NodeJS.ProcessEnv
  readonly fetchImpl?: typeof fetch
}): LoginManager {
  const env = options.env ?? process.env
  return createMCodeAuthManager({
    dataDir: options.dataDir,
    region: options.region,
    buildEnv: options.buildEnv,
    endpoints: resolveMCodeOAuthEndpointConfig(env, { region: options.region, buildEnv: options.buildEnv }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  })
}
