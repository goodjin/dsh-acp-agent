/**
 * 运行时清单与声明清单的窗口合并。
 *
 * 会话一开，agent 自报的清单会写进目录账本，并整体顶掉声明清单——这是
 * 「选择器以 agent 实际服务什么为准」的正确顺序。但窗口跟着被顶掉是错的：
 * agent 在线上帧里自报窗口（grok 的 availableModels[].meta.contextWindows），
 * 各家 dialect 一直没解析它；声明清单里写好的窗口也随整表替换丢失。结果
 * 一开过会话，压缩就重新拿不到窗口，"no context capacity" 复发
 * （2026-11-07 现场的残留路径）。
 *
 * 规则：窗口按 id 合并——运行时报了用运行时的，没报用声明的；其余字段
 * 仍以运行时为准。
 */

import { describe, expect, it } from 'vitest'
import { mergeDeclaredWindows } from '../src/catalog-registration.ts'

describe('运行时清单的窗口合并', () => {
  it('运行时报了窗口用运行时的', () => {
    const merged = mergeDeclaredWindows(
      [{ id: 'm', name: 'M', contextWindow: 100 }],
      [{ id: 'm', name: 'M', contextWindow: 200 }],
    )
    expect(merged[0]?.contextWindow).toBe(200)
  })

  it('运行时没报窗口时用声明清单兜底，而不是丢掉', () => {
    const merged = mergeDeclaredWindows(
      [{ id: 'm', name: 'M', contextWindow: 100 }],
      [{ id: 'm', name: 'M' }],
    )
    expect(merged[0]?.contextWindow).toBe(100)
  })

  it('运行时独有的模型保留，声明独有的模型不复活（选择器以 agent 实际为准）', () => {
    const merged = mergeDeclaredWindows(
      [{ id: 'old', name: 'Old', contextWindow: 100 }, { id: 'shared', name: 'S', contextWindow: 100 }],
      [{ id: 'shared', name: 'S' }, { id: 'new', name: 'N' }],
    )
    expect(merged.map(model => model.id)).toEqual(['shared', 'new'])
    expect(merged[0]?.contextWindow).toBe(100)
    expect(merged[1]?.contextWindow).toBeUndefined()
  })

  it('没有声明清单时原样透传运行时清单', () => {
    const merged = mergeDeclaredWindows(
      undefined,
      [{ id: 'm', name: 'M', contextWindow: 200 }],
    )
    expect(merged[0]?.contextWindow).toBe(200)
  })
})
