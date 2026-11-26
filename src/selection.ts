/**
 * 用户勾选了哪些模型（按 ACP 预设分开放）。
 *
 * 正向白名单：勾选 = 进选择器，不勾 = 完全不展示。勾选结果存在本机
 * `${DSH_HOME}/<scope>/selection.json`（与 dsh-codex 同一套规矩：有文件就以它
 * 为准，没有就用挂载行里声明的那份——「装上就有默认的一套，用户可以在设置里
 * 改」这条成立）。
 *
 * 内置 6 条 ACP preset 各用一个 scope，落盘目录互不撞（独立仓 codex 用 `codex`，
 * 本插件内置用 `acp-codex`/`acp-claude`/…）：
 *
 * | preset     | scope         | 落盘路径                                     |
 * |------------|---------------|----------------------------------------------|
 * | acp-codex  | `acp-codex`   | `${DSH_HOME}/acp-codex/selection.json`        |
 * | acp-claude | `acp-claude`  | `${DSH_HOME}/acp-claude/selection.json`       |
 * | acp-grok   | `acp-grok`    | `${DSH_HOME}/acp-grok/selection.json`         |
 * | acp-cursor | `acp-cursor`  | `${DSH_HOME}/acp-cursor/selection.json`       |
 * | acp-zcode  | `acp-zcode`   | `${DSH_HOME}/acp-zcode/selection.json`        |
 * | acp-minimax| `acp-minimax` | `${DSH_HOME}/acp-minimax/selection.json`      |
 *
 * 模型行发布清单是同步路径（`catalogAdapter.modelsFor`），而读文件是异步的；
 * 所以这里同时留一份内存快照：启动时 `loadAllSelections()` 把 6 个 scope 各读
 * 一次进内存，模型行只读内存。设置里改完勾选既落盘也换快照，再让模型行重新
 * 发布一次，改动当场生效。
 */

import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * 本插件负责白名单的内置 preset scope 清单。
 *
 * 与 `cordis.patch.yml` 里的 6 条 preset 行一一对应；独立仓（codex/grok/…）
 * 用不带 `acp-` 前缀的 scope，互不干扰。
 */
export const ACP_SELECTION_SCOPES: readonly string[] = [
  'acp-codex',
  'acp-claude',
  'acp-grok',
  'acp-cursor',
  'acp-zcode',
  'acp-minimax',
]

/**
 * 勾选结果文件的位置。
 * @param scope - 预设的名字（`acp-codex`、`acp-claude`…）。
 * @param env - 环境变量。
 * @returns 路径。
 */
export function selectionFilePath(scope: string, env: NodeJS.ProcessEnv = process.env): string {
  const home = env['DSH_HOME'] !== undefined && env['DSH_HOME'] !== ''
    ? env['DSH_HOME']
    : join(homedir(), '.dsh')
  return join(home, scope, 'selection.json')
}

/** 一份 scope 的当前生效勾选：`undefined` = 没勾过（默认那一份全在）。 */
const snapshots = new Map<string, readonly string[] | undefined>()

/** scope 是否由本插件负责（内置 6 条 preset 之一）。 */
export function isAcpSelectionScope(scope: string): boolean {
  return ACP_SELECTION_SCOPES.includes(scope)
}

/** 读出某 scope 当前生效的勾选（内存快照；还没加载过是 `undefined`）。 */
export function currentSelection(scope: string): readonly string[] | undefined {
  return snapshots.get(scope)
}

/**
 * 把某 scope 的勾选写进内存快照（不落盘）。
 * @param scope - 预设的名字。
 * @param ids - 用户勾的 id；`undefined` 表示回到默认那一份（全在）。
 */
export function setCurrentSelection(scope: string, ids: readonly string[] | undefined): void {
  if (!isAcpSelectionScope(scope)) return
  snapshots.set(scope, ids === undefined ? undefined : [...ids])
}

/**
 * 从磁盘把某个 scope 的勾选读进内存快照。
 *
 * 模型行第一次发布清单前就该知道用户勾了哪些。没有文件（首次升级）= `undefined`
 * = 默认那一份全在，升级不破坏现状。
 * @param scope - 预设的名字。
 * @param env - 环境变量（测试用）。
 * @returns 读到的勾选；没有文件是 `undefined`。
 */
export async function loadSelection(scope: string, env: NodeJS.ProcessEnv = process.env): Promise<readonly string[] | undefined> {
  const ids = await readSelection(scope, undefined, env)
  if (isAcpSelectionScope(scope)) snapshots.set(scope, ids)
  return ids
}

/**
 * 启动时把所有内置 preset 的勾选各读一次进内存快照。
 * @param env - 环境变量（测试用）。
 * @returns scope → 勾选的映射（没有文件的 scope 不在 map 里，按默认全在处理）。
 */
export async function loadAllSelections(env: NodeJS.ProcessEnv = process.env): Promise<Map<string, readonly string[]>> {
  const out = new Map<string, readonly string[]>()
  for (const scope of ACP_SELECTION_SCOPES) {
    const ids = await loadSelection(scope, env)
    if (ids !== undefined) out.set(scope, ids)
  }
  return out
}

/** 读出某 scope 落盘的勾选；没文件是 `undefined`。 */
export async function readSelection(scope: string, file?: string, env: NodeJS.ProcessEnv = process.env): Promise<readonly string[] | undefined> {
  const path = file ?? selectionFilePath(scope, env)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return undefined
  }
  try {
    const parsed = JSON.parse(text) as unknown
    if (!isRecord(parsed)) return undefined
    const ids = parsed['ids']
    if (!Array.isArray(ids)) return undefined
    return ids.filter((id): id is string => typeof id === 'string' && id !== '')
  } catch {
    return undefined
  }
}

/** 把某 scope 的勾选落盘 + 换内存快照。 */
export async function writeSelection(scope: string, ids: readonly string[], file?: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const path = file ?? selectionFilePath(scope, env)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await chmod(dirname(path), 0o700).catch(() => {})
  await writeFile(path, JSON.stringify({ ids: [...ids] }), { encoding: 'utf8', mode: 0o600 })
  await chmod(path, 0o600).catch(() => {})
  if (isAcpSelectionScope(scope)) snapshots.set(scope, [...ids])
}

/** 删掉某 scope 的落盘文件（回到默认那一份：全在）。 */
export async function clearSelection(scope: string, file?: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await rm(file ?? selectionFilePath(scope, env), { force: true }).catch(() => {})
  if (isAcpSelectionScope(scope)) snapshots.set(scope, undefined)
}

/**
 * 按勾选过滤模型清单（正向白名单）。
 *
 * 语义：
 * - `undefined`（没勾过）→ 原样返回（默认那一份全都在）；
 * - 空数组（一个都不勾）→ 当作没勾过，原样返回。一条模型行挂零个模型是最坏的
 *   状态：当前型号从目录里消失，输入框里的强度轴跟着消失，宿主把那次选择退
 *   回去并报错。想停用这一行，把行从 profile 里摘掉，而不是把模型全勾没了；
 * - 有值 → 只留勾中的那几个。
 *
 * @param models - 整份模型清单。
 * @param selection - 勾选；`undefined` 表示没勾过。
 * @returns 过滤后的清单。
 */
export function applySelection<T extends { readonly id: string }>(
  models: readonly T[],
  selection: readonly string[] | undefined = undefined,
): readonly T[] {
  if (selection === undefined) return models
  if (selection.length === 0) return models
  const wanted = new Set(selection)
  return models.filter(model => wanted.has(model.id))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
