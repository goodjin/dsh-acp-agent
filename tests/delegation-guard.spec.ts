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
    // 判据是 delegationDepth，不是 origin——这条钉的是「判据只有一个字段」。
    // 别把它读成「影子子会话因为带 origin 才被排除」：本行自己造的影子子会话
    // 两个字段都带（entry.ts 的 openChild），它们被豁免是因为会话头没有
    // agentPreset，接管判定在 presetIdOf 就早退了，走不到这道守卫。
    expect(isDelegatedChild({ session: { header: { origin: 'subagent' } } })).toBe(false)
  })
})
