/**
 * 跨包座位与 priority 的契约。
 *
 * 两个包都包 `conversation.chat.node` 的 `assistant-step` 格子，靠 priority 决定
 * 谁在外层（数值更低=更外层：插槽按升序取每个格子的第一条）。而且座位
 * `conversation.chat.node.acp-segment-renderer` 只能有一个声明者——两边都声明时
 * 后声明的那个会抛「already-declared child key」，被各自的 try/catch 吞掉，于是
 * 结果取决于装配顺序（2026-11-03 现场：答案卡片整块消失、且没有任何可见报错）。
 *
 * 这组断言把「账」钉在本仓库这半边：
 * - 本包**不**声明座位（声明权归 chat-area）；
 * - 本包的兜底优先级是 -40，严格大于 chat-area 的 -50，也就是恒在它内层。
 *
 * 读了源码而不是 import，是因为 acp-process-surface 依赖客户端 UI 包（primitives →
 * clsx …），在隔离工作区里解析不稳；这里要钉的是字面量与注册形状，源码即事实。
 * 对面那一半在 @goodjin2/dsh-chat-area 的 tests/wrap-priority.spec.ts 里。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SURFACE = readFileSync(fileURLToPath(new URL('../src/client/acp-process-surface.tsx', import.meta.url)), 'utf8')

/** 从源码里读出导出的常量，类型断言留给 tsc。 */
function constantOf(name: string): number {
  const match = new RegExp(`export const ${name} = (-?\\d+)`).exec(SURFACE)
  expect(match, `源码里找不到 ${name}`).not.toBeNull()
  return Number(match![1])
}

describe('assistant-step 的座位契约', () => {
  it('本包不声明座位（一个插槽只能有一个声明者，声明权归 chat-area）', () => {
    expect(SURFACE).not.toMatch(/children:\s*\{[\s\S]{0,120}SEGMENT_RENDERER_SLOT/)
    expect(SURFACE).not.toContain('seatDeclared')
  })

  it('本包仍然把 ACP 段渲染器注册进座位（座位存在时由 chat-area 取用）', () => {
    expect(SURFACE).toContain('slots.inject(SEGMENT_RENDERER_SLOT')
    expect(SURFACE).toContain('threadharbor-acp-segment-renderer')
  })

  it('兜底优先级 -40，比 chat-area 的 -50 更内层', () => {
    const fallback = constantOf('ASSISTANT_STEP_FALLBACK_PRIORITY')
    expect(fallback).toBe(-40)
    // chat-area 的测试里写着同一个数字；本包必须严格大于它（-40 > -50）才算内层。
    expect(fallback).toBeGreaterThan(-50)
    expect(SURFACE).toContain('priority: ASSISTANT_STEP_FALLBACK_PRIORITY')
  })
})
