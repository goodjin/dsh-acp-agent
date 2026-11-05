/**
 * 设置里的「Qoder 国际版账号」段。
 *
 * 这一段只做两件事：问宿主「登了没」，以及在没登录时给一个能点开的授权地址。
 * 令牌不出宿主，所以浏览器这一侧从头到尾没有令牌——视图不读、应答里也不该有。
 *
 * 这里钉住：未登录时给出「去登录」；已登录时显示是谁；点授权时打的是登录那条
 * 路由、拿到的地址交给注入的开窗函数；刷新时打的是状态那条路由；授权后**连着
 * 问若干次**（用户可能要输验证码，问一次就收手会让人以为没成）。
 */

import { describe, expect, it } from 'vitest'
import type { ReactElement } from 'react'
import {
  beginQoderLogin,
  pollUntilQoderSignedIn,
  qoderAccountView,
  qoderSettingsView,
  readQoderSession,
  QODER_LOGIN_URL,
  QODER_SESSION_URL,
} from '../src/client/qoder-account-section.tsx'
import type { QoderAccountState } from '../src/client/qoder-account-section.tsx'

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

/** 假 fetch：按顺序给应答。 */
function fakeFetch(bodies: unknown[], calls: string[] = []): typeof fetch {
  let index = 0
  return (async (url: string) => {
    calls.push(String(url))
    const body = bodies[Math.min(index, bodies.length - 1)]
    index += 1
    return new Response(JSON.stringify(body), { status: 200 })
  }) as unknown as typeof fetch
}

const SIGNED_OUT: QoderAccountState = { authenticated: false }
const SIGNED_IN: QoderAccountState = { authenticated: true, account: { uid: 'uid-1', nickname: '某人' } }

describe('账号状态', () => {
  it('问的是状态那条路由', async () => {
    const calls: string[] = []
    await readQoderSession({ fetchImpl: fakeFetch([{ ok: true, authenticated: false }], calls) })
    expect(calls).toEqual([QODER_SESSION_URL])
  })

  it('登上了就说清是谁', async () => {
    const state = await readQoderSession({
      fetchImpl: fakeFetch([{ ok: true, authenticated: true, account: { uid: 'uid-1', nickname: '某人' } }]),
    })
    expect(state).toEqual(SIGNED_IN)
  })

  it('没登录就是没登录，不带任何令牌', async () => {
    const state = await readQoderSession({
      fetchImpl: fakeFetch([{ ok: true, authenticated: false, accessToken: 'secret' }]),
    })
    expect(state).toEqual(SIGNED_OUT)
    expect(JSON.stringify(state)).not.toContain('secret')
  })

  it('宿主说登录没成时，把那句话带出来', async () => {
    const state = await readQoderSession({
      fetchImpl: fakeFetch([{ ok: true, authenticated: false, reason: '登录未完成或失败，请重试' }]),
    })
    expect(state).toEqual({ authenticated: false, reason: '登录未完成或失败，请重试' })
  })

  it('问不到宿主时说清楚', async () => {
    const state = await readQoderSession({ fetchImpl: fakeFetch([{ ok: false, reason: '没挂上' }]) })
    expect(state).toEqual({ authenticated: false, reason: '没挂上' })
  })
})

describe('登录', () => {
  it('打的是登录那条路由，并把地址交给开窗函数', async () => {
    const calls: string[] = []
    const opened: string[] = []
    const result = await beginQoderLogin({
      fetchImpl: fakeFetch([{ ok: true, url: 'https://qoder.com/device/selectAccounts?x=1' }], calls),
      openUrl: url => { opened.push(url) },
    })
    expect(calls).toEqual([QODER_LOGIN_URL])
    expect(opened).toEqual(['https://qoder.com/device/selectAccounts?x=1'])
    expect(result.ok).toBe(true)
  })

  it('宿主没给地址就说登录没起来', async () => {
    const result = await beginQoderLogin({ fetchImpl: fakeFetch([{ ok: true }]) })
    expect(result.ok).toBe(false)
    expect(result.reason).toBeTruthy()
  })
})

describe('授权之后', () => {
  it('连着问若干次，登上了就停', async () => {
    const calls: string[] = []
    const state = await pollUntilQoderSignedIn({
      fetchImpl: fakeFetch([
        { ok: true, authenticated: false },
        { ok: true, authenticated: false },
        { ok: true, authenticated: true, account: { uid: 'uid-1' } },
      ], calls),
      intervalMs: 0,
      sleepImpl: async () => {},
    })
    expect(state.authenticated).toBe(true)
    expect(calls.length).toBe(3)
  })

  it('一直问不到就如实说没登录', async () => {
    const calls: string[] = []
    const state = await pollUntilQoderSignedIn({
      fetchImpl: fakeFetch([{ ok: true, authenticated: false }], calls),
      attempts: 3,
      intervalMs: 0,
      sleepImpl: async () => {},
    })
    expect(state.authenticated).toBe(false)
    expect(calls.length).toBe(3)
  })
})

describe('模型列表', () => {
  const MODELS = {
    models: [{ id: 'qwen3.8-max', name: 'Qwen 3.8 Max' }],
    selected: ['qwen3.8-max'],
    custom: false,
    default: ['qwen3.8-max'],
  }

  it('模型列表在账号那部分下面', () => {
    const view = qoderSettingsView({ state: SIGNED_IN, models: MODELS })
    const children = (view as ReactElement & { props?: { children?: unknown } }).props?.children
    const list = Array.isArray(children) ? children : [children]
    expect((list[0] as ReactElement & { props?: Record<string, unknown> })?.props?.['data-qoder-account']).toBe('root')
    expect((list[1] as ReactElement & { props?: Record<string, unknown> })?.props?.['data-model-checklist']).toBe('root')
  })

  it('账号与模型列表之间也留出间距', () => {
    const view = qoderSettingsView({ state: SIGNED_IN, models: MODELS })
    const root = (view as ReactElement & { props?: { style?: Record<string, unknown> } }).props
    expect(root?.style?.['gap']).toBeDefined()
  })
})

describe('排版', () => {
  it('账号信息在一个框里，独占一行', () => {
    const view = qoderAccountView({ state: SIGNED_IN })
    const box = find(view, props => props['data-qoder-account-box'] === true)
    expect(box).toBeDefined()
    const style = box?.props?.style as Record<string, unknown> | undefined
    expect(String(style?.['border'])).toContain('1px solid')
  })

  it('两个按钮一样大、留出间距、齐平', () => {
    const view = qoderAccountView({ state: SIGNED_OUT })
    const row = find(view, props => props['data-qoder-account-actions'] === true)
    const rowStyle = row?.props?.style as Record<string, unknown> | undefined
    expect(rowStyle?.['gap']).toBe('8px')
    expect(rowStyle?.['alignItems']).toBe('center')
    const login = find(view, props => props['data-qoder-login'] === true)
    const check = find(view, props => props['data-qoder-refresh'] === true)
    expect(login?.props?.style).toEqual(check?.props?.style)
  })

  it('元素之间都要有间距', () => {
    const view = qoderAccountView({ state: SIGNED_OUT })
    const root = find(view, props => props['data-qoder-account'] === 'root')
    const style = root?.props?.style as Record<string, unknown> | undefined
    expect(style?.['gap']).toBeDefined()
    expect(style?.['flexDirection']).toBe('column')
  })
})

describe('视图', () => {
  it('登上了显示是谁，登录按钮变成「重新登录」（不藏——两个按钮是一组）', () => {
    const view = qoderAccountView({ state: SIGNED_IN })
    expect(textOf(view)).toContain('某人')
    const login = find(view, props => props['data-qoder-login'] === true)
    expect(login?.props?.disabled).toBe(false)
    expect(textOf(login)).toContain('重新登录')
  })

  it('没登录给出登录按钮', () => {
    const view = qoderAccountView({ state: SIGNED_OUT })
    expect(find(view, props => props['data-qoder-login'] === true)).toBeDefined()
  })

  it('视图里从头到尾没有令牌', () => {
    const view = qoderAccountView({ state: { authenticated: true, account: { uid: 'u', nickname: 'n' } } })
    expect(textOf(view)).not.toContain('secret')
  })
})
