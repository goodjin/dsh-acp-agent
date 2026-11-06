/**
 * MiniMax 每日签到（daily check-in）：查面板、领一次，以及每天定点的那个定时器。
 *
 * 签到是 MiniMax Code 官方自带的：连着签给积分，签到积分 30 天有效、只能在
 * MiniMax Code 里用（官方桌面版的「每日签到」入口、CLI 的 `/checkin` 命令）。
 * 这里做的是把同一条链路接进 DSH：每天定点自己领一次，宿主没开着的第二天
 * 装载时补签。
 *
 * 契约抄自上游 `MiniMax-AI/minimax-code`：
 *
 * - `packages/shared/src/daily-signin.ts` —— 面板与领取应答的形状和校验规则；
 * - `packages/tui/src/checkin/http-gateway.ts` —— 两条地址与请求头的形状。
 *
 * 核对时间 2026-11-07（ZCode 那台机器、cn/prod 登录）：状态接口返回 7 天一轮的
 * 面板，当天可领 400 积分（连签第 4、7 天是 1000）。
 *
 * 凭据就是本机 MiniMax Code 的登录——与模型请求同一份，不另存令牌。令牌只在
 * 内存里，任何要给人看的消息都先脱敏。
 */

import { execFileSync } from 'node:child_process'
import { resolveCredential } from './credential.ts'
import type { CredentialOverrides, MiniMaxCredential } from './credential.ts'
import { dataOf, record, resolveRealUserID, signedPublicGateway } from './gateway.ts'

/** 每天几点签到（本地时间）。 */
export const MINIMAX_CHECKIN_HOUR = 10
export const MINIMAX_CHECKIN_MINUTE = 0

/** 公开网关上的两条地址（上游 `packages/tui/src/checkin/http-gateway.ts`）。 */
const STATUS_PATH = '/minimax-cloud/api/v1/signin/status'
const CLAIM_PATH = '/minimax-cloud/api/v1/signin/claim'

/** 面板里每一天的状态（上游 `SigninDayStatus`）。 */
export const SigninDayStatus = {
  Upcoming: 1,
  Claimable: 2,
  Claimed: 3,
  Disabled: 4,
} as const
export type SigninDayStatus = (typeof SigninDayStatus)[keyof typeof SigninDayStatus]

/** 领取的结果（上游 `SigninClaimResult`）。 */
export const SigninClaimResult = {
  Claimed: 1,
  AlreadyClaimed: 2,
} as const
export type SigninClaimResult = (typeof SigninClaimResult)[keyof typeof SigninClaimResult]

/** 面板整体的样子（上游 `SigninPanelScene`）。 */
export const SigninPanelScene = {
  Unknown: 0,
  First: 1,
  Active: 2,
  Completed: 3,
  Broken: 4,
} as const
export type SigninPanelScene = (typeof SigninPanelScene)[keyof typeof SigninPanelScene]

/** 面板里的一天。 */
export type SigninDayItem = {
  /** 7 天一轮里的第几天（1..7）。 */
  readonly day_no: number
  /** 这一天的积分。 */
  readonly points: number
  /** 已经算进 points 的额外积分；老应答里没有这一项。 */
  readonly bonus_points?: number
  /** 这一天现在的状态。 */
  readonly status: SigninDayStatus
  /** 是不是今天。 */
  readonly is_today: boolean
}

/** 签到面板：7 天一轮。 */
export type SigninPanel = {
  readonly scene: SigninPanelScene
  readonly days: readonly SigninDayItem[]
}

/** 领一次的应答。 */
export type ClaimSigninData = {
  readonly claim_id: string
  readonly claim_result: SigninClaimResult
  readonly day_no: number
  readonly points: number
  /** 这笔积分什么时候过期（上游给的是毫秒）。 */
  readonly expire_at_ms: number
  readonly panel: SigninPanel
}

/** 一次签到调用要什么。 */
export type MiniMaxCheckinRequest = {
  readonly signal?: AbortSignal
  /** 现成的凭据；不给就从本机 MiniMax Code 登录解析。 */
  readonly credential?: MiniMaxCredential
  /** `resolveCredential` 的覆盖项；测试用它避开真实登录。 */
  readonly credentialOverrides?: CredentialOverrides
  readonly fetchImpl?: typeof fetch
}

/** 定时器要的东西。 */
export type MiniMaxCheckinSchedule = {
  /** 排一次延迟调用。 */
  setTimeout(fn: () => void, ms: number): unknown
  /** 撤掉一次延迟调用。 */
  clearTimeout(handle: unknown): void
}

/** 一轮签到的结果。 */
export type MiniMaxCheckinOutcome = {
  /** 今天领到了。 */
  readonly claimed: boolean
  /** 今天已经领过了（不是失败）。 */
  readonly alreadyClaimed: boolean
  /** 今天不可领（比如今天的份额还没开始）。 */
  readonly notClaimable: boolean
  /** 领到多少积分。 */
  readonly points?: number
  /** 领的是第几天。 */
  readonly dayNo?: number
  /** 连续签到多少天。 */
  readonly streakDays?: number
  /** 这笔积分什么时候过期（毫秒）。 */
  readonly expiresAtMs?: number
}

/** 定时领取要的东西。 */
export type MiniMaxCheckinSchedulerOptions = {
  /**
   * 取凭据。返回 `undefined` 表示没登录——那时什么都不做。
   *
   * 用函数而不是一份凭据：定时触发时才取一次，中途登录了也能领上。
   */
  readonly credential: () => Promise<MiniMaxCredential | undefined>
  readonly fetchImpl?: typeof fetch
  /** 现在几点；缺省取系统时间。 */
  readonly now?: () => Date
  /** 定时器立桩。 */
  readonly schedule?: MiniMaxCheckinSchedule
  /** 每天几点（本地时间）。 */
  readonly hour?: number
  readonly minute?: number
  /** 领完之后的回调（宿主用它记一条日志、发一条通知）。 */
  readonly onClaimed?: ((outcome: MiniMaxCheckinOutcome) => void) | undefined
  /** 出错时的回调。 */
  readonly onError?: ((error: unknown) => void) | undefined
}

/**
 * 查今天的签到面板。
 *
 * @param request - 凭据/网络覆盖项。
 * @returns 面板（7 天一轮）。
 */
export async function fetchSigninPanel(request: MiniMaxCheckinRequest = {}): Promise<SigninPanel> {
  const credential = request.credential ?? await resolveCredential(request.credentialOverrides ?? {})
  const fetchImpl = request.fetchImpl ?? fetch
  const realUserID = await resolveRealUserID(credential, fetchImpl, request.signal)
  const body = await signedPublicGateway(
    credential,
    { path: STATUS_PATH, method: 'GET', realUserID, appVersion: miniMaxCodeVersion() },
    fetchImpl,
    request.signal,
  )
  assertEnvelope(body)
  return validateSigninPanel(dataOf(body))
}

/**
 * 领一次当天的积分。
 *
 * 今天已经领过不算失败：应答里的 `claim_result` 会是「已领过」。
 * @param request - 凭据/网络覆盖项。
 * @returns 领取应答。
 */
export async function claimSignin(request: MiniMaxCheckinRequest = {}): Promise<ClaimSigninData> {
  const credential = request.credential ?? await resolveCredential(request.credentialOverrides ?? {})
  const fetchImpl = request.fetchImpl ?? fetch
  const realUserID = await resolveRealUserID(credential, fetchImpl, request.signal)
  const body = await signedPublicGateway(
    credential,
    { path: CLAIM_PATH, method: 'POST', payload: {}, realUserID, appVersion: miniMaxCodeVersion() },
    fetchImpl,
    request.signal,
  )
  assertEnvelope(body)
  return validateClaimSigninData(dataOf(body))
}

/** 面板里今天是不是已经领过了。 */
export function isPanelClaimedToday(panel: SigninPanel): boolean {
  return panel.days.some(day => day.is_today && day.status === SigninDayStatus.Claimed)
}

/** 面板里今天能不能领。 */
export function isPanelClaimable(panel: SigninPanel): boolean {
  return panel.days.some(day => day.status === SigninDayStatus.Claimable)
}

/**
 * 连续签到多少天（上游 `getCurrentSigninStreak`）。
 *
 * 今天已领：从今天往回数；今天可领但还没领：从昨天往回数；今天不可领：没有连续。
 * @param days - 面板里的 7 天。
 * @returns 连续天数。
 */
export function currentStreak(days: readonly SigninDayItem[]): number {
  const sorted = [...days].sort((left, right) => left.day_no - right.day_no)
  const todayIndex = sorted.findIndex(day => day.is_today)
  if (todayIndex < 0) return 0
  const todayStatus = sorted[todayIndex]?.status
  let index = todayStatus === SigninDayStatus.Claimed
    ? todayIndex
    : todayStatus === SigninDayStatus.Claimable
      ? todayIndex - 1
      : -1
  if (index < 0) return 0
  let streak = 0
  for (; index >= 0; index -= 1) {
    if (sorted[index]?.status !== SigninDayStatus.Claimed) break
    streak += 1
  }
  return streak
}

/**
 * 距离下一个「每天几点」还有多少毫秒。
 *
 * 今天还没到就等今天；今天已经过了就等明天。用本地时间算，跨月跨年也对得上。
 * @param now - 现在。
 * @param hour - 小时（本地时间）。
 * @param minute - 分钟。
 * @returns 毫秒数。
 */
export function nextRunDelay(now: Date, hour: number, minute: number): number {
  const target = new Date(now.getTime())
  target.setHours(hour, minute, 0, 0)
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1)
    target.setHours(hour, minute, 0, 0)
  }
  return target.getTime() - now.getTime()
}

/**
 * 现在该不该补签（今天的那个点已经过了）。
 * @param now - 现在。
 * @param hour - 小时（本地时间）。
 * @param minute - 分钟。
 * @returns 该补签时为 true。
 */
export function shouldCatchUp(now: Date, hour: number, minute: number): boolean {
  const target = new Date(now.getTime())
  target.setHours(hour, minute, 0, 0)
  return target.getTime() <= now.getTime()
}

/**
 * 起一个每天定点领取的定时器。
 *
 * 行为：
 * - 装载时若已经过了今天的那个点、且今天还没签 → 当场补签一次；
 * - 每天到点触发一次：先查状态，已签就跳过；
 * - 没登录就安静跳过（一个请求都不发）。
 *
 * 返回一个停掉它的函数。
 * @param options - 凭据取法、定时器立桩与回调。
 * @returns 停掉定时器的函数。
 */
export function startDailyCheckin(options: MiniMaxCheckinSchedulerOptions): () => void {
  const now = options.now ?? (() => new Date())
  const hour = options.hour ?? MINIMAX_CHECKIN_HOUR
  const minute = options.minute ?? MINIMAX_CHECKIN_MINUTE
  const schedule = options.schedule ?? defaultSchedule()
  let stopped = false
  let handle: unknown

  const run = async (): Promise<void> => {
    if (stopped) return
    try {
      const credential = await options.credential()
      // 没登录：什么都不做，也不吵。
      if (credential === undefined) return
      const panel = await fetchSigninPanel({
        credential,
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      })
      if (isPanelClaimedToday(panel)) {
        options.onClaimed?.({ claimed: false, alreadyClaimed: true, notClaimable: false })
        return
      }
      if (!isPanelClaimable(panel)) {
        options.onClaimed?.({ claimed: false, alreadyClaimed: false, notClaimable: true })
        return
      }
      const result = await claimSignin({
        credential,
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      })
      options.onClaimed?.({
        claimed: result.claim_result === SigninClaimResult.Claimed,
        alreadyClaimed: result.claim_result === SigninClaimResult.AlreadyClaimed,
        notClaimable: false,
        points: result.points,
        dayNo: result.day_no,
        streakDays: currentStreak(result.panel.days),
        expiresAtMs: result.expire_at_ms,
      })
    } catch (error) {
      options.onError?.(error)
    }
  }

  const arm = (): void => {
    if (stopped) return
    handle = schedule.setTimeout(() => {
      void run().finally(() => { arm() })
    }, nextRunDelay(now(), hour, minute))
  }

  // 装载时的补签：过了点才补，没到点就老实等到点。
  if (shouldCatchUp(now(), hour, minute)) void run()
  arm()

  return () => {
    stopped = true
    if (handle !== undefined) schedule.clearTimeout(handle)
  }
}

/** 真的定时器；句柄 unref，免得它把宿主进程钉住。 */
function defaultSchedule(): MiniMaxCheckinSchedule {
  return {
    setTimeout: (fn, ms) => {
      const handle = setTimeout(fn, ms)
      if (typeof (handle as { unref?: () => void }).unref === 'function') {
        (handle as { unref: () => void }).unref()
      }
      return handle
    },
    clearTimeout: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>) },
  }
}

/**
 * 应答的外层信封：`base_resp.status_code` 不是 0 就是失败（上游同款判断）。
 * @param body - 上游应答。
 */
function assertEnvelope(body: unknown): void {
  const base = record(record(body)?.['base_resp'])
  const statusCode = base?.['status_code']
  if (typeof statusCode === 'number' && statusCode !== 0) {
    const message = base?.['status_msg']
    throw new Error(typeof message === 'string' && message.trim() !== ''
      ? `MiniMax 签到请求失败：${message.trim()}`
      : `MiniMax 签到请求失败（${String(statusCode)}）`)
  }
}

/**
 * 面板的校验规则，抄自上游 `packages/shared/src/daily-signin.ts`。
 * @param value - 上游应答里的面板。
 * @returns 校验过的面板。
 */
export function validateSigninPanel(value: unknown): SigninPanel {
  const panel = value as Partial<SigninPanel> | null
  const days = panel?.days
  const dayNumbers = new Set<number>()
  let claimableDays = 0
  let todayDays = 0
  const validDays = Array.isArray(days) && days.length === 7 && days.every(day => {
    if (!day || typeof day !== 'object') return false
    const item = day as Partial<SigninDayItem>
    const dayNo = item.day_no
    if (typeof dayNo !== 'number' || !Number.isInteger(dayNo) || dayNo < 1 || dayNo > 7 || dayNumbers.has(dayNo)) {
      return false
    }
    if (typeof item.points !== 'number' || !Number.isFinite(item.points) || item.points < 0) return false
    if (item.bonus_points !== undefined && (typeof item.bonus_points !== 'number' || !Number.isFinite(item.bonus_points) || item.bonus_points < 0)) {
      return false
    }
    if (typeof item.is_today !== 'boolean') return false
    if (!isDayStatus(item.status)) return false
    dayNumbers.add(dayNo)
    if (item.status === SigninDayStatus.Claimable) claimableDays += 1
    if (item.is_today) todayDays += 1
    return true
  })
  if (panel === null || typeof panel !== 'object' || !isPanelScene(panel.scene) || !validDays || claimableDays > 1 || todayDays > 1) {
    throw new Error('Invalid sign-in panel')
  }
  return panel as SigninPanel
}

/**
 * 领取应答的校验规则，抄自上游 `packages/shared/src/daily-signin.ts`。
 * @param value - 上游应答。
 * @returns 校验过的领取应答。
 */
export function validateClaimSigninData(value: unknown): ClaimSigninData {
  const data = value as Partial<ClaimSigninData> | null
  const valid = data !== null
    && typeof data === 'object'
    && typeof data.claim_id === 'string'
    && data.claim_id.length > 0
    && isClaimResult(data.claim_result)
    && Number.isInteger(data.day_no)
    && (data.day_no ?? 0) >= 1
    && (data.day_no ?? 8) <= 7
    && typeof data.points === 'number'
    && Number.isFinite(data.points)
    && data.points >= 0
    && typeof data.expire_at_ms === 'number'
    && Number.isFinite(data.expire_at_ms)
  if (!valid) throw new Error('Invalid sign-in claim response')
  return { ...data, panel: validateSigninPanel(data.panel) } as ClaimSigninData
}

function isDayStatus(value: unknown): value is SigninDayStatus {
  return value === SigninDayStatus.Upcoming
    || value === SigninDayStatus.Claimable
    || value === SigninDayStatus.Claimed
    || value === SigninDayStatus.Disabled
}

function isClaimResult(value: unknown): value is SigninClaimResult {
  return value === SigninClaimResult.Claimed || value === SigninClaimResult.AlreadyClaimed
}

function isPanelScene(value: unknown): value is SigninPanelScene {
  return value === SigninPanelScene.Unknown
    || value === SigninPanelScene.First
    || value === SigninPanelScene.Active
    || value === SigninPanelScene.Completed
    || value === SigninPanelScene.Broken
}

/** MiniMax Code 的版本号：请求头里的 `desktop_version` 要用它。 */
let cachedVersion: string | undefined

function miniMaxCodeVersion(): string {
  if (cachedVersion !== undefined) return cachedVersion
  cachedVersion = readMiniMaxCodeVersion()
  return cachedVersion
}

function readMiniMaxCodeVersion(): string {
  try {
    const out = execFileSync(
      '/usr/libexec/PlistBuddy',
      ['-c', 'Print CFBundleShortVersionString', '/Applications/MiniMax Code.app/Contents/Info.plist'],
      { encoding: 'utf8' },
    )
    const trimmed = out.trim()
    return trimmed === '' ? '0.0.0' : trimmed
  } catch {
    return '0.0.0'
  }
}
