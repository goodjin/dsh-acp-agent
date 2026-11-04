/**
 * DeepSeek 官方账号的余额胶囊。
 *
 * 设置页的余额是浏览器调 `remote.account.getBalance(...)` 拿的（充值钱包 + 赠送金钱包，
 * 币种 CNY/USD，余额是十进制字符串）。本包客户端和设置页注入的是同一个
 * `@deepseek-ai/dsh-api-remotes`，所以胶囊直接走同一条路——同一个数、不碰令牌、
 * 也不新开宿主路由。
 *
 * 这里钉四件事：
 * 1. 折算口径：胶囊数字 = 充值钱包的 CNY 合计；赠送金与非 CNY 钱包进悬停明细，
 *    不混进数字（没有汇率，不该瞎合并）；
 * 2. 失败折叠：没登录（远端回 null）、远端说失败、形状不认识、钱包列表为空——
 *    全部折成 ok:false，胶囊安静地不出现（DeepSeek 的登录在应用设置里完成，
 *    没有可点开的授权链接，所以这 家不出「去授权」chip）；
 * 3. 精确认：providerId 是 `deepseek-account`（同 Codex/Claude 的认法），不按模型
 *    前缀猜，免得误伤别的渠道；
 * 4. 画出来的那枚：标签「余额」、数字带 ¥、悬停给充值/赠送明细。
 */

import { describe, expect, it } from 'vitest'
import type { ReactElement } from 'react'
import {
  DEEPSEEK_QUOTA_PILL_SPEC,
  QUOTA_PILL_SPECS,
  remoteBalanceFetcher,
  creditPillOf,
} from '../src/client/quota-pill.ts'
import type { QuotaAnswer } from '../src/client/quota-pill.ts'
import { fallbackT } from '../src/client/locales.ts'

/** 远端 getBalance 的一次「ready」应答（形状照宿主 typert 的 result）。 */
function readyOutcome(normal: { currency: string; balance: string }[], bonus: { currency: string; balance: string }[] = []) {
  return { ok: true, value: { status: 'ready', value: normal, bonusWallets: bonus } }
}

/** 假 remote：getBalance 收到的参数被记下来，应答由用例给。 */
function fakeRemote(answer: unknown, calls: unknown[][] = []) {
  return {
    account: {
      async getBalance(...args: unknown[]) {
        calls.push(args)
        return answer
      },
    },
  }
}

/** 按顺序收元素树里的文本。 */
function textOf(node: unknown): string {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node === null || typeof node !== 'object') return ''
  return textOf((node as { props?: { children?: unknown } }).props?.children)
}

describe('remote 余额取数器的折算口径', () => {
  it('充值钱包 CNY 合计进数字；赠送金与非 CNY 钱包进悬停明细', async () => {
    const fetchQuota = remoteBalanceFetcher({
      remote: fakeRemote(readyOutcome(
        [{ currency: 'CNY', balance: '100.50' }, { currency: 'USD', balance: '12.00' }],
        [{ currency: 'CNY', balance: '23.00' }],
      )),
    })
    const answer: QuotaAnswer = await fetchQuota()
    expect(answer.ok).toBe(true)
    if (!answer.ok) return
    expect(answer.quota.credit?.remaining).toBe(100.5)
    expect(answer.quota.credit?.recharge).toBe(100.5)
    expect(answer.quota.credit?.bonus).toBe(23)
    expect(answer.quota.credit?.extra).toContain('$12.00')
    expect(answer.quota.fiveHour).toBeUndefined()
    expect(answer.quota.weekly).toBeUndefined()
  })

  it('只认 CNY 数字：USD 只进明细，绝不折成人民币', async () => {
    const fetchQuota = remoteBalanceFetcher({
      remote: fakeRemote(readyOutcome([{ currency: 'USD', balance: '50.00' }])),
    })
    const answer = await fetchQuota()
    expect(answer.ok === false || answer.quota.credit?.remaining === 0).toBe(true)
  })

  it('getBalance 的参数带版本、语言与时区偏移（宿主要拿它派生 Platform 请求头）', async () => {
    const calls: unknown[][] = []
    const fetchQuota = remoteBalanceFetcher({
      remote: fakeRemote(readyOutcome([{ currency: 'CNY', balance: '1.00' }]), calls),
      locale: () => 'zh-CN',
    })
    await fetchQuota()
    const metadata = calls[0]?.[0] as Record<string, unknown> | undefined
    expect(metadata).toEqual({
      version: expect.any(String),
      locale: 'zh-CN',
      timezoneOffsetSeconds: expect.any(Number),
    })
  })

  it('没登录（远端回 null）折叠成 ok:false，胶囊不出现', async () => {
    const fetchQuota = remoteBalanceFetcher({ remote: fakeRemote(null) })
    const answer = await fetchQuota()
    expect(answer.ok).toBe(false)
  })

  it('远端说失败时原样折叠，带上原因', async () => {
    const fetchQuota = remoteBalanceFetcher({ remote: fakeRemote({ ok: false, error: 'platform request failed' }) })
    const answer = await fetchQuota()
    expect(answer.ok).toBe(false)
    expect(answer.ok === false ? answer.error : '').toContain('platform request failed')
  })

  it('形状不认识（status 不是 ready）也折成 ok:false', async () => {
    const fetchQuota = remoteBalanceFetcher({
      remote: fakeRemote({ ok: true, value: { status: 'failed', value: [] } }),
    })
    const answer = await fetchQuota()
    expect(answer.ok).toBe(false)
  })

  it('钱包列表为空时不冒充 ¥0', async () => {
    const fetchQuota = remoteBalanceFetcher({ remote: fakeRemote(readyOutcome([])) })
    const answer = await fetchQuota()
    expect(answer.ok).toBe(false)
  })

  it('remote 不在场（注入面缺失）时折叠成 ok:false，绝不抛', async () => {
    const fetchQuota = remoteBalanceFetcher({})
    const answer = await fetchQuota()
    expect(answer.ok).toBe(false)
  })
})

describe('口径与画法', () => {
  it('口径表里第五张是 DeepSeek：providerId 精确到 deepseek-account，不问路由', () => {
    const spec = QUOTA_PILL_SPECS.find(entry => entry.provider === 'deepseek')
    expect(spec?.providerId).toBe('deepseek-account')
    expect(spec?.routePath).toBeUndefined()
    expect(spec?.showCredit).toBe(true)
  })

  it('画出来的那枚：标签「余额」、数字带 ¥、悬停给充值与赠送', () => {
    const pill = creditPillOf(
      { remaining: 123.45, recharge: 123.45, bonus: 23, extra: '' },
      fallbackT,
      DEEPSEEK_QUOTA_PILL_SPEC,
    )
    const text = textOf(pill)
    expect(text).toContain('余额')
    expect(text).toContain('¥123.45')
    const title = (pill as ReactElement & { props?: { title?: string } }).props?.title ?? ''
    expect(title).toContain('¥123.45')
    expect(title).toContain('¥23.00')
  })
})
