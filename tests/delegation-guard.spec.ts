import { describe, expect, it } from 'vitest'
import { isDelegatedChild } from '../src/dispatch.ts'

describe('受委派子会话的接管排除', () => {
  it('会话头带 delegationDepth>0 的 agent 是受委派子会话', () => {
    expect(isDelegatedChild({ session: { header: { delegationDepth: 1 } } })).toBe(true)
    expect(isDelegatedChild({ session: { header: { delegationDepth: 2 } } })).toBe(true)
  })

  it('普通会话不是受委派子会话', () => {
    expect(isDelegatedChild({ session: { header: { agentPreset: 'acp-codex' } } })).toBe(false)
  })

  it('没有会话头的 agent 不是受委派子会话', () => {
    expect(isDelegatedChild({})).toBe(false)
  })

  it('origin=subagent 但没有 delegationDepth 的会话不算受委派子会话', () => {
    // origin 是粗粒度的来源标记；ACP 行自己造的影子子会话也带它。
    // 判据用 delegationDepth —— 宿主对「这是受委派产生的」的记账。
    expect(isDelegatedChild({ session: { header: { origin: 'subagent' } } })).toBe(false)
  })
})
