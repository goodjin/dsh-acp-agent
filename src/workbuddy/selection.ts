/**
 * 用户勾选了哪些模型。
 *
 * 勾选结果存在本机（跟凭据放在一起）：`~/.dsh/workbuddy/selection.json`。
 *
 * 有这个文件就以它为准（用户在设置里勾的），没有就用挂载行里声明的那份——所以
 * 「装上就有默认的一套，用户可以在设置里改」这条规矩成立。
 */

import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 勾选结果文件相对 DSH 目录的位置。 */
const SELECTION_RELATIVE_PATH = 'workbuddy/selection.json'

/**
 * 勾选结果文件的位置。
 * @param env - 环境变量。
 * @returns 路径。
 */
export function selectionFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env['DSH_HOME'] !== undefined && env['DSH_HOME'] !== ''
    ? env['DSH_HOME']
    : join(homedir(), '.dsh')
  return join(home, ...SELECTION_RELATIVE_PATH.split('/'))
}

/**
 * 读出勾选结果。
 * @param file - 文件；缺省用默认位置。
 * @returns 勾了的模型 id；没勾过（没有这个文件）是 `undefined`。
 */
export async function readSelection(file?: string): Promise<readonly string[] | undefined> {
  const path = file ?? selectionFilePath()
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

/**
 * 把勾选结果写下来。
 * @param ids - 勾了的模型 id。
 * @param file - 文件；缺省用默认位置。
 */
export async function writeSelection(ids: readonly string[], file?: string): Promise<void> {
  const path = file ?? selectionFilePath()
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await chmod(dirname(path), 0o700).catch(() => {})
  await writeFile(path, JSON.stringify({ ids: [...ids] }), { encoding: 'utf8', mode: 0o600 })
  await chmod(path, 0o600).catch(() => {})
}

/**
 * 清掉勾选结果（回到挂载行里声明的那份）。
 * @param file - 文件；缺省用默认位置。
 */
export async function clearSelection(file?: string): Promise<void> {
  const path = file ?? selectionFilePath()
  await rm(path, { force: true }).catch(() => {})
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
