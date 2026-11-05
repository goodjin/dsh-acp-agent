/**
 * WorkBuddy 积分胶囊的口径与画法。
 *
 * WorkBuddy 没有「5 小时窗／周窗」那套窗口，只有**积分池**：可用多少、额度上限
 * 多少、这些积分是怎么来的（套餐基础／套餐赠送／购买／平台奖励）。所以这一枚
 * 胶囊只画积分，悬停把构成写清楚——跟官方客户端设置里「套餐与积分」那一块同源。
 *
 * 这里钉三件事：
 * 1. 口径表里有一张 WorkBuddy：按目录里的 provider id 精确认（`acp:acp-workbuddy`），
 *    走路由取数；
 * 2. 画出来的那枚：标签「积分」、数字是「可用 / 总额度」；
 * 3. 悬停里有套餐名、每一类积分的构成，以及总积分。
 */

import { describe, expect, it } from 'vitest'
import {
  creditPillOf,
  QUOTA_PILL_SPECS,
  WORKBUDDY_QUOTA_PILL_SPEC,
} from '../src/client/quota-pill.ts'
import { fallbackT } from '../src/client/locales.ts'

/** 按顺序收元素树里的文本。 */
function textOf(node: unknown): string {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node === null || typeof node !== 'object') return ''
  return textOf((node as { props?: { children?: unknown } }).props?.children)
}

describe('口径表', () => {
  it('有一张 WorkBuddy：providerId 精确到 acp:acp-workbuddy，走路由取数', () => {
    const spec = QUOTA_PILL_SPECS.find(entry => entry.provider === 'workbuddy')
    expect(spec?.providerId).toBe('acp:acp-workbuddy')
    expect(spec?.routePath).toBe('/acp-agent/workbuddy/credits')
    expect(spec?.showCredit).toBe(true)
    expect(WORKBUDDY_QUOTA_PILL_SPEC).toBe(spec)
  })
})

describe('画法', () => {
  const credit = {
    remaining: 1766.43,
    used: 33.57,
    limit: 1800,
    groups: [
      { name: '套餐基础积分', total: 500, remain: 500, used: 0 },
      { name: '平台奖励积分', total: 1300, remain: 1266.43, used: 33.57 },
    ],
  }

  it('标签是「积分」，数字是「可用 / 总额度」', () => {
    const pill = creditPillOf(credit, fallbackT, WORKBUDDY_QUOTA_PILL_SPEC)
    const text = textOf(pill)
    expect(text).toContain('积分')
    expect(text).toContain('1766.43')
    expect(text).toContain('1800')
  })

  it('悬停里有套餐名、每一类积分与总积分', () => {
    // 套餐名由胶囊行从 quota.tier 传进来（WorkBuddy 的套餐名是「体验版」这类）。
    const pill = creditPillOf(credit, fallbackT, WORKBUDDY_QUOTA_PILL_SPEC, '体验版')
    const title = (pill as { props?: { title?: string } }).props?.title ?? ''
    expect(title).toContain('体验版')
    expect(title).toContain('套餐基础积分')
    expect(title).toContain('平台奖励积分')
    expect(title).toContain('1766.43')
  })

  it('没有构成明细时也不空转：悬停至少给出总积分', () => {
    const pill = creditPillOf(
      { remaining: 10, used: 0, limit: 10 },
      fallbackT,
      WORKBUDDY_QUOTA_PILL_SPEC,
    )
    const title = (pill as { props?: { title?: string } }).props?.title ?? ''
    expect(title).toContain('10')
  })
})
