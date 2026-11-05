/**
 * WorkBuddy 的每日签到：查状态与领当天积分。
 *
 * 这一层钉的是「跟站点说话的形状」：打哪个地址、带哪些头、应答怎么折成我们要的
 * 几件事（今天签没签、连续几天、每天多少积分）。
 *
 * 失败路径各有各的脾气：
 * - 业务码非 0：不是「崩了」，是站点在说今天领不到（已领过 / 不符合条件 / 活动结束）。
 *   「已领过」单独认出来——那不是错误，是「已经办完了」。
 * - HTTP 失败：网络或服务端的问题，照实报，消息里不能有令牌。
 */

import { describe, expect, it } from 'vitest'
import { claimDailyCheckin, fetchCheckinStatus } from '../src/workbuddy/checkin.ts'
import type { WorkBuddyCredential } from '../src/workbuddy/credential.ts'

const credential: WorkBuddyCredential = {
  accessToken: 'TOKEN-1',
  account: { uid: 'uid-1' },
}

/** 一份「站点应答」。 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('查签到状态', () => {
  it('POST 到签到地址，带鉴权与账号头', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const fetchImpl: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} })
      return jsonResponse({ code: 0, data: { today_checked_in: true } })
    }

    await fetchCheckinStatus({ credential, fetchImpl })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://www.workbuddy.cn/v2/billing/meter/checkin-activity-status')
    expect(calls[0]?.init.method).toBe('POST')
    const headers = calls[0]?.init.headers as Record<string, string>
    expect(headers['authorization']).toBe('Bearer TOKEN-1')
    expect(headers['x-user-id']).toBe('uid-1')
    expect(headers['user-agent']).toMatch(/^WorkBuddy\//)
  })

  it('应答折成状态：签没签、连续几天、每天多少积分', async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse({
      code: 0,
      data: {
        active: true,
        today_checked_in: true,
        streak_days: 13,
        daily_credit: 100,
        today_credit: 100,
        is_streak_day: false,
        checkin_dates: ['2026-11-05', '2026-11-02'],
      },
    })

    const status = await fetchCheckinStatus({ credential, fetchImpl })

    expect(status.active).toBe(true)
    expect(status.todayCheckedIn).toBe(true)
    expect(status.streakDays).toBe(13)
    expect(status.dailyCredit).toBe(100)
    expect(status.todayCredit).toBe(100)
    expect(status.isStreakDay).toBe(false)
    expect(status.checkinDates).toEqual(['2026-11-05', '2026-11-02'])
  })

  it('缺字段时按默认值来，不崩', async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse({ code: 0, data: {} })
    const status = await fetchCheckinStatus({ credential, fetchImpl })
    expect(status.active).toBe(false)
    expect(status.todayCheckedIn).toBe(false)
    expect(status.streakDays).toBe(0)
    expect(status.dailyCredit).toBe(0)
    expect(status.checkinDates).toEqual([])
  })

  it('站点回业务错误时抛错，消息里没有令牌', async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse({ code: 12153, msg: 'token expired' })
    let message = ''
    try {
      await fetchCheckinStatus({ credential, fetchImpl })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('12153')
    expect(message).not.toContain('TOKEN-1')
  })
})

describe('领当天积分', () => {
  it('POST 到领取地址，空体', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const fetchImpl: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} })
      return jsonResponse({ code: 0, data: { credit: 100, streak_days: 14, is_streak_day: false } })
    }

    const result = await claimDailyCheckin({ credential, fetchImpl })

    expect(calls[0]?.url).toBe('https://www.workbuddy.cn/v2/billing/meter/daily-checkin')
    expect(calls[0]?.init.method).toBe('POST')
    expect(String(calls[0]?.init.body)).toBe('{}')
    expect(result.claimed).toBe(true)
    expect(result.credit).toBe(100)
    expect(result.streakDays).toBe(14)
  })

  it('今天已领过（站点回 10001）算「已经办完了」，不是错误', async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse({ code: 10001, msg: '今天已签到，请明天再来' })
    const result = await claimDailyCheckin({ credential, fetchImpl })
    expect(result.claimed).toBe(false)
    expect(result.alreadyClaimed).toBe(true)
    expect(result.message).toBe('今天已签到，请明天再来')
  })

  it('官方客户端那套码（1001）也认成「已经办完了」', async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse({ code: 1001, msg: '已领取' })
    const result = await claimDailyCheckin({ credential, fetchImpl })
    expect(result.alreadyClaimed).toBe(true)
    expect(result.claimed).toBe(false)
  })

  it('其它业务码原话报给人', async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse({ code: 1003, msg: '活动已结束' })
    const result = await claimDailyCheckin({ credential, fetchImpl })
    expect(result.claimed).toBe(false)
    expect(result.alreadyClaimed).toBe(false)
    expect(result.message).toBe('活动已结束')
  })

  it('HTTP 失败时抛错，消息里没有令牌', async () => {
    const fetchImpl: typeof fetch = async () => new Response('boom TOKEN-1', { status: 500 })
    let message = ''
    try {
      await claimDailyCheckin({ credential, fetchImpl })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('500')
    expect(message).not.toContain('TOKEN-1')
    expect(message).toContain('[redacted]')
  })
})
