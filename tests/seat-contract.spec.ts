/**
 * `assistant-step` 的遮蔽 wrap 已拆除（2026-11-13）：原生 AssistantNodeView
 * 声明了子座位（conversation.chat.reasoning.body / message.message.images 等），
 * 宿主对 renderSlot 逐 key 校验「本条目 children 表」——遮蔽 wrap 没声明的座位，
 * 原生一调用就抛 SlotOwnershipError、错误边界卸掉整棵会话流；转发原生 children
 * 又在 register 时抛 already declared（子座位单一存活 owner）。两条路都死。
 *
 * 本包的 -40 兜底 wrap 与「ACP 段渲染器挂跨包座位」随之拆除：座位声明方
 * （dsh-chat-power）也不再注册 assistant-step wrap，跨包座位已无人声明。
 * `acpProcessSegment` 数据注入（视图 wrap）保留，渲染方待走合法座位重接。
 *
 * 读了源码而不是 import，是因为 acp-process-surface 依赖客户端 UI 包（primitives →
 * clsx …），在隔离工作区里解析不稳；这里要钉的是字面量与注册形状，源码即事实。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SURFACE = readFileSync(fileURLToPath(new URL('../src/client/acp-process-surface.tsx', import.meta.url)), 'utf8')

describe('assistant-step 不再有遮蔽 wrap', () => {
  it('源码不再注册 assistant-step wrap（原生带子座位授权，无法合法遮蔽）', () => {
    expect(SURFACE).not.toContain("key: 'assistant-step'")
    expect(SURFACE).not.toContain('ASSISTANT_STEP_FALLBACK_PRIORITY')
  })

  it('跨包座位挂钩一并拆除（座位声明方已不在，inject 永不触发）', () => {
    expect(SURFACE).not.toContain('slots.inject(SEGMENT_RENDERER_SLOT')
    expect(SURFACE).not.toContain('acp-agent-acp-segment-renderer')
  })

  it('视图 wrap 的吞错纪律保留（交给宿主的回调不把异常抛进对方注册流程）', () => {
    const view = SURFACE.slice(SURFACE.indexOf('const attachView'), SURFACE.indexOf('const unsubscribeView'))
    expect(view).toMatch(/catch\s*\(/)
  })
})
