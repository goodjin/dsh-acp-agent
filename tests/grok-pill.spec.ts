/**
 * Grok 胶囊的口径与画法。
 *
 * 档位要出现在悬停提示里（2026-11-04 需求）：数字是「周 xx%」，悬停第一句是
 * 「Grok（SuperGrok）…」。这里钉三件事：
 * 1. 口径表里第六张是 Grok：providerId 精确到 `acp:acp-grok`，走路由取数；
 * 2. 画出来的那枚：标签「周 xx%」、悬停带档位与已用百分比、重置时刻接在后面；
 * 3. 变色方向跟其它「已用」口径一致——越高越红（100% 红、30% 不变色）。
 */

import { describe, expect, it } from 'vitest'
import {
  GROK_QUOTA_PILL_SPEC,
  pillOf,
  QUOTA_PILL_SPECS,
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
  it('第六张是 Grok：providerId 精确到 acp:acp-grok，走路由取数', () => {
    const spec = QUOTA_PILL_SPECS.find(entry => entry.provider === 'grok')
    expect(spec?.providerId).toBe('acp:acp-grok')
    expect(spec?.routePath).toBe('/acp-agent/grok/quota')
    expect(spec?.dockId).toBe('acp-agent-grok-quota')
    expect(GROK_QUOTA_PILL_SPEC).toBe(spec)
  })
})

describe('画法', () => {
  it('标签是「周 xx%」，悬停第一句带档位', () => {
    const pill = pillOf(
      { kind: 'weekly', percent: 42.5, resetAt: Date.parse('2026-11-05T01:25:52Z') },
      fallbackT,
      GROK_QUOTA_PILL_SPEC,
      'GrokPro',
    )
    const text = textOf(pill)
    expect(text).toContain('周 43%')
    const title = (pill as { props?: { title?: string } }).props?.title ?? ''
    expect(title).toContain('GrokPro')
    expect(title).toContain('43%')
    expect(title).toContain('重置')
  })

  it('档位缺失时不空转：标题照常给出（只是不写档位）', () => {
    const pill = pillOf(
      { kind: 'weekly', percent: 10 },
      fallbackT,
      GROK_QUOTA_PILL_SPEC,
      undefined,
    )
    const title = (pill as { props?: { title?: string } }).props?.title ?? ''
    expect(title).toContain('10%')
  })

  it('变色方向跟「已用」口径一致：100% 红，30% 不变色', () => {
    const exhausted = pillOf({ kind: 'weekly', percent: 100 }, fallbackT, GROK_QUOTA_PILL_SPEC, 'GrokPro')
    const relaxed = pillOf({ kind: 'weekly', percent: 30 }, fallbackT, GROK_QUOTA_PILL_SPEC, 'GrokPro')
    expect((exhausted as { props?: Record<string, unknown> }).props?.['data-tone']).toBe('danger')
    expect((relaxed as { props?: Record<string, unknown> }).props?.['data-tone']).toBeUndefined()
  })
})
