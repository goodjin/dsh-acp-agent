/**
 * ACP 预设的 plugins 清单要带 DSH 工具行。
 *
 * ACP 预设自己的回合由外部 agent（codex/claude/grok/cursor/qoder/豆包）驱动，
 * DSH 的 bash/fs 工具在父会话里不会被用到；但 DSH 侧起的孩子继承父会话的预设
 * 组合——预设清单里没有工具行的话，孩子拿到的就是一张空工具表，读写文件、跑
 * 命令都干不了。所以每个走 ACP 的预设都在 plugins 清单末尾挂上与 superpowers
 * 预设同名的四个宿主工具包。模型插件路线的行（zcode/minimax/workbuddy/
 * qoder-global）不走 ACP，不带这四行。
 *
 * **这份名单是从 patch 现算的，不是手写的**：手写名单漏一个，表现是「那一个
 * 预设的委派子会话拿到空工具表」——不报错、不掉行，只有孩子真的去读文件时才
 * 露出来。2026-11-05 豆包预设就是这么漏掉的（它的行后加，手写名单没跟上）。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isModelBackedAgent } from '../src/model-plugins.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PATCH = readFileSync(`${ROOT}/cordis.patch.yml`, 'utf8')

/** 每个预设都该有的工具行：id 在预设内唯一，name 是宿主包名（与 superpowers 预设一致）。 */
const TOOL_ROWS = [
  { id: 'acp-tool-bash', name: '@deepseek-ai/dsh-tool-bash' },
  { id: 'acp-tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
  { id: 'acp-tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search' },
  { id: 'acp-tool-todo', name: '@deepseek-ai/dsh-tool-todo' },
] as const

/** patch 里一个顶层行的正文：从它自己的 - id: 行到下一个同级行（或文件尾）。 */
function presetBody(id: string): string {
  const starts = [...PATCH.matchAll(/^ {4}- id: (\S+)$/gm)]
  const index = starts.findIndex(match => match[1] === id)
  if (index === -1) throw new Error(`patch 里没有预设 ${id}`)
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

describe('ACP 预设的 DSH 工具行', () => {
  it('现算出来的 ACP 预设名单不为空，且与已知的那几个对得上', () => {
    // 名单为空会让下面的 each 一条都不跑——「全绿」其实什么都没检查。
    expect(ACP_PRESETS.length).toBeGreaterThanOrEqual(6)
    expect(ACP_PRESETS).toEqual(expect.arrayContaining(['acp-codex', 'acp-claude', 'acp-doubao']))
  })

  it.each(ACP_PRESETS)('%s 的 plugins 清单里有四个 DSH 工具行', preset => {
    const rows = pluginRows(presetBody(preset))
    for (const tool of TOOL_ROWS) {
      expect(
        rows,
        `${preset} 预设缺工具行 ${tool.name}（DSH 侧子会话会拿到空工具表）`,
      ).toContainEqual(tool)
    }
  })
})
