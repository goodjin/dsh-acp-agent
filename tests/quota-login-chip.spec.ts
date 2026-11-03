/**
 * 胶囊旁边的「去授权」那一枚。
 *
 * 登录过期时配额接口不再回数字，而是回 `needsLogin: true` + 一条授权地址；这一行
 * 就从「5小时 xx%」换成「去授权 <链接>（授权码 xxxx）」。三个环节各测一段：
 *
 * - 取数器：把宿主应答里的 `needsLogin/login` 折成 `QuotaAnswer.login`（只认 http(s)）；
 * - 轮询器：失败时带出登录信息，成功时清掉并通知（那一枚要跟着消失）；
 * - 视图：`loginChipOf` 画出的锚点地址、文案与授权码都对得上。
 *
 * 没有 react-dom，所以不渲染组件本身；`loginChipOf` 是纯函数，形状可以直接断言。
 */

import { describe, expect, it } from 'vitest'
import type { ReactElement } from 'react'
// 只 import 不依赖 primitives 的两个模块：quota-pill.ts 会拉进浏览器专用依赖，
// 在 node 里装不上（它自己也没有客户端单测）。纯逻辑与画法都在 quota-login.ts 里。
import { createQuotaPoller, GLM_QUOTA_PILL_SPEC } from '../src/client/quota-pill.ts'
import { loginChipOf, loginOfferOfBody, sameLoginOffer } from '../src/client/quota-login.ts'
import type { QuotaLoginOffer } from '../src/client/quota-login.ts'
import { routeQuotaFetcher } from '../src/client/quota-pill.ts'
import type { QuotaAnswer } from '../src/client/quota-pill.ts'

const OFFER: QuotaLoginOffer = {
  url: 'https://account.minimax.cn/oauth-authorize?user_code=LAXY-CAVT',
  userCode: 'LAXY-CAVT',
  expiresInSec: 300,
}

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

/** 假 fetch：一次应答就够（取数器只问一次）。 */
function bodyFetcher(body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch
}

describe('宿主应答里的授权信息', () => {
  it('needsLogin + login 折成 QuotaAnswer.login', async () => {
    const fetchQuota = routeQuotaFetcher(bodyFetcher({ ok: false, error: '登录过期', needsLogin: true, login: OFFER }))
    const answer = await fetchQuota()
    expect(answer.ok).toBe(false)
    expect(answer.ok === false ? answer.login : undefined).toEqual(OFFER)
  })

  it('只认 http(s) 地址；非 http(s) 当作没有', () => {
    expect(loginOfferOfBody({ needsLogin: true, login: { url: 'javascript:alert(1)' } })).toBeUndefined()
    expect(loginOfferOfBody({ needsLogin: true, login: { url: 'https://account.minimax.cn/x' } }))
      .toEqual({ url: 'https://account.minimax.cn/x' })
  })

  it('没有 needsLogin 时不带 login（普通故障不冒充「该去授权」）', async () => {
    const fetchQuota = routeQuotaFetcher(bodyFetcher({ ok: false, error: 'socket hang up' }))
    const answer = await fetchQuota()
    expect(answer.ok === false ? answer.login : 'n/a').toBeUndefined()
  })
})

describe('轮询器把授权信息带出来', () => {
  it('失败时带出、成功后清掉并通知', async () => {
    let next: QuotaAnswer = { ok: false, error: '登录过期', login: OFFER }
    const poller = createQuotaPoller({
      fetchQuota: async () => next,
      setInterval: () => 0,
      clearInterval: () => {},
    })
    let notified = 0
    poller.subscribe(() => { notified += 1 })
    await poller.refresh()
    expect(poller.getLogin()).toEqual(OFFER)
    expect(poller.getSnapshot()).toBeUndefined()

    next = { ok: true, quota: { fiveHour: { kind: 'five-hour', percent: 12 } } }
    await poller.refresh()
    expect(poller.getLogin()).toBeUndefined()
    expect(poller.getSnapshot()?.fiveHour?.percent).toBe(12)
    expect(notified).toBeGreaterThanOrEqual(2)
  })

  it('同一个地址反复失败不重复通知（轮询每 5 分钟一次）', async () => {
    const poller = createQuotaPoller({
      fetchQuota: async () => ({ ok: false, error: '登录过期', login: OFFER }),
      setInterval: () => 0,
      clearInterval: () => {},
    })
    let notified = 0
    poller.subscribe(() => { notified += 1 })
    await poller.refresh()
    const afterFirst = notified
    await poller.refresh()
    expect(notified).toBe(afterFirst)
    expect(poller.getLogin()).toEqual(OFFER)
  })
})

describe('那一枚的画法', () => {
  const chip = loginChipOf(OFFER, (key: string) => `T:${key}`, GLM_QUOTA_PILL_SPEC)

  it('链接指向授权地址，新窗口打开、带 noopener', () => {
    const link = find(chip, props => props['data-quota-login-link'] !== undefined)
    expect(link?.props.href).toBe(OFFER.url)
    expect(link?.props.target).toBe('_blank')
    expect(String(link?.props.rel)).toContain('noopener')
    expect(textOf(link)).toBe('T:quota.login.cta')
  })

  it('写明授权码，标题说明为什么要授权', () => {
    const code = find(chip, props => props['data-quota-login-code'] !== undefined)
    expect(code?.props.children).toBe('T:quota.login.code')
    expect((chip as ReactElement).props.title).toBe('T:quota.login.title')
  })

  it('没有授权码时不画那一段', () => {
    const bare = loginChipOf({ url: OFFER.url }, (key: string) => key, GLM_QUOTA_PILL_SPEC)
    expect(find(bare, props => props['data-quota-login-code'] !== undefined)).toBeUndefined()
  })
})
