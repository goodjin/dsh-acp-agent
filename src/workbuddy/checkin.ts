/**
 * WorkBuddy 的每日签到：查状态、领当天积分。
 *
 * 站点上有两个接口（官方客户端里就是这么调的）：
 * - `POST {端点}/v2/billing/meter/checkin-activity-status` → 今天签没签、连续几天、
 *   每天多少积分；
 * - `POST {端点}/v2/billing/meter/daily-checkin` → 领一次。
 *
 * 用的是**同一份凭据**（`~/.dsh/workbuddy/credentials.json`），与模型请求一样；
 * 端点也从同一个基址派生——登录、清单、模型、签到四处同源，不同源就会重演
 * 「登录成功但每个请求都被拒」。
 *
 * 业务码与错误是两回事：
 * - `10001`（本机实测）/ `1001`（官方客户端的映射）= 今天已经领过了——那是
 *   「已经办完了」，不是错误。
 * - 其它非 0 码 = 今天领不到（不符合条件、活动已结束），原话报给人。
 *
 * 令牌不出现在任何一条消息里。
 */

import { resolveEndpoints, workBuddyHeaders } from './endpoints.ts'
import type { WorkBuddyEndpoints } from './endpoints.ts'
import type { WorkBuddyCredential } from './credential.ts'

/** 今天已经领过了：站点回的这个码（官方客户端那套映射是 1001）。 */
export const ALREADY_CLAIMED_CODES = [10001, 1001]

/** 签到状态（我们要的那几件事）。 */
export type WorkBuddyCheckinStatus = {
  /** 签到活动是否在进行。 */
  readonly active: boolean
  /** 今天是否已签。 */
  readonly todayCheckedIn: boolean
  /** 连续签到天数。 */
  readonly streakDays: number
  /** 每天给的积分。 */
  readonly dailyCredit: number
  /** 今天实际到手的积分。 */
  readonly todayCredit: number
  /** 今天是不是有额外奖励的那天。 */
  readonly isStreakDay: boolean
  /** 最近的签到日期。 */
  readonly checkinDates: readonly string[]
}

/** 领一次的结果。 */
export type WorkBuddyCheckinResult = {
  /** 这次真的领到了。 */
  readonly claimed: boolean
  /** 今天之前已经领过了（不是错误）。 */
  readonly alreadyClaimed: boolean
  /** 这次到手的积分。 */
  readonly credit: number
  /** 领完之后的连续天数。 */
  readonly streakDays: number
  /** 站点给的话（领不到时原话带回来）。 */
  readonly message?: string | undefined
}

/** 这两个接口要的东西。 */
export type WorkBuddyCheckinOptions = {
  /** 访问令牌与账号信息。 */
  readonly credential: WorkBuddyCredential
  /** 端点；缺省从基址派生。 */
  readonly endpoints?: WorkBuddyEndpoints | undefined
  /** fetch 实现；测试注入假件。 */
  readonly fetchImpl?: typeof fetch | undefined
}

/**
 * 查今天的签到状态。
 * @param options - 凭据、端点与 fetch 实现。
 * @returns 签到状态；站点没给字段的按默认值来。
 */
export async function fetchCheckinStatus(options: WorkBuddyCheckinOptions): Promise<WorkBuddyCheckinStatus> {
  const endpoints = options.endpoints ?? resolveEndpoints()
  const payload = await postJson(endpoints, options, endpoints.checkinStatusUrl)
  const code = numberOf(payload['code'])
  if (code !== 0) {
    throw new Error(`WorkBuddy 签到状态取不到（${String(code)}）：${messageOf(payload, '站点没给状态')}`)
  }
  const data = recordOf(payload['data'])
  return {
    active: booleanOf(data['active']),
    todayCheckedIn: booleanOf(data['today_checked_in']),
    streakDays: numberOf(data['streak_days']),
    dailyCredit: numberOf(data['daily_credit']),
    todayCredit: numberOf(data['today_credit']),
    isStreakDay: booleanOf(data['is_streak_day']),
    checkinDates: stringsOf(data['checkin_dates']),
  }
}

/**
 * 领一次当天积分。
 *
 * 今天已经领过不算失败：`claimed` 为 false、`alreadyClaimed` 为 true，站点的话
 * 原样带回来。
 * @param options - 凭据、端点与 fetch 实现。
 * @returns 领取结果。
 */
export async function claimDailyCheckin(options: WorkBuddyCheckinOptions): Promise<WorkBuddyCheckinResult> {
  const endpoints = options.endpoints ?? resolveEndpoints()
  const payload = await postJson(endpoints, options, endpoints.dailyCheckinUrl)
  const code = numberOf(payload['code'])
  const data = recordOf(payload['data'])
  if (code !== 0) {
    const message = messageOf(payload, `站点回 ${String(code)}`)
    return {
      claimed: false,
      alreadyClaimed: ALREADY_CLAIMED_CODES.includes(code),
      credit: 0,
      streakDays: 0,
      message,
    }
  }
  return {
    claimed: true,
    alreadyClaimed: false,
    credit: numberOf(data['credit']),
    streakDays: numberOf(data['streak_days']),
  }
}

/** 发一次 POST，把应答折成 `{code, msg, data}`。 */
async function postJson(
  endpoints: WorkBuddyEndpoints,
  options: WorkBuddyCheckinOptions,
  url: string,
): Promise<Record<string, unknown>> {
  const fetchImpl = options.fetchImpl ?? fetch
  const token = options.credential.accessToken
  const uid = options.credential.account?.uid
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: workBuddyHeaders({
      'content-type': 'application/json',
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      ...(uid === undefined || uid === '' ? {} : { 'x-user-id': uid }),
    }),
    body: JSON.stringify({}),
  })
  const text = await response.text().catch(() => '')
  if (!response.ok) {
    throw new Error(`WorkBuddy 签到请求失败（${String(response.status)}）：${scrub(text.slice(0, 300), token)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    throw new Error('WorkBuddy 签到应答不是 JSON')
  }
  return recordOf(parsed)
}

/** 把令牌从要给人看的文字里抹掉。 */
function scrub(text: string, token: string): string {
  if (token === '') return text
  return text.split(token).join('[redacted]')
}

function messageOf(payload: Record<string, unknown>, fallback: string): string {
  const msg = payload['msg']
  return typeof msg === 'string' && msg !== '' ? msg : fallback
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function booleanOf(value: unknown): boolean {
  return value === true
}

function stringsOf(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}
