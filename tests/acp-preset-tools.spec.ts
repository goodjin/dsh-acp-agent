/**
 * ACP 预设的 plugins 清单要带 DSH 工具行。
 *
 * ACP 预设自己的回合由外部 agent（codex/claude/grok/cursor/qoder）驱动，DSH 的
 * bash/fs 工具在父会话里不会被用到；但 DSH 侧起的孩子继承父会话的预设组合——
 * 预设清单里没有工具行的话，孩子拿到的就是一张空工具表，读写文件、跑命令都
 * 干不了。所以每个走 ACP 的预设都在 plugins 清单末尾挂上与 superpowers 预设
 * 同名的四个宿主工具包。acp-zcode / acp-minimax 是模型插件路线，不走 ACP，
 * 不带这四行。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PATCH = readFileSync(`${ROOT}/cordis.patch.yml`, 'utf8')

/** 走 ACP 的预设；zcode/minimax 是模型插件路线，不在此列。 */
const ACP_PRESETS = ['acp-codex', 'acp-claude', 'acp-grok', 'acp-cursor', 'acp-qoder'] as const

/** 每个预设都该有的工具行：id 在预设内唯一，name 是宿主包名（与 superpowers 预设一致）。 */
const TOOL_ROWS = [
  { id: 'acp-tool-bash', name: '@deepseek-ai/dsh-tool-bash' },
  { id: 'acp-tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
  { id: 'acp-tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search' },
  { id: 'acp-tool-todo', name: '@deepseek-ai/dsh-tool-todo' },
] as const

/** patch 里一个顶层预设的正文：从它自己的 - id: 行到下一个同级行（或文件尾）。 */
function presetBody(id: string): string {
  const starts = [...PATCH.matchAll(/^ {4}- id: (\S+)$/gm)]
  const index = starts.findIndex(match => match[1] === id)
  if (index === -1) throw new Error(`patch 里没有预设 ${id}`)
  const start = starts[index]?.index ?? 0
  const end = starts[index + 1]?.index ?? PATCH.length
  return PATCH.slice(start, end)
}

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
