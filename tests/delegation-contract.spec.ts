/**
 * 委派服务的载荷契约。
 *
 * acp-agent（通路）与 dsh-superpowers（委派实现）互不 import，两边各持一份
 * 逐字同形的契约文件，跨插件只经宿主服务对接：一个服务名 + 一份载荷形状。
 * 这份测试钉住本仓副本的形状；最后一个用例在对面仓也在场时把两份副本
 * 对着比——形状唯一的活体守卫就是它，两边谁漂了都会在这里现形。
 */

import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DELEGATION_SERVICE, isDelegationResult } from '../src/delegation-contract.ts'

/**
 * 对面仓的契约副本。走相对层级而不是绝对路径——绝对路径换个克隆就失效。
 * 从 tests/ 向上四层是容器目录 dsh-plugins/（tests → feat-acp-delegation →
 * .worktrees → dsh-acp-agent → dsh-plugins），再进 superpowers 的 worktree。
 * 若两仓被拆到不同父目录，这里解析不到文件，对照用例按约定跳过——
 * 那时形状退回靠两边各自的契约测试守住，而不是让本测试失败。
 */
const MIRROR_CONTRACT = fileURLToPath(
  new URL(
    '../../../../dsh-superpowers/.worktrees/feat-delegation-service/lib/delegation-contract.js',
    import.meta.url,
  ),
)

describe('委派契约', () => {
  it('服务名常量是 superpowers.delegation', () => {
    expect(DELEGATION_SERVICE).toBe('superpowers.delegation')
  })

  it('isDelegationResult 认得 {output, model, childId} 三字段齐全的对象', () => {
    expect(isDelegationResult({ output: '最终文本', model: 'inherited', childId: 'child-1' })).toBe(true)
  })

  it('isDelegationResult 拒绝缺字段的对象', () => {
    // 三个必要字段各缺一次：缺哪个都认不出这份结果。
    expect(isDelegationResult({ model: 'inherited', childId: 'child-1' })).toBe(false)
    expect(isDelegationResult({ output: '最终文本', childId: 'child-1' })).toBe(false)
    expect(isDelegationResult({ output: '最终文本', model: 'inherited' })).toBe(false)
  })

  it('isDelegationResult 拒绝非对象与字段类型不对的输入', () => {
    // 载荷跨插件、跨进程边界来，收到什么都得安全地问一句「是不是」。
    expect(isDelegationResult(null)).toBe(false)
    expect(isDelegationResult('最终文本')).toBe(false)
    expect(isDelegationResult({ output: 1, model: 'inherited', childId: 'child-1' })).toBe(false)
  })

  it.skipIf(!existsSync(MIRROR_CONTRACT))('与 dsh-superpowers 仓的契约副本同名同形', async () => {
    const mirror = await import(pathToFileURL(MIRROR_CONTRACT).href)
    expect(mirror.DELEGATION_SERVICE).toBe(DELEGATION_SERVICE)
    expect(typeof mirror.isDelegationResult).toBe('function')
    // 两份判定对同一批输入必须给同一个答案：单边断言两个「true/false」
    // 只能证明各自能跑，比不出漂移；逐样比对才钉得住「同形」。
    const samples: unknown[] = [
      { output: '最终文本', model: 'inherited', childId: 'child-1' },
      { model: 'inherited', childId: 'child-1' },
      { output: '最终文本', childId: 'child-1' },
      { output: '最终文本', model: 'inherited' },
      { output: 1, model: 'inherited', childId: 'child-1' },
      null,
      '最终文本',
      {},
    ]
    for (const sample of samples) {
      expect(mirror.isDelegationResult(sample)).toBe(isDelegationResult(sample))
    }
  })
})
