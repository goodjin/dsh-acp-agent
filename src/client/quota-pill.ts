/**
 * GLM 套餐配额胶囊：挂在输入框下方的 dock 里，与 token 用量同一排。
 *
 * 「机器」（取值口径、轮询器、取数、画法、dock 注册）已迁到 @goodjin2/dsh-model-kit/client；
 * 本文件只剩 agent-acp 自己的两样东西：
 * 1. 各家**规格常量**（dock id、路由、模型前缀、目录 provider id）与路由路径；
 * 2. DeepSeek 官方账号余额的取数器（走设置页同一条 remote 通道，是这家的私事）。
 */

import type { QuotaAnswer, QuotaPillSpec } from '@goodjin2/dsh-model-kit/client'
export {
  createQuotaPoller,
  loginChip,
  loginChipOf,
  creditPillOf,
  pillOf,
  registerQuotaDockPills,
  routeQuotaFetcher,
  sameLoginOffer,
  loginOfferOfBody,
  QuotaPillRow,
} from '@goodjin2/dsh-model-kit/client'
export type {
  QuotaPillServices,
  QuotaWindow,
  QuotaWindows,
  QuotaAnswer,
  QuotaPillSpec,
  QuotaLoginOffer,
  QuotaPoller,
  DockSlotHost,
} from '@goodjin2/dsh-model-kit/client'

/** 与宿主侧 zcode-quota 路由登记的同一路径。 */
export const QUOTA_ROUTE_PATH = '/acp-agent/zcode/quota'

/** MiniMax 那侧宿主路由的同一路径（见 dsh-preset-dispatch/minimaxi-quota）。 */
export const MINIMAX_QUOTA_ROUTE_PATH = '/acp-agent/minimax/quota'

/** Codex（ChatGPT 套餐）宿主路由（见 dsh-preset-dispatch/codex-quota）。 */
export const CODEX_QUOTA_ROUTE_PATH = '/acp-agent/codex/quota'

/** Claude（Anthropic 官方订阅）宿主路由（见 dsh-preset-dispatch/claude-quota）。 */
export const CLAUDE_QUOTA_ROUTE_PATH = '/acp-agent/claude/quota'

/** dock 里的条目 id 与顺序：排在官方 stats（order 0）之后。 */
export const QUOTA_DOCK_ID = 'acp-agent-zcode-quota'
export const QUOTA_DOCK_ORDER = 10

/** zcode 那组模型在目录里的 id 前缀；选了它才轮到配额胶囊出场。 */
const GLM_MODEL_PREFIX = 'GLM-'

/** GLM 那套：缺省口径，dock 注册不传 spec 时就是它。 */
export const GLM_QUOTA_PILL_SPEC: QuotaPillSpec = {
  provider: 'zcode',
  prefix: GLM_MODEL_PREFIX,
  showCredit: false,
  routePath: QUOTA_ROUTE_PATH,
  dockId: QUOTA_DOCK_ID,
  dockOrder: QUOTA_DOCK_ORDER,
}

/** MiniMax 那套：前缀 MiniMax-、多一枚积分胶囊、percent 是「剩余」。 */
export const MINIMAX_QUOTA_PILL_SPEC: QuotaPillSpec = {
  provider: 'minimaxi',
  prefix: 'MiniMax-',
  showCredit: true,
  routePath: MINIMAX_QUOTA_ROUTE_PATH,
  dockId: 'acp-agent-minimaxi-quota',
  dockOrder: 11,
}

/** Codex 那套：按目录里的 provider id 认（gpt-* 这类 id 太通用，不按前缀）。 */
export const CODEX_QUOTA_PILL_SPEC: QuotaPillSpec = {
  provider: 'codex',
  providerId: 'acp:acp-codex',
  showCredit: true,
  routePath: CODEX_QUOTA_ROUTE_PATH,
  dockId: 'acp-agent-codex-quota',
  dockOrder: 12,
}

/** Claude 那套：同按 provider id 认（模型 id 是 default/opus 这类通用别名）。 */
export const CLAUDE_QUOTA_PILL_SPEC: QuotaPillSpec = {
  provider: 'claude',
  providerId: 'acp:acp-claude',
  showCredit: true,
  routePath: CLAUDE_QUOTA_ROUTE_PATH,
  dockId: 'acp-agent-claude-quota',
  dockOrder: 13,
}

/** DeepSeek 那套：没有宿主路由——取数走 remote 余额接口（见 remoteBalanceFetcher）。 */
export const DEEPSEEK_QUOTA_PILL_SPEC: QuotaPillSpec = {
  provider: 'deepseek',
  providerId: 'deepseek-account',
  showCredit: true,
  dockId: 'acp-agent-deepseek-quota',
  dockOrder: 14,
}

/** Grok 那套：同按 provider id 认；percent 是「已用」，跟 Codex/Claude 一个方向。 */
export const GROK_QUOTA_PILL_SPEC: QuotaPillSpec = {
  provider: 'grok',
  providerId: 'acp:acp-grok',
  showCredit: false,
  routePath: '/acp-agent/grok/quota',
  dockId: 'acp-agent-grok-quota',
  dockOrder: 15,
}

/** 全部口径，按 dock 顺序——apply 按它各挂一条轮询器、各进一个 dock 条目。 */
export const QUOTA_PILL_SPECS: readonly QuotaPillSpec[] = [
  GLM_QUOTA_PILL_SPEC,
  MINIMAX_QUOTA_PILL_SPEC,
  CODEX_QUOTA_PILL_SPEC,
  CLAUDE_QUOTA_PILL_SPEC,
  DEEPSEEK_QUOTA_PILL_SPEC,
  GROK_QUOTA_PILL_SPEC,
]

/**
 * 请求方身份：宿主拿它派生 Platform 请求头。设置页传的是「应用版本 + 界面语言 +
 * 时区偏移」，这里保持同一形状——版本与设置页一样取 DSH 运行时版本（升级时两处
 * 一起改）。
 */
const DEEPSEEK_APP_VERSION = '0.2.1-rc.5'

/** 一只钱包：币种 + 余额（宿主已经把它校验成十进制字符串）。 */
interface DeepseekWallet {
  readonly currency?: unknown
  readonly balance?: unknown
}

/** 用「分」做加法，避免 0.1 + 0.2 这类浮点尾巴混进钱里。 */
function sumCny(wallets: readonly DeepseekWallet[]): number {
  const cents = wallets
    .filter(wallet => wallet.currency === 'CNY')
    .reduce((total, wallet) => {
      const value = Number(wallet.balance)
      return Number.isFinite(value) ? total + Math.round(value * 100) : total
    }, 0)
  return cents / 100
}

/**
 * DeepSeek 官方账号的余额取数器：走设置页同一条 remote 通道
 * （`remote.account.getBalance`），把充值钱包折成积分胶囊的形状。
 *
 * 折算口径：数字只认充值钱包的 CNY 合计——没有汇率就不把 USD 或赠送金合并进来，
 * 它们进悬停明细（credit.extra / bonus）。任何故障（remote 不在场、未登录、
 * 远端说失败、形状不认识、钱包列表为空）都折成 ok:false，胶囊安静地不出现：
 * DeepSeek 的登录在应用设置里完成，没有可点开的授权链接，所以这 家不出「去授权」。
 */
export function remoteBalanceFetcher(deps: {
  /** 宿主注入的 remote 面（`ctx.remote`）；缺了就永远 ok:false。 */
  readonly remote?: unknown
  /** 当时的界面语言；每次取数都问一遍，切语言后下一拍就换。 */
  readonly locale?: () => string
  /** 覆盖请求方版本；默认与设置页同一常量。 */
  readonly version?: string
}): () => Promise<QuotaAnswer> {
  return async () => {
    const getBalance = (deps.remote as {
      account?: { getBalance?: (metadata: unknown) => Promise<unknown> }
    } | null | undefined)?.account?.getBalance
    if (typeof getBalance !== 'function') {
      return { ok: false, error: 'the remote account API is not available on this context' }
    }
    const timezoneOffsetSeconds = -new Date().getTimezoneOffset() * 60
    let result: unknown
    try {
      result = await getBalance.call(deps.remote, {
        version: deps.version ?? DEEPSEEK_APP_VERSION,
        locale: deps.locale?.() ?? 'en',
        timezoneOffsetSeconds,
      })
    } catch (error) {
      return { ok: false, error: `account balance request failed: ${error instanceof Error ? error.message : String(error)}` }
    }
    if (result === null || result === undefined) {
      return { ok: false, error: 'no DeepSeek account session (signed out, or the grant changed)' }
    }
    if (typeof result !== 'object' || !('ok' in result)) {
      return { ok: false, error: 'the account balance answered an unrecognised shape' }
    }
    const outcome = result as { ok?: unknown; error?: unknown; value?: unknown }
    if (outcome.ok !== true) {
      const reason = typeof outcome.error === 'string' && outcome.error !== '' ? outcome.error : 'the account balance query failed'
      return { ok: false, error: reason }
    }
    const detail = outcome.value as { status?: unknown; value?: unknown; bonusWallets?: unknown } | null | undefined
    if (detail === null || typeof detail !== 'object' || detail.status !== 'ready' || !Array.isArray(detail.value)) {
      return { ok: false, error: 'the account balance answered an unrecognised shape' }
    }
    const normal = detail.value as DeepseekWallet[]
    const bonus = Array.isArray(detail.bonusWallets) ? (detail.bonusWallets as DeepseekWallet[]) : []
    if (normal.length === 0) {
      return { ok: false, error: 'the account carries no recharge wallet' }
    }
    const recharge = sumCny(normal)
    const bonusCny = sumCny(bonus)
    const usdCents = normal
      .filter(wallet => wallet.currency === 'USD')
      .reduce((total, wallet) => {
        const value = Number(wallet.balance)
        return Number.isFinite(value) ? total + Math.round(value * 100) : total
      }, 0)
    const extra = usdCents === 0 ? undefined : `；另有 $${(usdCents / 100).toFixed(2)}`
    return {
      ok: true,
      quota: { credit: { remaining: recharge, recharge, bonus: bonusCny, ...(extra === undefined ? {} : { extra }) } },
    }
  }
}
