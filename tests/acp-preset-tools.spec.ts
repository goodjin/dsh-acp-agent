/**
 * ACP 预设的 plugins 清单只许有绑定行。
 *
 * 曾经这里断言的是反面：给每个走 ACP 的预设补四个 DSH 工具行，理由是「DSH 侧
 * 起的委派子会话继承父会话的预设组合，没有工具行孩子拿到空工具表」。
 *
 * 2026-11-05 现场推翻了它：预设的 plugins 从「只有绑定行」变成「绑定行 + 四个
 * 工具行」之后，宿主不再把这几个预设的模型列进模型目录——进程型 agent 整组从
 * 选择器里消失（`/api/session/modelCatalog` 的 routableProviders 从 9 个掉到
 * 4 个，掉光的正好是 codex/claude/grok/cursor/qoder/豆包）。同一份代码、只把
 * 工具行去掉，9 个立刻全部回来；宿主侧没有任何报错、也没有 failure 条目，
 * 只是不再问这几个 provider 要模型。
 *
 * 所以这条路走不通：孩子在预设里拿工具，代价是父会话里这几家 agent 用不了。
 * 给孩子的工具改由委派那一侧解决——宿主的子代理请求支持 `agentPreset`，显式
 * 指定孩子挂哪个预设（详见 superpowers 的委派服务与 docs/agent-acp/delegation-design.md）。
 *
 * 这条用例就是那次现场的门禁：谁再往预设里加插件行，这里当场红。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isModelBackedAgent } from '../src/model-plugins.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PATCH = readFileSync(`${ROOT}/cordis.patch.yml`, 'utf8')

/** patch 里一个顶层行的正文：从它自己的 - id: 行到下一个同级行（或文件尾）。 */
function presetBody(id: string): string {
  const starts = [...PATCH.matchAll(/^ {4}- id: (\S+)$/gm)]
  const index = starts.findIndex(match => match[1] === id)
  if (index === -1) throw new Error(`patch 里没有预置 ${id}`)
  const start = starts[index]?.index ?? 0
  const end = starts[index + 1]?.index ?? PATCH.length
  return PATCH.slice(start, end)
}

/** patch 里所有顶层行的 id，按出现顺序。 */
const TOP_LEVEL_IDS = [...PATCH.matchAll(/^ {4}- id: (\S+)$/gm)].map(match => match[1]!)

/** 预设声明行的 id：name 是宿主预设包，不是某个插件模块。 */
const PRESET_IDS = TOP_LEVEL_IDS.filter(id => /^ {6}name: '@deepseek-ai\/dsh-agent-preset'$/m.test(presetBody(id)))

/** 预设绑定的 agent 名（plugins 里那行 `agent: xxx`）。 */
function agentOf(preset: string): string | undefined {
  return /^ {14}agent: (\S+)$/m.exec(presetBody(preset))?.[1]
}

/**
 * 走 ACP 的预设：绑定了 agent，且那个 agent 不是宿主内自己应答的模型行。
 * 判据取自 `isModelBackedAgent` 这一份清单，不在测试里另抄一遍。
 */
const ACP_PRESETS = PRESET_IDS.filter(id => {
  const agent = agentOf(id)
  return agent !== undefined && !isModelBackedAgent(agent)
})

/** 预设 plugins 清单里的行：10 空格缩进的 - id: 及随后的 12 空格 name:。
 *  更深的 models/efforts 条目（16 空格起）不会误匹配进来。 */
function pluginRows(body: string): { id: string; name: string }[] {
  const rows: { id: string; name: string }[] = []
  const starts = [...body.matchAll(/^ {10}- id: (\S+)$/gm)]
  for (const [index, match] of starts.entries()) {
    const start = match.index ?? 0
    const end = starts[index + 1]?.index ?? body.length
    const name = /^ {12}name: '([^']+)'$/m.exec(body.slice(start, end))?.[1]
    if (name !== undefined) rows.push({ id: (match[1] ?? '').trim(), name })
  }
  return rows
}

describe('ACP 预设的 plugins 清单', () => {
  it('现算出来的 ACP 预置名单不为空，且与已知的那几个对得上', () => {
    // 名单为空会让下面的 each 一条都不跑——「全绿」其实什么都没检查。
    expect(ACP_PRESETS.length).toBeGreaterThanOrEqual(6)
    expect(ACP_PRESETS).toEqual(expect.arrayContaining(['acp-codex', 'acp-claude', 'acp-doubao']))
  })

  it.each(ACP_PRESETS)('%s 除了自己的绑定行不再挂别的插件', preset => {
    const rows = pluginRows(presetBody(preset))
    const binding = rows.filter(row => row.id === `${preset}-binding`)
    expect(binding, `${preset} 缺绑定行 ${preset}-binding`).toHaveLength(1)
    // 多挂一个插件行（尤其工具行）会让宿主把这家的模型整组从模型目录里去掉：
    // 2026-11-05 的现场，9 个 provider 掉成 4 个，界面表现是「这些 agent 都不见了」。
    expect(
      rows.map(row => row.id),
      `${preset} 的 plugins 里多了插件行。加行前先读本文件顶部的注释：` +
      '预设多挂插件会让宿主的模型目录丢掉这一家（选择器里整组消失）。',
    ).toEqual([`${preset}-binding`])
  })
})
