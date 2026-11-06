/**
 * MiniMax 每日签到：面板/领取的校验、定时器的行为，以及飞书通知那一条。
 */

import { describe, expect, it } from 'vitest'
import {
  MINIMAX_CHECKIN_HOUR,
  MINIMAX_CHECKIN_MINUTE,
  SigninClaimResult,
  SigninDayStatus,
  claimSignin,
  currentStreak,
  fetchSigninPanel,
  isPanelClaimable,
  isPanelClaimedToday,
  nextRunDelay,
  shouldCatchUp,
  startDailyCheckin,
  validateClaimSigninData,
  validateSigninPanel,
} from '../src/minimaxi/checkin.ts'
import type { MiniMaxCheckinSchedule } from '../src/minimaxi/checkin.ts'
import { sendFeishuNotification } from '../src/minimaxi/notify.ts'
import type { MiniMaxCredential } from '../src/minimaxi/credential.ts'

const CREDENTIAL: MiniMaxCredential = {
  accessToken: 'test-token-abcdefgh',
  expiresAtMs: Date.now() + 3_600_000,
  region: 'cn',
  buildEnv: 'prod',
  baseUrl: 'https://agent.minimax.cn/mavis/api/v1/llm/v1',
}

type Day = {
  day_no: number
  points: number
  bonus_points?: number
  status: SigninDayStatus
  is_today: boolean
}

function day(day_no: number, status: SigninDayStatus, points = 400, is_today = false): Day {
  return { day_no, points, status, is_today }
}

function panel(days: Day[]): { scene: number; days: Day[] } {
  return { scene: 4, days }
}

/** 七天一轮的面板：今天可领。 */
function claimablePanel(): { scene: number; days: Day[] } {
  return panel([
    day(1, SigninDayStatus.Claimable, 400, true),
    day(2, SigninDayStatus.Upcoming),
    day(3, SigninDayStatus.Upcoming),
    day(4, SigninDayStatus.Upcoming, 1000),
    day(5, SigninDayStatus.Upcoming),
    day(6, SigninDayStatus.Upcoming),
    day(7, SigninDayStatus.Upcoming, 1000),
  ])
}

/** 七天一轮的面板：今天已经领过了。 */
function claimedPanel(): { scene: number; days: Day[] } {
  return panel([
    day(1, SigninDayStatus.Claimed, 400, true),
    day(2, SigninDayStatus.Upcoming),
    day(3, SigninDayStatus.Upcoming),
    day(4, SigninDayStatus.Upcoming, 1000),
    day(5, SigninDayStatus.Upcoming),
    day(6, SigninDayStatus.Upcoming),
    day(7, SigninDayStatus.Upcoming, 1000),
  ])
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/**
 * 一个假的上游：认 `/v1/api/user/info` 与签到的两条地址。
 * @param statusPanel - 状态接口答什么。
 * @param claimBody - 领取接口答什么。
 * @param calls - 收到的请求。
 */
type Call = { url: string; method: string; headers: Record<string, string>; body?: string }

function fakeFetch(
  statusPanel: unknown,
  claimBody: unknown,
  calls: Call[] = [],
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    const method = init?.method ?? 'GET'
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.push({ url, method, headers, body: init?.body as string | undefined })
    if (url.includes('/v1/api/user/info')) {
      return jsonResponse({ data: { userInfo: { realUserID: '483260861993279496' } } })
    }
    if (url.includes('/signin/status')) return jsonResponse({ base_resp: { status_code: 0 }, data: statusPanel })
    if (url.includes('/signin/claim')) return jsonResponse({ base_resp: { status_code: 0 }, data: claimBody })
    throw new Error(`unexpected request: ${method} ${url}`)
  }) as typeof fetch
}

describe('面板与领取应答的校验', () => {
  it('合法面板原样通过', () => {
    const source = claimablePanel()
    const parsed = validateSigninPanel(source)
    expect(parsed.days).toHaveLength(7)
    expect(isPanelClaimable(parsed)).toBe(true)
    expect(isPanelClaimedToday(parsed)).toBe(false)
  })

  it('天数不是 7 就不是面板', () => {
    expect(() => validateSigninPanel(panel([day(1, SigninDayStatus.Claimable, 400, true)]))).toThrow(/Invalid sign-in panel/)
  })

  it('day_no 越界不是面板', () => {
    const days = claimablePanel().days
    days[0] = { ...days[0]!, day_no: 8 }
    expect(() => validateSigninPanel({ scene: 4, days })).toThrow(/Invalid sign-in panel/)
  })

  it('状态不认识不是面板', () => {
    const days = claimablePanel().days
    days[0] = { ...days[0]!, status: 9 as SigninDayStatus }
    expect(() => validateSigninPanel({ scene: 4, days })).toThrow(/Invalid sign-in panel/)
  })

  it('领取应答缺 claim_id 就不是领取应答', () => {
    expect(() => validateClaimSigninData({ claim_result: 1, day_no: 1, points: 400, expire_at_ms: 1, panel: claimablePanel() }))
      .toThrow(/Invalid sign-in claim response/)
  })

  it('领取应答带上面板一起校验', () => {
    const parsed = validateClaimSigninData({
      claim_id: 'claim-1',
      claim_result: SigninClaimResult.Claimed,
      day_no: 1,
      points: 400,
      expire_at_ms: 1_800_000_000_000,
      panel: claimedPanel(),
    })
    expect(parsed.points).toBe(400)
    expect(parsed.panel.days).toHaveLength(7)
  })
})

describe('连续签到天数', () => {
  it('今天已领：从今天往回数（含今天）', () => {
    const days = [
      day(1, SigninDayStatus.Claimed),
      day(2, SigninDayStatus.Claimed),
      day(3, SigninDayStatus.Claimed, 400, true),
      day(4, SigninDayStatus.Upcoming),
    ]
    expect(currentStreak(days)).toBe(3)
  })

  it('今天可领但还没领：昨天算起', () => {
    const days = [
      day(1, SigninDayStatus.Claimed),
      day(2, SigninDayStatus.Claimable, 400, true),
      day(3, SigninDayStatus.Upcoming),
    ]
    expect(currentStreak(days)).toBe(1)
  })

  it('今天不可领：没有连续', () => {
    const days = [
      day(1, SigninDayStatus.Claimed),
      day(2, SigninDayStatus.Upcoming, 400, true),
    ]
    expect(currentStreak(days)).toBe(0)
  })
})

describe('查面板与领取', () => {
  it('状态接口：GET 公开网关那条地址，带 Bearer 与两枚签名头', async () => {
    const calls: Call[] = []
    const fetchImpl = fakeFetch(claimablePanel(), {}, calls)
    const result = await fetchSigninPanel({ credential: CREDENTIAL, fetchImpl: fetchImpl as typeof fetch })
    expect(result.days).toHaveLength(7)
    const status = calls.find(call => call.url.includes('/signin/status'))
    expect(status?.method).toBe('GET')
    expect(status?.url).toContain('/minimax-cloud/api/v1/signin/status')
    expect(status?.headers['Authorization']).toBe('Bearer test-token-abcdefgh')
    expect(typeof status?.headers['yy']).toBe('string')
    expect(typeof status?.headers['x-signature']).toBe('string')
    // 取用户 id 那一步是 GET——写成 POST 会被网关当成不存在的路由（404）。
    expect(calls.find(call => call.url.includes('/v1/api/user/info'))?.method).toBe('GET')
  })

  it('领取接口：POST 同一条公开网关，空体', async () => {
    const calls: Call[] = []
    const fetchImpl = fakeFetch(claimablePanel(), {
      claim_id: 'claim-1',
      claim_result: SigninClaimResult.Claimed,
      day_no: 1,
      points: 400,
      expire_at_ms: 1_800_000_000_000,
      panel: claimedPanel(),
    }, calls)
    const result = await claimSignin({ credential: CREDENTIAL, fetchImpl: fetchImpl as typeof fetch })
    expect(result.claim_result).toBe(SigninClaimResult.Claimed)
    const claim = calls.find(call => call.url.includes('/signin/claim'))
    expect(claim?.method).toBe('POST')
    expect(claim?.body).toBe('{}')
  })

  it('外层信封说失败就是失败', async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/v1/api/user/info')) {
        return jsonResponse({ data: { userInfo: { realUserID: '1' } } })
      }
      return jsonResponse({ base_resp: { status_code: 4001, status_msg: '今天不能签' }, data: null })
    }) as typeof fetch
    await expect(fetchSigninPanel({ credential: CREDENTIAL, fetchImpl })).rejects.toThrow(/今天不能签/)
  })
})

describe('每天定时的那个定时器', () => {
  /** 一个假定时器：记下排过的延迟，并能手动触发。 */
  function fakeSchedule(): MiniMaxCheckinSchedule & { fire: () => void } {
    let pending: (() => void) | undefined
    return {
      setTimeout: (fn: () => void) => {
        pending = fn
        return pending
      },
      clearTimeout: () => { pending = undefined },
      fire: () => { pending?.() },
    }
  }

  it('没登录：一个请求都不发', async () => {
    const calls: unknown[] = []
    const fetchImpl = fakeFetch(claimablePanel(), {}, calls as never)
    const claimed: unknown[] = []
    startDailyCheckin({
      credential: async () => undefined,
      fetchImpl: fetchImpl as typeof fetch,
      now: () => new Date('2026-11-07T11:00:00'),
      onClaimed: outcome => { claimed.push(outcome) },
    })
    await new Promise(resolve => { setTimeout(resolve, 10) })
    expect(calls).toHaveLength(0)
    expect(claimed).toHaveLength(0)
  })

  it('今天已经领过：不发领取请求', async () => {
    const calls: Call[] = []
    const fetchImpl = fakeFetch(claimedPanel(), {}, calls as never)
    const outcomes: { claimed: boolean; alreadyClaimed: boolean }[] = []
    startDailyCheckin({
      credential: async () => CREDENTIAL,
      fetchImpl: fetchImpl as typeof fetch,
      now: () => new Date('2026-11-07T11:00:00'),
      onClaimed: outcome => { outcomes.push(outcome) },
    })
    await new Promise(resolve => { setTimeout(resolve, 10) })
    expect(calls.some(call => call.url.includes('/signin/claim'))).toBe(false)
    expect(outcomes[0]).toMatchObject({ claimed: false, alreadyClaimed: true })
  })

  it('可领：领一次并报出积分与连续天数', async () => {
    const calls: Call[] = []
    const fetchImpl = fakeFetch(claimablePanel(), {
      claim_id: 'claim-1',
      claim_result: SigninClaimResult.Claimed,
      day_no: 1,
      points: 400,
      expire_at_ms: 1_800_000_000_000,
      panel: claimedPanel(),
    }, calls as never)
    const outcomes: { claimed: boolean; points?: number; dayNo?: number; streakDays?: number }[] = []
    startDailyCheckin({
      credential: async () => CREDENTIAL,
      fetchImpl: fetchImpl as typeof fetch,
      now: () => new Date('2026-11-07T11:00:00'),
      onClaimed: outcome => { outcomes.push(outcome) },
    })
    await new Promise(resolve => { setTimeout(resolve, 10) })
    expect(calls.some(call => call.url.includes('/signin/claim'))).toBe(true)
    expect(outcomes[0]).toMatchObject({ claimed: true, points: 400, dayNo: 1, streakDays: 1 })
  })

  it('过了点才装载：当场补签一次', async () => {
    const calls: Call[] = []
    const fetchImpl = fakeFetch(claimablePanel(), {
      claim_id: 'claim-1',
      claim_result: SigninClaimResult.Claimed,
      day_no: 1,
      points: 400,
      expire_at_ms: 1_800_000_000_000,
      panel: claimedPanel(),
    }, calls as never)
    startDailyCheckin({
      credential: async () => CREDENTIAL,
      fetchImpl: fetchImpl as typeof fetch,
      now: () => new Date('2026-11-07T11:00:00'),
    })
    await new Promise(resolve => { setTimeout(resolve, 10) })
    expect(calls.some(call => call.url.includes('/signin/claim'))).toBe(true)
  })

  it('没过点就装载：不补签，等着到点', async () => {
    const calls: Call[] = []
    const fetchImpl = fakeFetch(claimablePanel(), {}, calls as never)
    const schedule = fakeSchedule()
    startDailyCheckin({
      credential: async () => CREDENTIAL,
      fetchImpl: fetchImpl as typeof fetch,
      now: () => new Date('2026-11-07T09:00:00'),
      schedule,
    })
    await new Promise(resolve => { setTimeout(resolve, 10) })
    expect(calls).toHaveLength(0)
    schedule.fire()
    await new Promise(resolve => { setTimeout(resolve, 10) })
    expect(calls.some(call => call.url.includes('/signin/status'))).toBe(true)
  })

  it('上游出错：交给 onError，不抛出去', async () => {
    const fetchImpl = (async () => { throw new Error('network down') }) as typeof fetch
    const errors: string[] = []
    startDailyCheckin({
      credential: async () => CREDENTIAL,
      fetchImpl,
      now: () => new Date('2026-11-07T11:00:00'),
      onError: error => { errors.push(error instanceof Error ? error.message : String(error)) },
    })
    await new Promise(resolve => { setTimeout(resolve, 10) })
    expect(errors.join('\n')).toContain('network down')
  })

  it('停掉之后不再触发', async () => {
    const calls: Call[] = []
    const fetchImpl = fakeFetch(claimablePanel(), {}, calls as never)
    const schedule = fakeSchedule()
    const stop = startDailyCheckin({
      credential: async () => CREDENTIAL,
      fetchImpl: fetchImpl as typeof fetch,
      now: () => new Date('2026-11-07T09:00:00'),
      schedule,
    })
    stop()
    schedule.fire()
    await new Promise(resolve => { setTimeout(resolve, 10) })
    expect(calls).toHaveLength(0)
  })
})

describe('到点时间', () => {
  it('默认是每天 10:00', () => {
    expect(MINIMAX_CHECKIN_HOUR).toBe(10)
    expect(MINIMAX_CHECKIN_MINUTE).toBe(0)
  })

  it('没过点：等今天', () => {
    const now = new Date('2026-11-07T09:00:00')
    expect(nextRunDelay(now, 10, 0)).toBe(3_600_000)
    expect(shouldCatchUp(now, 10, 0)).toBe(false)
  })

  it('过了点：等明天', () => {
    const now = new Date('2026-11-07T11:00:00')
    expect(nextRunDelay(now, 10, 0)).toBe(23 * 3_600_000)
    expect(shouldCatchUp(now, 10, 0)).toBe(true)
  })
})

describe('飞书通知', () => {
  it('发得出去：ok', async () => {
    const result = await sendFeishuNotification('你好', {
      run: async () => ({ code: 0, stdout: JSON.stringify({ ok: true }), stderr: '' }),
    })
    expect(result.ok).toBe(true)
  })

  it('退出码不是 0：失败并带原因', async () => {
    const result = await sendFeishuNotification('你好', {
      run: async () => ({ code: 1, stdout: '', stderr: 'permission denied' }),
    })
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('permission denied')
  })

  it('应答里 ok 不是 true：算失败', async () => {
    const result = await sendFeishuNotification('你好', {
      run: async () => ({ code: 0, stdout: JSON.stringify({ ok: false, error: 'no permission' }), stderr: '' }),
    })
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('no permission')
  })

  it('开关关掉：跳过', async () => {
    const result = await sendFeishuNotification('你好', {
      env: { MINIMAX_CHECKIN_FEISHU: '0' },
      run: async () => { throw new Error('不该被调用') },
    })
    expect(result.skipped).toBe(true)
    expect(result.ok).toBe(false)
  })

  it('命令写对：收件人与 bot 身份', async () => {
    const seen: { command: string; args: string[] }[] = []
    await sendFeishuNotification('你好', {
      userId: 'ou_test',
      run: async (command, args) => {
        seen.push({ command, args })
        return { code: 0, stdout: JSON.stringify({ ok: true }), stderr: '' }
      },
    })
    expect(seen[0]?.args).toContain('--user-id')
    expect(seen[0]?.args).toContain('ou_test')
    expect(seen[0]?.args).toContain('--as')
    expect(seen[0]?.args).toContain('bot')
  })
})
