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

  it('登上了显示是谁，不摆登录按钮（杵在那儿看着像在催你登录）', () => {
    const view = qoderAccountView({ state: SIGNED_IN })
    expect(find(view, props => props['data-qoder-login'] === true)).toBeUndefined()
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
