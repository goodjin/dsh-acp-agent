/**
 * 挂载配置里的 WorkBuddy 那几行。
 *
 * 补丁是「这行挂上是什么样」的唯一说明书：preset 行声明它是哪一行、绑哪个 agent、
 * 有哪些模型与档位；宿主路由行声明登录与状态接口挂在哪个模块上。
 *
 * 这里钉三件事：两行都在；preset 行的绑定是 `workbuddy`；模型与档位都声明了
 * （没声明的话，没登录时选择器里这一组是空的）。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const PATCH = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))

/** 补丁文本。 */
function patch(): string {
  return readFileSync(PATCH, 'utf8')
}

/** 顶层挂载行的 id。 */
function rowIds(): string[] {
  return [...patch().matchAll(/^ {4}- id: (\S+)$/gm)].map(match => match[1] ?? '').filter(id => id !== '')
}

/** 某个顶层挂载行的那一段文本。 */
function rowOf(id: string): string {
  const lines = patch().split('\n')
  const start = lines.findIndex(line => line === `    - id: ${id}`)
  if (start === -1) return ''
  const rest = lines.slice(start + 1)
  const end = rest.findIndex(line => /^ {4}- id: /.test(line))
  return lines.slice(start, end === -1 ? undefined : start + 1 + end).join('\n')
}

describe('挂载配置', () => {
  it('宿主路由行在', () => {
    expect(rowIds()).toContain('acp-agent-workbuddy-login')
    expect(rowOf('acp-agent-workbuddy-login')).toContain("'@goodjin2/dsh-acp-agent/workbuddy-login'")
  })

  it('预置行在，绑定的是 WorkBuddy', () => {
    expect(rowIds()).toContain('acp-workbuddy')
    const row = rowOf('acp-workbuddy')
    expect(row).toContain('name: WorkBuddy')
    expect(row).toContain('presetId: acp-workbuddy')
    expect(row).toContain('agent: workbuddy')
  })

  it('模型清单是白名单：只列要提供的那几个', () => {
    const row = rowOf('acp-workbuddy')
    for (const model of [
      'hy4free', 'hy4std', 'hy4-preview-ctrl', 'hy4-preview-exp', 'hy4preview-exp1',
      'hy4preview-exp2', 'hy4-preview-x', 'glm-5.3', 'glm-5.3-flash', 'deepseek-v4-pro',
      'deepseek-v4.1-flash', 'kimi-k3.1-pro', 'kimi-k3-1', 'minimax-m3.1-flash',
      'step-5-preview', 'mimo-v2.6-pro', 'default-1.1', 'default-1.2',
    ]) {
      expect(row).toContain(`id: "${model}"`)
    }
    // 套餐档位与那些不支持工具调用的都不在这一行里。
    for (const model of ['auto', 'fast-model', 'balanced-model', 'deep-model', 'hy3', 'wb-lite']) {
      expect(row).not.toContain(`id: "${model}"`)
    }
  })

  it('同名模型各成一行：关掉按名合并', () => {
    expect(rowOf('acp-workbuddy')).toContain('collapseEfforts: false')
  })
})
