/**
 * WorkBuddy 的「套餐与积分」：宿主侧读取与折算。
 *
 * 站点上有一个接口管这件事（官方客户端的设置页那一块就是它）：
 * `POST {端点}/billing/meter/get-user-resource-summary`（这一条**不带** `/v2`）。
 * 回���里有三样：
 * - `SubscriptionPackageName`：套餐名（如「体验版」）；
 * - `CreditGroups[]`：积分构成——套餐基础／套餐赠送／购买／平台奖励，各带总额、
 *   剩余、已用；
 * - `TotalCredits`：总积分（当前可用）。
 *
 * 这里钉住的是折算口径：**总额度**是各类总额加起来（不是 `TotalCredits`），
 * `TotalCredits` 是当前可用；两类数不一样，别混。
 */

import { describe, expect, it } from 'vitest'
import { fetchWorkBuddyCredits } from '../src/workbuddy/credits.ts'
import type { WorkBuddyCredential } from '../src/workbuddy/credential.ts'

const credential: WorkBuddyCredential = {
  accessToken: 'TOKEN-1',
  account: { uid: 'uid-1' },
}

/** 一份「站点应答」。 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** 一份真实形状的应答（数值取自 2026-11-05 真机抓的）。 */
const PAYLOAD = {
  code: 0,
  data: {
    Packages: [],
    TotalCredits: '1766.43000002',
    SubscriptionPackageCode: '',
    SubscriptionPackageName: '体验版',
    IsPaidUser: false,
    IsProtectedPriceUser: false,
    CreditGroups: [
      { Kind: 'plan_base', Name: '套餐基础积分', CycleTotalCapacity: '500', CycleRemainCapacity: '500', CycleUsedCapacity: '0', CycleFrozenCapacity: '0', CapacityUnit: 'credits', TotalCount: 1 },
      { Kind: 'plan_bonus', Name: '套餐赠送积分', CycleTotalCapacity: '0', CycleRemainCapacity: '0', CycleUsedCapacity: '0', CycleFrozenCapacity: '0', CapacityUnit: 'credits', TotalCount: 0 },
      { Kind: 'addon', Name: '购买积分', CycleTotalCapacity: '0', CycleRemainCapacity: '0', CycleUsedCapacity: '0', CycleFrozenCapacity: '0', CapacityUnit: 'credits', TotalCount: 0 },
      { Kind: 'benefit', Name: '平台奖励积分', CycleTotalCapacity: '1300', CycleRemainCapacity: '1266.43000002', CycleUsedCapacity: '33.56999998', CycleFrozenCapacity: '0', CapacityUnit: 'credits', TotalCount: 13 },
    ],
  },
}

describe('套餐与积分', () => {
  it('POST 到套餐与积分那条地址，带鉴权与账号头', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const fetchImpl: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} })
      return jsonResponse(PAYLOAD)
    }

    await fetchWorkBuddyCredits({ credential, fetchImpl })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://www.workbuddy.cn/billing/meter/get-user-resource-summary')
    expect(calls[0]?.init.method).toBe('POST')
    const headers = calls[0]?.init.headers as Record<string, string>
    expect(headers['authorization']).toBe('Bearer TOKEN-1')
    expect(headers['x-user-id']).toBe('uid-1')
  })

  it('折出套餐名、总积分、总额度与四类构成', async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse(PAYLOAD)
    const credits = await fetchWorkBuddyCredits({ credential, fetchImpl })

    expect(credits.plan).toBe('体验版')
    // TotalCredits 是当前可用（1766.43），不是总额度（1800）。
    expect(credits.remaining).toBeCloseTo(1766.43, 2)
    expect(credits.capacity).toBeCloseTo(1800, 2)
    expect(credits.used).toBeCloseTo(33.57, 2)
    expect(credits.groups).toHaveLength(4)
    expect(credits.groups[0]).toEqual({ kind: 'plan_base', name: '套餐基础积分', total: 500, remain: 500, used: 0 })
    expect(credits.groups[3]?.name).toBe('平台奖励积分')
    expect(credits.groups[3]?.remain).toBeCloseTo(1266.43, 2)
  })

  it('站点没给 CreditGroups 时按「没有积分」处理，不崩', async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse({ code: 0, data: { TotalCredits: '0' } })
    const credits = await fetchWorkBuddyCredits({ credential, fetchImpl })
    expect(credits.groups).toEqual([])
    expect(credits.remaining).toBe(0)
    expect(credits.capacity).toBe(0)
  })

  it('站点回业务错误时抛错，消息里没有令牌', async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse({ code: 12153, msg: 'token expired' })
    let message = ''
    try {
      await fetchWorkBuddyCredits({ credential, fetchImpl })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('12153')
    expect(message).not.toContain('TOKEN-1')
  })

  it('HTTP 失败时抛错，消息里没有令牌', async () => {
    const fetchImpl: typeof fetch = async () => new Response('boom TOKEN-1', { status: 500 })
    let message = ''
    try {
      await fetchWorkBuddyCredits({ credential, fetchImpl })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('500')
    expect(message).not.toContain('TOKEN-1')
    expect(message).toContain('[redacted]')
  })
})
