/**
 * 配额胶囊的「机器」：各家共用的取值口径、轮询器、取数与画法。
 *
 * 这一块与「哪一家」无关：胶囊只在当前会话选了对应模型时渲染，percent 是「已用」
 * 还是「剩余」决定变色方向，有没有积分胶囊——差异全收进 {@link QuotaPillSpec}。各家
 * 的**规格常量**（dock id、路由、前缀）与**词条**（quota.* 文案）不进 kit：谁家的胶囊
 * 谁家的口径与词典。这里只放共用骨架，provider 一律按 `string` 自报，文案键名用查表
 * 决定、默认回退到 minimaxi 的键名。
 *
 * 数据链路：宿主侧的某家 quota 路由用本机登录密钥转发上游应答；这里只做同源 GET，
 * 密钥永不出宿主进程。轮询器一份共享、全浏览器——配额是账号级数字，不是会话级。
 *
 * 渲染走 session-id-bar 的既定样式：.ts + createElement + 内联样式 + 词典 t。颜色只用
 * 主题令牌：过八成 `--dsw-static-red-500`，过半 `--dsw-alias-state-warn-label`。
 */

import { createElement } from 'react'
import type { ReactNode } from 'react'
import { IconDatabaseOutlineRegular, IconGaugeOutlineRegular, IconWarningOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * 登录过期时宿主给的授权信息（只含地址与用户码，不含任何令牌）。
 */
export type QuotaLoginOffer = {
  readonly url: string
  /** 设备授权码；用户可能需要在网页里手输。 */
  readonly userCode?: string
  /** 这条地址的有效秒数。 */
  readonly expiresInSec?: number
}

/** 文案座位：与插件其余部分同一个 `t`。 */
export type LoginChipT = (key: string, params?: Record<string, string | number>) => string

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 只放行 http(s)：宿主给的地址也不该把别家 scheme 塞进 `<a href>`。 */
function hrefOf(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null
  try {
    const base = typeof window === 'undefined' ? 'http://localhost' : window.location.href
    const { protocol } = new URL(value, base)
    return protocol === 'https:' || protocol === 'http:' ? value : null
  } catch {
    return null
  }
}

/**
 * 从宿主应答里取「去授权」信息。
 *
 * 只在 `needsLogin === true` 时认；地址不合规、形状不对都当没有——普通网络故障
 * 不该被画成「该去授权」。
 * @param body - 宿主路由的 JSON 应答。
 * @returns 授权信息，或 undefined。
 */
export function loginOfferOfBody(body: Record<string, unknown>): QuotaLoginOffer | undefined {
  if (body['needsLogin'] !== true) return undefined
  const raw = body['login']
  if (!isRecord(raw)) return undefined
  const url = hrefOf(raw['url'])
  if (url === null) return undefined
  const userCode = typeof raw['userCode'] === 'string' && raw['userCode'] !== '' ? raw['userCode'] : undefined
  const expiresInSec = typeof raw['expiresInSec'] === 'number' && Number.isFinite(raw['expiresInSec'])
    ? raw['expiresInSec']
    : undefined
  return {
    url,
    ...(userCode === undefined ? {} : { userCode }),
    ...(expiresInSec === undefined ? {} : { expiresInSec }),
  }
}

/**
 * 两条授权信息是否等价（只比地址与用户码——有效期变短不该让这一枚重画）。
 * @param left - 旧值。
 * @param right - 新值。
 * @returns 是否等价。
 */
export function sameLoginOffer(left: QuotaLoginOffer | undefined, right: QuotaLoginOffer | undefined): boolean {
  if (left === right) return true
  if (left === undefined || right === undefined) return false
  return left.url === right.url && left.userCode === right.userCode
}

/**
 * 画「去授权」那一行：一句说明 + 一个链接，带授权码时一并写出来。
 *
 * 链接是普通 `<a target="_blank">`：桌面外壳把 `_blank` 交给系统浏览器，网页里由
 * DSH 的链接路由处理——与文件卡片里的链接同一条路，不自己开窗。
 * @param login - 授权信息。
 * @param t - 文案座位。
 * @param options - 图标与 data-* 名前缀（各家用自己的口径标记）。
 * @returns 这一行元素。
 */
export function loginChipOf(
  login: QuotaLoginOffer,
  t: LoginChipT,
  options: { readonly provider?: string; readonly icon?: ReactNode } = {},
): ReactNode {
  const provider = options.provider ?? 'quota'
  return createElement('div', {
    'data-quota-login': true,
    [`data-${provider}-quota-login`]: true,
    title: t('quota.login.title'),
    style: {
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center',
      gap: '8px',
      fontSize: 'calc(var(--dsh-content-font-size-secondary, 13px) - 1px)',
      color: 'var(--dsw-alias-label-tertiary)',
    },
  },
    ...(options.icon === undefined ? [] : [options.icon]),
    createElement('span', null, t('quota.login.title')),
    createElement('a', {
      href: login.url,
      target: '_blank',
      rel: 'noreferrer noopener',
      'data-quota-login-link': true,
      style: { color: 'var(--dsw-alias-brand-primary, inherit)', textDecoration: 'underline' },
    }, t('quota.login.cta')),
    ...(login.userCode === undefined ? [] : [
      createElement('code', { key: 'code', 'data-quota-login-code': true }, t('quota.login.code', { code: login.userCode })),
    ]),
  )
}

/** 一套胶囊的取值口径。各家同源同骨架，差别只有四处：选谁才出现、percent 口径、有无积分、路由与文案键。 */
export interface QuotaPillSpec {
  /** 取值口径来源（provider 字符串，决定文案命名空间与变色方向）；各插件自报。 */
  readonly provider: string
  /** 当前会话目录里的 provider id 与此相等才渲染。 */
  readonly providerId?: string
  /** 模型 id 前缀匹配；providerId 已给时可以不填。 */
  readonly prefix?: string
  /** 是否渲染积分胶囊。 */
  readonly showCredit: boolean
  /** 宿主路由路径；只有走路由取数的口径才有。 */
  readonly routePath?: string
  /** dock 条目 id 与顺序。 */
  readonly dockId: string
  readonly dockOrder: number
  /**
   * 积分胶囊的文案键。缺省时回退到按 provider 查的缺省表（CREDIT_KEYS）——
   * 插件想用自己的词条（某家自有的那套 quota.*）就自带，免得把
   * 某家的键名写死进这台共享机器。
   */
  readonly creditKeys?: { readonly credit: string; readonly title: string }
  /** 积分胶囊的数字形态：缺省是「剩余」或「已用/总量」；`ratio` 是「剩余 / 额度」。 */
  readonly creditDetail?: 'ratio'
  /**
   * 悬停明细的逐行键（套餐名、每一类积分构成、总积分）。给了它，悬停就逐行
   * 展开；不给就回退到按 provider 的单句标题。
   */
  readonly creditTitleKeys?: {
    readonly plan: string
    readonly group: string
    readonly total: string
  }
}

/**
 * One consumed window as the host route forwards it. optional fields so one shape
 * serves all providers.
 */
export interface QuotaWindow {
  readonly kind: 'five-hour' | 'weekly'
  readonly used?: number
  readonly total?: number
  /** provider 口径不同：有的「已用」，有的「剩余」。 */
  readonly percent?: number
  /** 某家窗口为不限（`status === 3`）。 */
  readonly unlimited?: boolean
  /** 窗口长度（秒）：≥3 天按「周」标。 */
  readonly windowSeconds?: number
  readonly resetAt?: number
}

/** 一家套餐配额，镜像宿主路由的 `quota`。 */
export interface QuotaWindows {
  readonly level?: string
  readonly fiveHour?: QuotaWindow
  readonly weekly?: QuotaWindow
  /**
   * 有积分套餐才带：余额、按量已用与上限等，进悬停明细。
   */
  readonly credit?: {
    readonly remaining?: number
    readonly used?: number
    readonly limit?: number
    readonly recharge?: number
    readonly bonus?: number
    /** 非 CNY 钱包的提示（预拼好的字符串）；通常为空。 */
    readonly extra?: string
    /**
     * 积分构成：每一类积分的名称与总额/剩余/已用，进悬停明细。
     */
    readonly groups?: readonly {
      readonly name: string
      readonly total: number
      readonly remain: number
      readonly used: number
    }[]
  }
  /** 套餐档位；进悬停提示的第一句。 */
  readonly tier?: string
}

/** 宿主路由的整个应答体。 */
export type QuotaAnswer =
  | { readonly ok: true; readonly quota: QuotaWindows }
  | { readonly ok: false; readonly error: string; readonly login?: QuotaLoginOffer }

/** 渲染器绑定的快照钩子形状。 */
type SnapshotHook<T> = <S>(selector: (value: T | undefined) => S) => S

/** 目录快照形状（胶囊按它认当前模型）。 */
interface QuotaDirectorySnapshot {
  readonly current: { readonly provider: string; readonly model: string } | null
}

/** 轮询周期：5 分钟一拍；宿主侧还有应答缓存兜着。 */
const POLL_INTERVAL_MS = 300_000

/** 重置时刻的显示格式：月/日 + 时:分。 */
let resetFormatter: Intl.DateTimeFormat | undefined

function formatReset(unixMs: number): string {
  resetFormatter ??= new Intl.DateTimeFormat(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  return resetFormatter.format(new Date(unixMs))
}

/**
 * 配额轮询器：一份共享快照 + 订阅面，供给 dock 注册的 hooks 仓。
 *
 * 快照引用稳定：内容没变的取数不换对象、不通知。失败清空快照；原因去重——同一个
 * 原因只 report 一次，变了才再报。
 */
export interface QuotaPoller {
  subscribe(listener: () => void): () => void
  getSnapshot(): QuotaWindows | undefined
  /** 当前「去授权」信息；没有过期时是 undefined。 */
  getLogin(): QuotaLoginOffer | undefined
  refresh(): Promise<void>
  start(): void
  dispose(): void
}

/**
 * 建一个轮询器（不启动；调用方调 start）。
 * @param deps - 取数器、定时器与报错通道，全部可注入，测试不碰真网络真计时。
 * @returns 轮询器。
 */
export function createQuotaPoller(deps: {
  fetchQuota(): Promise<QuotaAnswer>
  setInterval?: (handler: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
  intervalMs?: number
  report?: (message: string) => void
}): QuotaPoller {
  const intervalMs = deps.intervalMs ?? POLL_INTERVAL_MS
  const setTimer = deps.setInterval ?? ((handler: () => void, ms: number) => globalThis.setInterval(handler, ms))
  const clearTimer = deps.clearInterval ?? ((handle: unknown) => { globalThis.clearInterval(handle as number) })
  const listeners = new Set<() => void>()
  let quota: QuotaWindows | undefined
  let handle: unknown
  let lastReason: string | undefined
  let login: QuotaLoginOffer | undefined

  const notify = (): void => { for (const listener of listeners) listener() }

  const fail = (reason: string, offer: QuotaLoginOffer | undefined): void => {
    let changed = false
    if (quota !== undefined) {
      quota = undefined
      changed = true
    }
    // 授权信息变了也要通知：胶囊旁边那枚链接要跟着换地址/消失。
    if (!sameLoginOffer(login, offer)) {
      login = offer
      changed = true
    }
    if (changed) notify()
    if (reason !== lastReason) {
      lastReason = reason
      deps.report?.(reason)
    }
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getSnapshot: () => quota,
    getLogin: () => login,
    async refresh() {
      try {
        const answer = await deps.fetchQuota()
        if (!answer.ok) {
          fail(answer.error, answer.login)
          return
        }
        lastReason = undefined
        if (login !== undefined) {
          login = undefined
          notify()
        }
        if (quota !== undefined && JSON.stringify(quota) === JSON.stringify(answer.quota)) return
        quota = answer.quota
        notify()
      } catch (error) {
        fail(`quota poll failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`, undefined)
      }
    },
    start() {
      handle = setTimer(() => { void this.refresh() }, intervalMs)
      void this.refresh()
    },
    dispose() {
      if (handle !== undefined) clearTimer(handle)
      handle = undefined
    },
  }
}

/**
 * 同源取一次宿主路由，折成 QuotaAnswer；任何故障都折成 ok:false 的原因，绝不抛出。
 * @param fetchImpl - 取数实现；缺省全局 fetch，测试注入假件。
 * @param routePath - 宿主路由路径。走路由取数的口径总会给一条真路径；缺省空串只为
 *   单测里「只关心应答折法、不关心问了哪」的调用留一个不用传的口子，生产从不落到它。
 * @returns 取数函数。
 */
export function routeQuotaFetcher(fetchImpl: typeof fetch = fetch, routePath = ''): () => Promise<QuotaAnswer> {
  return async () => {
    try {
      const response = await fetchImpl(routePath, { headers: { accept: 'application/json' } })
      let body: unknown
      try {
        body = await response.json()
      } catch (error) {
        return { ok: false, error: `HTTP ${String(response.status)}: the quota route answered no JSON (${error instanceof Error ? error.message : String(error)})` }
      }
      if (isRecord(body) && body['ok'] === true && isRecord(body['quota'])) {
        return { ok: true, quota: body['quota'] as QuotaWindows }
      }
      if (isRecord(body) && body['ok'] === false && typeof body['error'] === 'string') {
        const login = loginOfferOfBody(body)
        return { ok: false, error: body['error'], ...(login === undefined ? {} : { login }) }
      }
      return { ok: false, error: `HTTP ${String(response.status)}: the quota route answered an unrecognised body` }
    } catch (error) {
      return { ok: false, error: `quota route request failed: ${error instanceof Error ? error.message : String(error)}` }
    }
  }
}

/**
 * Render the quota pills for the composer dock.
 * @param props - 两个响应式座位、子代理可见标志、文案座位与口径（缺省由调用方给）。
 * @returns 胶囊，或该不该出现时 null。
 */
export function QuotaPillRow({ useQuota, useModelDirectory, useLogin, visible = true, t = defaultT, spec }: {
  useQuota?: SnapshotHook<QuotaWindows>
  useModelDirectory?: SnapshotHook<QuotaDirectorySnapshot>
  /** 登录过期时宿主给的授权信息；有它就画一枚「去授权」链接取代数字。 */
  useLogin?: SnapshotHook<QuotaLoginOffer>
  visible?: boolean
  t?: LoginChipT
  spec: QuotaPillSpec
}): ReactNode {
  // 钩子必须每次渲染都按同一顺序调用：同一挂载实例会经历模型从非本组切到本组，
  // 条件调用让 hook 数 1→2，React #310 会把整个 dock 条目收成空块。
  const directory = useModelDirectory?.((value) => value)
  const model = directory?.current?.model
  const providerId = directory?.current?.provider
  const quota = useQuota?.((value) => value)
  const login = useLogin?.((value) => value)
  if (visible === false) return null
  // 认谁：优先按目录里的 provider id；没给 providerId 的口径按模型 id 前缀认。
  const mine = spec.providerId !== undefined
    ? providerId === spec.providerId
    : model !== undefined && model.startsWith(spec.prefix ?? '')
  if (!mine) return null
  // 登录过期：这一行不再画数字，改画一枚能点开的授权链接（授权完成后自动恢复）。
  if (login !== undefined) return loginChip(login, t, spec)
  if (quota === undefined) return null
  const windows = [quota.fiveHour, quota.weekly].filter((window): window is QuotaWindow => window !== undefined)
  const credit = spec.showCredit ? quota.credit : undefined
  if (windows.length === 0 && credit === undefined) return null
  return createElement('div', {
    'data-quota-pills': true,
    [`data-${spec.provider}-quota`]: true,
    style: {
      display: 'flex',
      justifyContent: 'center',
      gap: '12px',
      fontSize: 'calc(var(--dsh-content-font-size-secondary, 13px) - 1px)',
      color: 'var(--dsw-alias-label-tertiary)',
    },
  },
    formatResetLine(quota.fiveHour?.resetAt, t) !== null && createElement('div', {
      key: 'reset',
      style: { textAlign: 'center', opacity: 0.8, marginBottom: '2px' },
    }, formatResetLine(quota.fiveHour?.resetAt, t)),
    ...windows.map(window => pillOf(window, t, spec, quota.tier)),
    ...(credit === undefined ? [] : [creditPillOf(credit, t, spec, quota.tier)]),
  )
}

/** kit 自带的兜底文案：词条留在各插件词典里，这里只把键名原样返回。 */
const defaultT: LoginChipT = key => key

/** 「去授权」那一枚（带上提示图标与各家口径的 data-* 标记）。 */
export function loginChip(login: QuotaLoginOffer, t: LoginChipT, spec: QuotaPillSpec): ReactNode {
  return loginChipOf(login, t, { provider: spec.provider, icon: createElement(IconWarningOutlineRegular) })
}

/** 重置时刻那行：只在 5 小时窗口带 resetAt 时出现。 */
function formatResetLine(resetAt: number | undefined, t: LoginChipT): string | null {
  return resetAt === undefined ? null : t('quota.resetAt', { reset: formatReset(resetAt) })
}

/**
 * 文案命名空间查表：各家的窗口标题各有一套（percent 口径在标题里写明）。
 * 表里没有的 provider 回退到缺省（fiveHour/weekly）那套。
 */
const TITLE_KEYS: Readonly<Record<string, (fiveHour: boolean) => string>> = {
  minimaxi: fiveHour => fiveHour ? 'quota.minimaxi.fiveHour.title' : 'quota.minimaxi.weekly.title',
  claude: fiveHour => fiveHour ? 'quota.claude.fiveHour.title' : 'quota.claude.weekly.title',
  codex: () => 'quota.codex.window.title',
  grok: () => 'quota.grok.weekly.title',
}

const DEFAULT_TITLE_KEY = (fiveHour: boolean): string => fiveHour ? 'quota.fiveHour.title' : 'quota.weekly.title'

function titleKey(provider: string, fiveHour: boolean): string {
  return (TITLE_KEYS[provider] ?? DEFAULT_TITLE_KEY)(fiveHour)
}

/** One pill: icon + 「5小时 1%」，悬停给详情与重置时刻，按用量变色。 */
export function pillOf(window: QuotaWindow, t: LoginChipT, spec: QuotaPillSpec, tier?: string): ReactNode {
  const fiveHour = window.kind === 'five-hour'
  const unlimited = window.unlimited === true
  const percent = window.percent ?? 0
  // percent 是「已用」：越高越红。某家口径是「剩余」：越低越红。
  const tone = unlimited
    ? undefined
    : spec.provider === 'minimaxi'
      ? (percent <= 20 ? 'danger' : percent <= 50 ? 'warn' : undefined)
      : (percent >= 80 ? 'danger' : percent >= 50 ? 'warn' : undefined)
  const color = tone === 'danger'
    ? 'var(--dsw-static-red-500)'
    : tone === 'warn'
      ? 'var(--dsw-alias-state-warn-label)'
      : undefined
  const reset = window.resetAt === undefined ? '' : t('quota.resetAt', { reset: formatReset(window.resetAt) })
  const title = unlimited
    ? t('quota.minimaxi.unlimitedTitle') + reset
    : spec.provider === 'zcode'
      // zcode 的标题带已用/总量；其余家只有百分比口径。
      ? t(titleKey(spec.provider, fiveHour), {
        used: String(window.used ?? 0),
        total: String(window.total ?? 0),
      }) + reset
      : spec.provider === 'grok'
        // Grok 的悬停第一句带档位；档位没拿到就退回不带档位的句子，宁缺毋滥。
        ? (tier === undefined
          ? t('quota.grok.weekly.title', { percent: String(Math.round(percent)) })
          : t('quota.grok.weekly.title.tier', { tier, percent: String(Math.round(percent)) })) + reset
        : t(titleKey(spec.provider, fiveHour), { percent: String(Math.round(percent)) }) + reset
  const label = unlimited
    ? t('quota.minimaxi.unlimited')
    : t(fiveHour ? 'quota.fiveHour.label' : 'quota.weekly.label', { percent: String(Math.round(percent)) })
  return createElement('span', {
    key: window.kind,
    title,
    ...(tone === undefined ? {} : { 'data-tone': tone }),
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '6px',
      padding: '1px 8px',
      borderRadius: '999px',
      fontVariantNumeric: 'tabular-nums',
      whiteSpace: 'nowrap',
      ...(color === undefined ? {} : { color }),
    },
  },
    createElement(fiveHour ? IconGaugeOutlineRegular : IconDatabaseOutlineRegular),
    createElement('span', null, label))
}

/**
 * 积分胶囊文案键查表：各家键名不同，表里没有的回退到 minimaxi 那套。
 */
const CREDIT_KEYS: Readonly<Record<string, { credit: string; title: string }>> = {
  claude: { credit: 'quota.claude.credit', title: 'quota.claude.creditTitle' },
  codex: { credit: 'quota.codex.credit', title: 'quota.codex.creditTitle' },
  deepseek: { credit: 'quota.deepseek.credit', title: 'quota.deepseek.creditTitle' },
}

const DEFAULT_CREDIT_KEYS = { credit: 'quota.minimaxi.credit', title: 'quota.minimaxi.creditTitle' }

function creditKeys(provider: string): { credit: string; title: string } {
  return CREDIT_KEYS[provider] ?? DEFAULT_CREDIT_KEYS
}

/** 画积分胶囊的那只（导出只为测试：文案与数字的对应关系是用户看得见的行为）。 */
export function creditPillOf(credit: {
  readonly remaining?: number
  readonly used?: number
  readonly limit?: number
  readonly recharge?: number
  readonly bonus?: number
  readonly extra?: string
  readonly groups?: readonly {
    readonly name: string
    readonly total: number
    readonly remain: number
    readonly used: number
  }[]
}, t: LoginChipT, spec: QuotaPillSpec, tier?: string): ReactNode {
  const keys = spec.creditKeys ?? creditKeys(spec.provider)
  const isDeepseek = spec.provider === 'deepseek'
  // DeepSeek 的数字是钱：固定两位小数并带上币种符号；`ratio` 口径是「剩余 / 额度」；
  // 其余家照旧（有剩余就显示剩余，否则显示「已用 / 总量」）。
  const detail = isDeepseek
    ? `¥${(credit.remaining ?? 0).toFixed(2)}`
    : spec.creditDetail === 'ratio'
      ? `${String(credit.remaining ?? 0)}${credit.limit === undefined ? '' : ` / ${credit.limit}`}`
      : credit.remaining !== undefined
        ? String(credit.remaining)
        : `${credit.used ?? 0}${credit.limit === undefined ? '' : ` / ${credit.limit}`}`
  const title = isDeepseek
    ? t('quota.deepseek.creditTitle', {
      recharge: (credit.recharge ?? credit.remaining ?? 0).toFixed(2),
      bonus: (credit.bonus ?? 0).toFixed(2),
      extra: credit.extra ?? '',
    })
    : spec.creditTitleKeys !== undefined
      ? multiLineCreditTitle(credit, t, tier, spec.creditTitleKeys)
      : spec.provider === 'claude'
        ? t('quota.claude.creditTitle', { used: String(credit.used ?? 0), limit: String(credit.limit ?? '') })
        : t(keys.title, { remaining: String(credit.remaining ?? '') })
  return createElement('span', {
    key: 'credit',
    title,
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '6px',
      padding: '1px 8px',
      borderRadius: '999px',
      fontVariantNumeric: 'tabular-nums',
      whiteSpace: 'nowrap',
    },
  },
    createElement(IconGaugeOutlineRegular),
    createElement('span', null, t(keys.credit), ' ', createElement('span', null, detail)))
}

/**
 * 逐行展开的悬停明细：套餐名、每一类积分的构成、总积分。
 *
 * 构成是站点给的那几类，少的那几类在站点里是 0——照实列出来，让人看得见积分怎么来。
 * 键由 spec 自带（{@link QuotaPillSpec.creditTitleKeys}），机器本身不认得任何一家。
 */
function multiLineCreditTitle(
  credit: {
    readonly remaining?: number
    readonly used?: number
    readonly limit?: number
    readonly groups?: readonly {
      readonly name: string
      readonly total: number
      readonly remain: number
      readonly used: number
    }[]
  },
  t: LoginChipT,
  tier: string | undefined,
  keys: { readonly plan: string; readonly group: string; readonly total: string },
): string {
  const lines: string[] = []
  if (tier !== undefined && tier !== '') lines.push(t(keys.plan, { tier }))
  for (const group of credit.groups ?? []) {
    lines.push(t(keys.group, {
      name: group.name,
      remain: String(group.remain),
      total: String(group.total),
      used: String(group.used),
    }))
  }
  lines.push(t(keys.total, {
    remaining: String(credit.remaining ?? 0),
    limit: String(credit.limit ?? 0),
  }))
  return lines.join('\n')
}

/** The dock slot face this registration needs; structural, like every slot host here. */
export type DockSlotHost = {
  inject(key: string, callback: () => unknown): unknown
  register(options: {
    name: string
    id?: string
    order?: number
    locale?: string
    inject?: (sessionId: string) => unknown
  }, component: unknown): unknown
}

/** The two services the visibility and model checks read; both optional host services. */
export interface QuotaPillServices {
  readonly modelDirectories?: { directoryFor(sessionId: string): { readonly store: unknown } }
  readonly sessions?: { subagentAddress(sessionId: string): unknown }
}

/**
 * 一次会话的目录 store；服务已经没了就当没有目录。
 *
 * @param service - the model directory service, if the host still has one.
 * @param sessionId - the session whose directory is wanted.
 * @returns the directory's store, or undefined when there is none to read.
 */
function directoryStoreOf(
  service: QuotaPillServices['modelDirectories'],
  sessionId: string,
): unknown {
  if (service === undefined) return undefined
  try {
    return service.directoryFor(sessionId)?.store
  } catch (error) {
    // 宿主日志在浏览器里看不见；这一档的线索只能留在这里。
    console.warn(`[model-kit] quota: the model directory service is gone (${error instanceof Error ? error.message : String(error)}) — the pills are hidden`)
    return undefined
  }
}

/**
 * Register the quota pills into the composer dock (a list slot, session scope),
 * next to the official stats pills. The inject face hands the renderer two bare
 * observables (quota poller, model directory) plus the subagent visibility flag.
 *
 * @param slots - the slot host (`ctx.slots`).
 * @param poller - the shared quota poller (created once in apply).
 * @param services - the host services, when present.
 * @param spec - 取值口径。
 * @returns the disposer of the registration.
 */
export function registerQuotaDockPills(
  slots: DockSlotHost,
  poller: QuotaPoller,
  services: Partial<QuotaPillServices>,
  spec: QuotaPillSpec,
): () => void {
  return slots.inject('conversation.composer.dock', () => slots.register(
    {
      name: 'conversation.composer.dock',
      id: spec.dockId,
      order: spec.dockOrder,
      inject: (sessionId: string) => {
        // 服务可能已经没了（连接重建后旧实例被处置）：取不到就当没有目录。
        const directory = directoryStoreOf(services.modelDirectories, sessionId)
        const visible = services.sessions?.subagentAddress(sessionId) === undefined
        return {
          visible,
          hooks: {
            zcodeQuota: poller,
            // 同一只轮询器的另一半快照：登录过期时的「去授权」信息。
            zcodeLogin: { subscribe: poller.subscribe, getSnapshot: () => poller.getLogin() },
            ...(directory === undefined ? {} : { zcodeDirectory: directory }),
          },
        }
      },
    },
    (props: {
      readonly useZcodeQuota?: SnapshotHook<QuotaWindows>
      readonly useZcodeLogin?: SnapshotHook<QuotaLoginOffer>
      readonly useZcodeDirectory?: SnapshotHook<QuotaDirectorySnapshot>
      readonly visible?: boolean
      readonly t?: LoginChipT
    }) => createElement(QuotaPillRow, {
      ...(props.useZcodeQuota === undefined ? {} : { useQuota: props.useZcodeQuota }),
      ...(props.useZcodeLogin === undefined ? {} : { useLogin: props.useZcodeLogin }),
      ...(props.useZcodeDirectory === undefined ? {} : { useModelDirectory: props.useZcodeDirectory }),
      ...(props.visible === undefined ? {} : { visible: props.visible }),
      ...(props.t === undefined ? {} : { t: props.t }),
      spec,
    }),
  )) as () => void
}
