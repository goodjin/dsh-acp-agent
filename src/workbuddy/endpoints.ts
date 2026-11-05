import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * WorkBuddy 的端点。
 *
 * WorkBuddy 的账号体系与模型服务都在它自己的站点上，登录接口与模型接口**必须
 * 同源**：登录在 A 站拿到令牌、模型请求打 B 站，就是「登录成功但每个请求都 401」。
 * 所以这里只解析一个基址，其余地址全部从它派生——不存在「只改了模型地址」的
 * 可能。
 *
 * 覆盖顺序：显式传入 → 环境变量 `WORKBUDDY_BASE_URL` → 默认的官方外网站。
 * 企业自建站点由部署方用环境变量指定（账号体系与模型服务通常一起搬）。
 */

/** 默认的官方外网站（登录页与模型服务同源）。 */
export const DEFAULT_WORKBUDDY_BASE = 'https://www.workbuddy.cn'

/** 换站的环境变量名。 */
export const WORKBUDDY_BASE_ENV = 'WORKBUDDY_BASE_URL'

/** 登录接口在站点上的前缀（WorkBuddy 的账号接口挂在 `/plugin` 下）。 */
export const WORKBUDDY_AUTH_PREFIX = '/plugin'

/** 平台标识：登录 state 接口按它区分站点。 */
export const WORKBUDDY_PLATFORM = 'workbuddy'

/**
 * 客户端标识（User-Agent）。
 *
 * 站点**按 UA 里的产品名认客户端**：形状不是 `WorkBuddy/版本` 的 UA 一律 400
 * 「check ua, get coding copilot version error」——清单与模型请求都过不去。
 * 版本号是我们这个适配器的协议版本（不是插件发版号）；后缀标出请求来自哪个客户端，
 * 站点日志里能认出来。
 */
export const WORKBUDDY_UA = 'WorkBuddy/1.0.0-dsh-acp-agent'

/** 桌面版本地状态的根目录（清单缓存、凭据等）。 */
export const WORKBUDDY_HOME_ENV = 'WORKBUDDY_HOME'

/**
 * 每发请求都带的头。
 * @param extra - 这一发请求特有的头。
 * @returns 头表。
 */
export function workBuddyHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { 'user-agent': WORKBUDDY_UA, ...extra }
}

/**
 * 桌面版那份产品配置的缓存目录。
 *
 * 桌面版登录后会把站点下发的完整配置（模型清单、积分倍率、端点）缓存在这里；
 * 我们借用它——它带着**官方倍率**，而我们自己去问站点拿到的是缩水版清单。
 * @param env - 环境变量。
 * @returns 目录路径。
 */
export function desktopCatalogDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env[WORKBUDDY_HOME_ENV] !== undefined && env[WORKBUDDY_HOME_ENV] !== ''
    ? env[WORKBUDDY_HOME_ENV]
    : join(homedir(), '.workbuddy')
  return join(home, 'local_storage')
}

/** 一个基址派生出来的全部地址。 */
export type WorkBuddyEndpoints = {
  /** 去掉尾斜杠的基址，例如 `https://www.workbuddy.cn`。 */
  readonly base: string
  /** 要登录凭证：`{base}/v2/plugin/auth/state`。 */
  readonly authStateUrl: string
  /** 轮询令牌：`{base}/v2/plugin/auth/token`（`state` 由调用方追加）。 */
  readonly authTokenUrl: string
  /** 续期：`{base}/v2/plugin/auth/token/refresh`。 */
  readonly authRefreshUrl: string
  /** 账户信息：`{base}/v2/plugin/account`。 */
  readonly accountUrl: string
  /** 模型清单：`{base}/v3/config`。 */
  readonly configUrl: string
  /** 模型请求：`{base}/v2/chat/completions`。 */
  readonly chatUrl: string
  /** 签到状态：`{base}/v2/billing/meter/checkin-activity-status`。 */
  readonly checkinStatusUrl: string
  /** 领当天积分：`{base}/v2/billing/meter/daily-checkin`。 */
  readonly dailyCheckinUrl: string
  /** 套餐与积分：`{base}/billing/meter/get-user-resource-summary`（这一条不带 /v2）。 */
  readonly creditsUrl: string
}

/**
 * 从一个基址解出全部地址。
 * @param override - 显式指定的基址；空则看环境变量，再空则用默认值。
 * @param env - 环境变量来源，测试可注入。
 * @returns 全部地址。
 */
export function resolveEndpoints(
  override?: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): WorkBuddyEndpoints {
  const configured = (override ?? env[WORKBUDDY_BASE_ENV] ?? '').trim()
  const base = (configured === '' ? DEFAULT_WORKBUDDY_BASE : configured).replace(/\/+$/u, '')
  const auth = `${base}/v2${WORKBUDDY_AUTH_PREFIX}`
  return {
    base,
    authStateUrl: `${auth}/auth/state`,
    authTokenUrl: `${auth}/auth/token`,
    authRefreshUrl: `${auth}/auth/token/refresh`,
    accountUrl: `${auth}/account`,
    configUrl: `${base}/v3/config`,
    chatUrl: `${base}/v2/chat/completions`,
    checkinStatusUrl: `${base}/v2/billing/meter/checkin-activity-status`,
    dailyCheckinUrl: `${base}/v2/billing/meter/daily-checkin`,
    creditsUrl: `${base}/billing/meter/get-user-resource-summary`,
  }
}
