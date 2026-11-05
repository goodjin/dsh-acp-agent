/**
 * 用户勾了哪些模型。
 *
 * 勾选结果存在本机的一份小文件里：没勾过（没有这个文件）就是「用挂载行里声明的
 * 那一套」，勾过就以用户的意思为准。
 */

import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearSelection,
  readSelection,
  selectionFilePath,
  writeSelection,
} from '../src/model-selection.ts'

let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wb-selection-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('勾选结果', () => {
  it('默认在 DSH 目录下，按上游分开放，DSH_HOME 说了算', () => {
    expect(selectionFilePath('codex', {})).toMatch(/\.dsh\/codex\/selection\.json$/)
    expect(selectionFilePath('qoder', {})).toMatch(/\.dsh\/qoder\/selection\.json$/)
    expect(selectionFilePath('qoder', { DSH_HOME: '/tmp/x' })).toBe('/tmp/x/qoder/selection.json')
  })

  it('没勾过时是空（表示「用默认那一份」）', async () => {
    expect(await readSelection('qoder', join(dir, 'selection.json'))).toBeUndefined()
  })

  it('勾完能读回来，顺序照旧', async () => {
    const file = join(dir, 'selection.json')
    await writeSelection('qoder', ['glm-5.3', 'qoder-turbo'], file)
    expect(await readSelection('qoder', file)).toEqual(['glm-5.3', 'qoder-turbo'])
  })

  it('文件只有当前用户能读', async () => {
    const file = join(dir, 'selection.json')
    await writeSelection('qoder', ['glm-5.3'], file)
    const info = await stat(file)
    expect(info.mode & 0o777).toBe(0o600)
  })

  it('清掉之后回到「用默认那一份」', async () => {
    const file = join(dir, 'selection.json')
    await writeSelection('qoder', ['glm-5.3'], file)
    await clearSelection('qoder', file)
    expect(await readSelection('qoder', file)).toBeUndefined()
  })

  it('坏文件当没勾过，不是崩掉', async () => {
    const file = join(dir, 'selection.json')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(file, '不是 JSON', 'utf8')
    expect(await readSelection('qoder', file)).toBeUndefined()
  })
})
