/**
 * WorkBuddy 的「套餐与积分」：套餐名、积分构成、总积分。
 *
 * 站点上管这件事的接口是 `POST {端点}/billing/meter/get-user-resource-summary`
 * （**这一条不带 `/v2`**——带了就 404，真机 2026-11-05 验过）。回应的 `data` 里：
 *
 * - `SubscriptionPackageName`：套餐名（如「体验版」）；
 * - `CreditGroups[]`：积分构成——套餐基础（plan_base）／套餐赠送（plan_bonus）／
 *   购买（addon）／平台奖励（benefit），每一类带总额、剩余、已用；
 * - `TotalCredits`：总积分（**当前可用**）。
 *
 * 两个口径别混：`TotalCredits` 是可用余额，各类「总额」加起来才是额度上限。
 * 这里把两个都算出来，界面与胶囊各自要用哪个就用哪个。
 *
 * 用的是同一份凭据、同一个基址（与登录、清单、模型请求同源）。令牌不出宿主。
 */

import { resolveEndpoints, workBuddyHeaders } from './endpoints.ts'
import type { WorkBuddyEndpoints } from './endpoints.ts'
import type { WorkBuddyCredential } from './credential.ts'

/** 一类积分（套餐基础／套餐赠送／购买／平台奖励）。 */
export type WorkBuddyCreditGroup = {
  /** 站点的分类标识：`plan_base` / `plan_bonus` / `addon` / `benefit`。 */
  readonly kind: string
  /** 中文名（如「套餐基础积分」）。 */
  readonly name: string
  /** 这一类的总额。 */
  readonly total: number
  /** 这一类还剩多少。 */
  readonly remain: number
  /** 这一类已经用了多少。 */
  readonly used: number
}

/** 套餐与积分的全貌。 */
export type WorkBuddyCredits = {
  /** 套餐名（如「体验版」）。 */
  readonly plan: string
  /** 当前可用的总积分。 */
  readonly remaining: number
  /** 额度上限：各类总额加起来。 */
  readonly capacity: number
  /** 已经用掉的积分。 */
  readonly used: number
  /** 积分构成（按站点的顺序）。 */
  readonly groups: readonly WorkBuddyCreditGroup[]
}

/** 这条接口要的东西。 */
export type WorkBuddyCreditsOptions = {
  /** 访问令牌与账号信息。 */
  readonly credential: WorkBuddyCredential
  /** 端点；缺省从基址派生。 */
  readonly endpoints?: WorkBuddyEndpoints | undefined
  /** fetch 实现；测试注入假件。 */
  readonly fetchImpl?: typeof fetch | undefined
}

/**
 * 取一次套餐与积分。
 * @param options - 凭据、端点与 fetch 实现。
 * @returns 套餐名、总数与积分构成。
 */
export async function fetchWorkBuddyCredits(options: WorkBuddyCreditsOptions): Promise<WorkBuddyCredits> {
  const endpoints = options.endpoints ?? resolveEndpoints()
  const fetchImpl = options.fetchImpl ?? fetch
  const token = options.credential.accessToken
  const uid = options.credential.account?.uid
  const response = await fetchImpl(endpoints.creditsUrl, {
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
  let parsed: unknown
  let isJson = true
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    isJson = false
  }
  if (!response.ok && (!isJson || typeof (parsed as Record<string, unknown>)['code'] !== 'number')) {
    throw new Error(`WorkBuddy 套餐与积分取不到（${String(response.status)}）：${scrub(text.slice(0, 300), token)}`)
  }
  if (!isJson) throw new Error('WorkBuddy 套餐与积分应答不是 JSON')
  const payload = recordOf(parsed)
  const code = numberOf(payload['code'])
  if (code !== 0) {
    throw new Error(`WorkBuddy 套餐与积分取不到（${String(code)}）：${messageOf(payload, '站点没给数据')}`)
  }
  const data = recordOf(payload['data'])
  const groups = groupsOf(data['CreditGroups'])
  const capacity = groups.reduce((sum, group) => sum + group.total, 0)
  const used = groups.reduce((sum, group) => sum + group.used, 0)
  const remainSum = groups.reduce((sum, group) => sum + group.remain, 0)
  const total = numberOf(data['TotalCredits'])
  return {
    plan: typeof data['SubscriptionPackageName'] === 'string' ? data['SubscriptionPackageName'] : '',
    // 站点给了总数就用它的；没给就按各类剩余加起来。
    remaining: total === 0 ? remainSum : total,
    capacity,
    used,
    groups,
  }
}

/** 积分构成（站点的数组）。 */
function groupsOf(value: unknown): readonly WorkBuddyCreditGroup[] {
  if (!Array.isArray(value)) return []
  const groups: WorkBuddyCreditGroup[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const kind = typeof item['Kind'] === 'string' ? item['Kind'] : ''
    const name = typeof item['Name'] === 'string' ? item['Name'] : kind
    if (kind === '' && name === '') continue
    groups.push({
      kind,
      name,
      total: numberOf(item['CycleTotalCapacity']),
      remain: numberOf(item['CycleRemainCapacity']),
      used: numberOf(item['CycleUsedCapacity']),
    })
  }
  return groups
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function recordOf(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

/** 站点的数字是字符串（`"1766.43000002"`）；读不出就当 0。 */
function numberOf(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}
