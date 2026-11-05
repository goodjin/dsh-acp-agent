/**
 * 设置里的「WorkBuddy 账号」段。
 *
 * 这一段只做两件事：问宿主「登了没」，以及在没登录时给一个能点开的授权地址。
 * 令牌不出宿主，所以浏览器这一侧从头到尾没有令牌——视图不读、应答里也不该有。
 *
 * 这里钉住：未登录时给出「去授权」；已登录时显示是谁；点授权时打的是登录那条
 * 路由、拿到的地址交给注入的开窗函数；刷新时打的是状态那条路由。
 */

import { describe, expect, it } from 'vitest'
import type { ReactElement } from 'react'
import {
  beginWorkBuddyLogin,
  claimWorkBuddyCheckin,
  pollUntilSignedIn,
  readWorkBuddyCheckin,
  readWorkBuddySession,
  WORKBUDDY_ACCOUNT_SECTION_ID,
  workBuddyAccountView,
  workBuddyCheckinView,
  workBuddySettingsView,
} from '../src/client/workbuddy-account-section.tsx'
import { modelChecklistView } from '../src/client/model-checklist.tsx'
import type { WorkBuddyAccountState } from '../src/client/workbuddy-account-section.tsx'

/** 按顺序收元素树里的文本。 */
function textOf(node: unknown): string {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node === null || typeof node !== 'object') return ''
  return textOf((node as { props?: { children?: unknown } }).props?.children)
}

/** 在元素树里找第一个满足条件的节点。 */
function find(node: unknown, match: (props: Record<string, unknown>) => boolean): ReactElement | undefined {
  if (node === null || typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, match)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  const element = node as ReactElement & { props?: Record<string, unknown> }
  if (element.props !== undefined && match(element.props)) return element
  return find(element.props?.children, match)
}

/** 假 fetch：一次应答。 */
function fakeFetch(body: unknown, calls: string[] = []): typeof fetch {
  return (async (url: string) => {
    calls.push(String(url))
    return new Response(JSON.stringify(body), { status: 200 })
  }) as unknown as typeof fetch
}

const LOGGED_OUT: WorkBuddyAccountState = { authenticated: false }

const LOGGED_IN: WorkBuddyAccountState = {
  authenticated: true,
  account: { uid: 'uid-1', nickname: '某人' },
}

describe('视图', () => {
  it('没登录时给出「去授权」', () => {
    const view = workBuddyAccountView({ state: LOGGED_OUT })
    const button = find(view, props => props['data-workbuddy-login'] === true)
    expect(button).toBeDefined()
    expect(textOf(view)).toContain('登录')
  })

  it('登上了显示是谁，不摆登录按钮（杵在那儿看着像在催你登录）', () => {
    const view = workBuddyAccountView({ state: LOGGED_IN })
    expect(find(view, props => props['data-workbuddy-login'] === true)).toBeUndefined()
  })

  it('视图里没有令牌可显示', () => {
    const view = workBuddyAccountView({ state: LOGGED_IN })
    expect(textOf(view)).not.toContain('token')
  })
})

describe('问宿主', () => {
  it('状态走会话那条路由', async () => {
    const calls: string[] = []
    const state = await readWorkBuddySession({ fetchImpl: fakeFetch({ ok: true, ...LOGGED_IN }, calls) })
    expect(calls[0]).toContain('/acp-agent/workbuddy/session')
    expect(state.authenticated).toBe(true)
  })

  it('没登录时是「未登录」，不是报错', async () => {
    const calls: string[] = []
    const state = await readWorkBuddySession({
      fetchImpl: fakeFetch({ ok: true, authenticated: false, needsLogin: true }, calls),
    })
    expect(state.authenticated).toBe(false)
  })

  it('登录走登录那条路由，并把地址交给开窗函数', async () => {
    const calls: string[] = []
    const opened: string[] = []
    const result = await beginWorkBuddyLogin({
      fetchImpl: fakeFetch({ ok: true, url: 'https://www.workbuddy.cn/login?state=st-1' }, calls),
      openUrl: url => { opened.push(url) },
    })
    expect(calls[0]).toContain('/acp-agent/workbuddy/login')
    expect(opened).toEqual(['https://www.workbuddy.cn/login?state=st-1'])
    expect(result.ok).toBe(true)
  })

  it('登录起不来时如实说，不装成成功', async () => {
    const opened: string[] = []
    const result = await beginWorkBuddyLogin({
      fetchImpl: fakeFetch({ ok: false, reason: '站点没给登录地址' }),
      openUrl: url => { opened.push(url) },
    })
    expect(result.ok).toBe(false)
    expect(opened).toEqual([])
  })
})

describe('授权之后', () => {
  it('连着问几次，登上了就停', async () => {
    const calls: string[] = []
    let answers = 0
    const fetchImpl = (async (url: string) => {
      calls.push(String(url))
      answers += 1
      const body = answers < 3 ? { ok: true, authenticated: false } : { ok: true, ...LOGGED_IN }
      return new Response(JSON.stringify(body), { status: 200 })
    }) as unknown as typeof fetch

    const state = await pollUntilSignedIn({ fetchImpl, attempts: 5, sleepImpl: async () => {} })
    expect(state.authenticated).toBe(true)
    expect(calls).toHaveLength(3)
  })

  it('一直问到底也没登上，就返回没登录', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ ok: true, authenticated: false }), { status: 200 })) as unknown as typeof fetch
    const state = await pollUntilSignedIn({ fetchImpl, attempts: 3, sleepImpl: async () => {} })
    expect(state.authenticated).toBe(false)
  })
})

describe('排版', () => {
  const MODELS = {
    models: [{ id: 'glm-5.3', name: 'GLM-5.3', credits: 'x0.69', supportsToolCall: true }],
    selected: ['glm-5.3'],
    custom: false,
    default: ['glm-5.3'],
  }

  it('账号信息在一个框里，独占一行', () => {
    const view = workBuddyAccountView({ state: LOGGED_IN })
    const box = find(view, props => props['data-workbuddy-account-box'] === true)
    expect(box).toBeDefined()
    const style = box?.props?.style as Record<string, unknown> | undefined
    expect(String(style?.['border'])).toContain('1px solid')
  })

  it('两个按钮一样大、留出间距、齐平', () => {
    const view = workBuddyAccountView({ state: LOGGED_OUT })
    const row = find(view, props => props['data-workbuddy-account-actions'] === true)
    const rowStyle = row?.props?.style as Record<string, unknown> | undefined
    expect(rowStyle?.['gap']).toBe('8px')
    expect(rowStyle?.['alignItems']).toBe('center')
    const login = find(view, props => props['data-workbuddy-login'] === true)
    const check = find(view, props => props['data-workbuddy-refresh'] === true)
    expect(login?.props?.style).toEqual(check?.props?.style)
    expect((login?.props?.style as Record<string, unknown> | undefined)?.['padding']).toBeDefined()
  })

  it('元素之间都要有间距：账号框、按钮、模型列表各自分开', () => {
    const account = workBuddyAccountView({ state: LOGGED_IN })
    const accountRoot = find(account, props => props['data-workbuddy-account'] === 'root')
    const accountStyle = accountRoot?.props?.style as Record<string, unknown> | undefined
    expect(accountStyle?.['gap']).toBeDefined()

    const view = workBuddySettingsView({ state: LOGGED_IN, models: MODELS })
    const root = (view as ReactElement & { props?: { style?: Record<string, unknown> } }).props
    expect(root?.style?.['gap']).toBeDefined()
  })

  it('模型列表自己那部分也是一件一件分开排的', () => {
    const view = modelChecklistView({
      list: {
        models: [{ id: 'glm-5.3', name: 'GLM-5.3', credits: 'x0.69', supportsToolCall: true }],
        selected: ['glm-5.3'],
        custom: false,
      },
    })
    const root = find(view, props => props['data-model-checklist'] === 'root')
    const style = root?.props?.style as Record<string, unknown> | undefined
    expect(style?.['gap']).toBeDefined()
    expect(style?.['flexDirection']).toBe('column')
  })

  it('模型列表在账号那部分下面', () => {
    const view = workBuddySettingsView({ state: LOGGED_IN, models: MODELS })
    const children = (view as ReactElement & { props?: { children?: unknown } }).props?.children
    const list = Array.isArray(children) ? children : [children]
    expect((list[0] as ReactElement & { props?: Record<string, unknown> })?.props?.['data-workbuddy-account']).toBe('root')
    // 签到那一段夹在中间（没状态时是空的），模型列表仍在账号下面。
    const checklistAt = list.findIndex(child =>
      (child as ReactElement & { props?: Record<string, unknown> })?.props?.['data-model-checklist'] === 'root')
    expect(checklistAt).toBeGreaterThan(0)
  })
})

describe('设置里的行', () => {
  it('行 id 是约定的那个', () => {
    expect(WORKBUDDY_ACCOUNT_SECTION_ID).toBe('acp-agent-workbuddy-account')
  })
})

describe('每日签到', () => {
  it('问宿主要签到状态时打的是签到那条路由', async () => {
    const calls: string[] = []
    const fetchImpl = fakeFetch({
      ok: true,
      status: { todayCheckedIn: true, streakDays: 13, dailyCredit: 100, todayCredit: 100, active: true, isStreakDay: false },
    }, calls)
    const state = await readWorkBuddyCheckin({ fetchImpl })
    expect(calls).toEqual(['/acp-agent/workbuddy/checkin'])
    expect(state.status?.todayCheckedIn).toBe(true)
    expect(state.status?.streakDays).toBe(13)
    expect(state.status?.dailyCredit).toBe(100)
  })

  it('没登录时状态里没有签到信息', async () => {
    const fetchImpl = fakeFetch({ ok: false, reason: '未登录' })
    const state = await readWorkBuddyCheckin({ fetchImpl })
    expect(state.status).toBeUndefined()
    expect(state.reason).toBe('未登录')
  })

  it('手动签到时打的是 POST', async () => {
    const calls: string[] = []
    const fetchImpl = fakeFetch({ ok: true, claimed: true, credit: 100, streakDays: 14 }, calls)
    const result = await claimWorkBuddyCheckin({ fetchImpl })
    expect(calls).toEqual(['/acp-agent/workbuddy/checkin'])
    expect(result.claimed).toBe(true)
    expect(result.credit).toBe(100)
  })

  it('视图：今天已签就说清已签、连续几天、每天多少积分', () => {
    const view = workBuddyCheckinView({
      status: { active: true, todayCheckedIn: true, streakDays: 13, dailyCredit: 100, todayCredit: 100, isStreakDay: false },
    })
    const text = textOf(view)
    expect(text).toContain('今日已签')
    expect(text).toContain('13')
    expect(text).toContain('100')
  })

  it('视图：今天没签就说「今日未签」，并给一个「立即签到」按钮', () => {
    const view = workBuddyCheckinView({
      status: { active: true, todayCheckedIn: false, streakDays: 0, dailyCredit: 100, todayCredit: 0, isStreakDay: false },
    })
    expect(textOf(view)).toContain('今日未签')
    const button = find(view, props => props['data-workbuddy-checkin-claim'] === true)
    expect(button).toBeDefined()
  })

  it('视图：没登录就不显示这一段', () => {
    const view = workBuddyCheckinView({ status: undefined })
    expect(view).toBeNull()
  })

  it('视图：今天已签时按钮不再给点', () => {
    const view = workBuddyCheckinView({
      status: { active: true, todayCheckedIn: true, streakDays: 13, dailyCredit: 100, todayCredit: 100, isStreakDay: false },
    })
    const button = find(view, props => props['data-workbuddy-checkin-claim'] === true)
    expect(button?.props['disabled']).toBe(true)
  })
})
