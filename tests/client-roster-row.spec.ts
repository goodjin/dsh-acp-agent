/**
 * 浏览器半边有没有「挂载行」。
 *
 * DSH 不是看到 package.json 的 dsh.client 就自动把浏览器打包塞进页面的：客户端
 * 模块系统扫的是 Loader 的行，只有某行的 name 恰好等于包名（裸包名，不带子路径）
 * 时，那个包才会被认成一行客户端插件（`ClientModuleRegistry.resolveMeta` →
 * `locatePkgJson`，子路径行会被判成「不是客户端行」）。所以浏览器半边要一份
 * 「只挂名、不干活」的行；没有这一行，整个浏览器插件—包括设置里的「屏蔽提供方
 * 与模型」—会安静地消失，宿主日志里一个字都没有。
 *
 * 2026-11-02 现场：包名改到 @goodjin2、挂载行从 threadharbor 搬到本仓库自带的
 * cordis.patch.yml 之后，patch 里只剩 roster-filter / zcode-quota 这类子路径行
 * 和 preset 内部的 binding 行，没有裸包名行，于是 window.__DSH_BOOT__ 里没有
 * 本包，设置项与配额胶囊、ACP 过程视图一起不见了。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { apply } from '../src/entry.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PATCH = readFileSync(`${ROOT}/cordis.patch.yml`, 'utf8')
const PACKAGE = JSON.parse(readFileSync(`${ROOT}/package.json`, 'utf8')) as {
  name: string
  dsh?: { client?: { platform?: string } }
}

/** The rows the bundle patch inserts: id, Loader name, and the row's own body. */
function insertRows(patch: string): { id: string; name: string; body: string }[] {
  const rows: { id: string; name: string; body: string }[] = []
  const starts = [...patch.matchAll(/^ {4}- id: (.+)$/gm)]
  for (const [index, match] of starts.entries()) {
    const start = match.index ?? 0
    const end = starts[index + 1]?.index ?? patch.length
    const body = patch.slice(start, end)
    const name = /^ {6}name: '([^']+)'$/m.exec(body)?.[1]
    if (name !== undefined) rows.push({ id: (match[1] ?? '').trim(), name, body })
  }
  return rows
}

describe('浏览器半边的挂载行', () => {
  it('patch 里有一行以裸包名挂载本包', () => {
    expect(PACKAGE.dsh?.client?.platform, '这个包声明了浏览器半边').toBe('web')
    const bare = insertRows(PATCH).filter(row => row.name === PACKAGE.name)
    expect(
      bare.map(row => row.id),
      `没有任何一行以裸包名 ${PACKAGE.name} 挂载：浏览器半边不会被装载`,
    ).not.toEqual([])
  })

  it('那一行只挂名，不挂载 ACP 行（presetId 只为过校验）', () => {
    const row = insertRows(PATCH).find(candidate => candidate.name === PACKAGE.name)
    expect(row, '先有裸包名行').toBeDefined()
    expect(row?.body, '这一行必须声明 clientOnly，否则会在根作用域挂一条 ACP 行').toMatch(/^ {8}clientOnly: true$/m)
  })
})

describe('clientOnly 行挂在根作用域时不干活', () => {
  it('既不监听事件也不写 stderr', () => {
    const touched: string[] = []
    const stderr: string[] = []
    const original = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: unknown) => {
      stderr.push(String(chunk))
      return true
    }) as typeof process.stderr.write
    try {
      const ctx = {
        on: () => { touched.push('on'); return () => {} },
        get: () => { touched.push('get'); return undefined },
        emit: () => { touched.push('emit'); return undefined },
        logger: {
          info: () => { touched.push('info') },
          warn: () => { touched.push('warn') },
        },
      }
      expect(() => apply(ctx, {
        clientOnly: true,
        presetId: 'acp-client-roster',
        agent: 'codex',
      })).not.toThrow()
    } finally {
      process.stderr.write = original
    }
    expect(touched, '只挂名的行不该碰宿主').toEqual([])
    expect(stderr, '只挂名的行不该往 stderr 说话').toEqual([])
  })
})
