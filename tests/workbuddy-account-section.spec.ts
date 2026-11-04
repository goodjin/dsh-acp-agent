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
  readWorkBuddySession,
  WORKBUDDY_ACCOUNT_SECTION_ID,
  workBuddyAccountView,
} from '../src/client/workbuddy-account-section.tsx'
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

  it('登了就说清是谁，不再给登录按钮', () => {
    const view = workBuddyAccountView({ state: LOGGED_IN })
    expect(find(view, props => props['data-workbuddy-login'] === true)).toBeUndefined()
    expect(textOf(view)).toContain('某人')
    expect(textOf(view)).toContain('uid-1')
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

describe('设置里的行', () => {
  it('行 id 是约定的那个', () => {
    expect(WORKBUDDY_ACCOUNT_SECTION_ID).toBe('acp-agent-workbuddy-account')
  })
})
