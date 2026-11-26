/**
 * 声明清单里的每个模型都得带上下文窗口。
 *
 * 宿主的上下文压缩（dsh-compaction-basic）在压缩前经 resolveModel 要
 * `context.contextWindow`；拿不到就以 "no context capacity … configure
 * contextWindow on that adapter model" 失败，整个模型切换在压缩这一步被拒
 * （2026-11-07 现场：切到 zcode 的 GLM-5.3-Flash、切到 workbuddy 的
 * glm-5.3-flash，都是同一个错）。
 *
 * 适配器层的行为已有 catalog-context-window.spec.ts 覆盖，但那一层只证明
 * 「清单里写了就交得出去」。清单本身漏写时，没有任何测试会红——codex / claude
 * / grok / cursor / qoder-cn / doubao 这些 ACP 行就是这样漏下来的，每条都让
 * 切到该行的模型直接失败。
 *
 * 所以这一层断言清单本身：每条模型行都声明了窗口，且是宿主认的正整数。
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { catalogAdapter, providerRoute } from '../src/catalog.ts'

/** 包根：声明清单在这里。 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 一条声明的模型：id 与可选的窗口。 */
type DeclaredModel = { id: string; name: string; contextWindow?: number }

/**
 * 补丁里每个 agent 行的声明模型清单。
 *
 * 只认本仓自己的行（`- id: acp-<agent>` 开头的那层），行内 `models:` 段里的
 * 条目按缩进取：模型条目的 id 在 16 空格缩进，窗口字段在它下面。
 */
function declaredModelsByRow(): Map<string, DeclaredModel[]> {
  const text = readFileSync(resolve(ROOT, 'cordis.patch.yml'), 'utf8')
  const lines = text.split('\n')
  const rows = new Map<string, DeclaredModel[]>()
  let row: string | undefined
  let inModels = false
  let current: DeclaredModel | undefined
  const flush = (): void => {
    if (row !== undefined && current !== undefined) rows.get(row)?.push(current)
    current = undefined
  }
  for (const line of lines) {
    const rowMatch = /^ {4}- id: (acp-\S+)$/.exec(line)
    if (rowMatch !== null) {
      flush()
      row = rowMatch[1] ?? undefined
      if (row !== undefined) rows.set(row, [])
      inModels = false
      continue
    }
    if (row === undefined) continue
    if (/^ {14}models:$/.test(line)) {
      flush()
      inModels = true
      continue
    }
    // 离开 models 段（回到更浅的缩进且不是模型条目）。
    if (inModels && /^ {12,14}\S/.test(line) && !/^ {16}- id: /.test(line)) inModels = false
    if (!inModels) continue
    const idMatch = /^ {16}- id: (.+)$/.exec(line)
    if (idMatch !== null) {
      flush()
      current = { id: (idMatch[1] ?? '').replace(/^["']|["']$/g, ''), name: '' }
      continue
    }
    // 显示名：折叠时按 name 归并（claude 那五行同名压成一行），缺了它
    // 折叠那一步就会崩——所以这里按真实清单的形状读，不省。
    const nameMatch = /^ {18}name: (.+)$/.exec(line)
    if (nameMatch !== null && current !== undefined) {
      current.name = (nameMatch[1] ?? '').replace(/^["']|["']$/g, '')
      continue
    }
    const windowMatch = /^ {18}contextWindow: (\d+)$/.exec(line)
    if (windowMatch !== null && current !== undefined) {
      current.contextWindow = Number(windowMatch[1])
    }
  }
  flush()
  return rows
}

/**
 * 本仓的 ACP 模型行——每一条都要服务宿主压缩。
 */
const AGENT_ROWS = [
  'acp-codex',
  'acp-claude',
  'acp-grok',
  'acp-cursor',
  'acp-zcode',
  'acp-minimax',
] as const

describe('声明清单的上下文窗口', () => {
  it('每条 ACP 模型行都声明了模型', () => {
    const rows = declaredModelsByRow()
    for (const row of AGENT_ROWS) {
      expect(rows.get(row)?.length ?? 0, `${row} 没声明任何模型`).toBeGreaterThan(0)
    }
  })

  it('窗口真的交到了宿主手里（适配器按清单答）', async () => {
    // 前一条断言只证明清单里写了字；这一条走宿主那条路：压缩经 resolveModel
    // 要 `context.contextWindow`，适配器要按声明清单原样交出来。清单写了而
    // 通路没接上，切模型照样死在压缩那一步（2026-11-07 现场）。
    const rows = declaredModelsByRow()
    for (const row of AGENT_ROWS) {
      const models = rows.get(row) ?? []
      const adapter = catalogAdapter(
        { presets: { [row]: { agent: 'codex', models: models.map(m => ({ ...m })) } } },
        { modelsOf: presetId => (presetId === row ? models.map(m => ({ ...m })) : []), dialectOf: () => undefined },
      )
      for (const model of models) {
        const resolved = await adapter.resolveModel(providerRoute(row), model.id)
        expect(resolved.context, `${row}/${model.id} 的窗口没到 resolveModel 的返回值`).toEqual({ contextWindow: model.contextWindow })
      }
    }
  })

  it('每个声明的模型都带上了上下文窗口', () => {
    const rows = declaredModelsByRow()
    const missing: string[] = []
    for (const row of AGENT_ROWS) {
      for (const model of rows.get(row) ?? []) {
        if (model.contextWindow === undefined) missing.push(`${row}/${model.id}`)
      }
    }
    expect(missing, `这些模型没声明 contextWindow，切到它们会在压缩那步被拒`).toEqual([])
  })

  it('窗口是宿主认的正整数（压缩要拿它算阈值）', () => {    const rows = declaredModelsByRow()
    for (const row of AGENT_ROWS) {
      for (const model of rows.get(row) ?? []) {
        if (model.contextWindow === undefined) continue
        expect(Number.isInteger(model.contextWindow), `${row}/${model.id}`).toBe(true)
        expect(model.contextWindow, `${row}/${model.id}`).toBeGreaterThan(0)
      }
    }
  })
})

describe('折叠后的基座也带窗口', () => {
  it('codex 那种 base[effort] 的行，选择器选的是基座，窗口要跟过去', async () => {
    // 选择器把 codex/claude 的 base[effort] 压成一行，用户选的是基座 id；
    // 宿主压缩拿的正是那个基座。窗口若只在带后缀的条目上，基座就没有窗口，
    // 切到它照样死在压缩那一步。
    const rows = declaredModelsByRow()
    const codex = rows.get('acp-codex') ?? []
    const suffixed = codex.filter(model => model.id.includes('['))
    expect(suffixed.length, 'codex 行应当有带 [effort] 后缀的模型').toBeGreaterThan(0)
    const adapter = catalogAdapter(
      { presets: { 'acp-codex': { agent: 'codex', models: codex.map(m => ({ ...m })) } } },
      { modelsOf: () => codex.map(m => ({ ...m })), dialectOf: () => undefined },
    )
    for (const model of suffixed) {
      const base = model.id.replace(/\[[^\]]+\]$/, '')
      const resolved = await adapter.resolveModel(providerRoute('acp-codex'), base)
      expect(resolved.context, `基座 ${base} 没带上窗口`).toEqual({ contextWindow: model.contextWindow })
    }
  })
})
