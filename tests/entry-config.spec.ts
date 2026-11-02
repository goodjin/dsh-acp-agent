/**
 * 入口配置的「配了有没有人读」检查。
 *
 * Config schema 里声明的每个字段都必须被生产代码读过——配了等于没配的
 * 字段比缺字段更糟：用户以为自己配置了行为，实际什么都没发生。原检查在
 * threadharbor 根 tests/wiring.spec.ts，随包独立后搬进本仓库。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = fileURLToPath(new URL('../src', import.meta.url))

describe('配置项配了有没有人读', () => {
  it('入口配置里每个字段都被生产代码读过', () => {
    const entry = readFileSync(`${SRC}/entry.ts`, 'utf8')
    const start = entry.indexOf('export const Config')
    const end = entry.indexOf('\n})', start)
    const schema = entry.slice(start, end === -1 ? undefined : end)
    const fields = [...schema.matchAll(/^ {2}(\w+):/gm)].map(match => match[1])

    const consumers = ['entry.ts', 'plugin.ts', 'registry.ts', 'factory.ts', 'service.ts']
      .map(file => readFileSync(`${SRC}/${file}`, 'utf8'))
      .join('\n')

    const unread = fields.filter(field => new RegExp(`config\\.${field}\\b`).test(consumers) === false)
    expect(unread, '这些配置字段没有任何代码读过，配了等于没配').toEqual([])
  })
})
