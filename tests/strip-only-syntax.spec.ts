/**
 * 只准写「可擦除」的 TypeScript 语法。
 *
 * DSH 载入插件的宿主半边时走的是 Node 的 strip-only 类型擦除（不做真正的转译）：
 * 参数属性、`enum`、非 `declare` 的 `namespace` 这类**不可擦除**语法会让整个模块
 * import 失败。而失败的 Loader 行拿不到 fiber，客户端扫描（`processOne` 里
 * `entry.fiber === undefined` 就跳过）于是看不到这个包——宿主半边与浏览器半边一起
 * 消失，界面上的表现是「设置里少一页、模型前缀没了」，日志里一个字都没有。
 *
 * 2026-11-03 现场：给 `MiniMaxLoginRequiredError` 写了 `constructor(readonly reason…)`，
 * 于是整个 acp-agent 没装上，屏蔽页与模型前缀同时不见。这条测试就是那道闸。
 *
 * 构建（tsc + tsdown）用的是真编译器，这类语法它当然接受；所以不能只靠类型检查。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = fileURLToPath(new URL('../src', import.meta.url))

/** 递归列出所有 TS/TSX 源文件（跳过 node_modules）。 */
function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      if (entry === 'node_modules') continue
      out.push(...sourceFiles(path))
      continue
    }
    if (path.endsWith('.ts') || path.endsWith('.tsx')) out.push(path)
  }
  return out
}

/** 去掉注释（块注释与行注释），避免注释里的示例把自己判成违规。 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/gu, '$1')
}

/**
 * 抽出所有 `constructor(…)` 的参数表（按括号配平），只看**参数列表顶层**。
 *
 * 参数属性长这样：`constructor(readonly x: string)`——修饰符出现在参数最前面。
 * 而 `constructor(options?: { readonly maxBytes?: number })` 里的 `readonly` 是类型
 * 字面量里的属性修饰符，完全合法，不能误判。
 */
function constructorParameters(source: string): string[] {
  const blocks: string[] = []
  const marker = 'constructor('
  let index = source.indexOf(marker)
  while (index >= 0) {
    let depth = 0
    let cursor = index + marker.length - 1
    for (; cursor < source.length; cursor += 1) {
      const char = source[cursor]
      if (char === '(') depth += 1
      else if (char === ')') {
        depth -= 1
        if (depth === 0) break
      }
    }
    blocks.push(source.slice(index + marker.length, cursor))
    index = source.indexOf(marker, cursor)
  }
  return blocks
}

/** 按顶层逗号切参数（忽略 `{}`/`[]`/`()`/`<>` 里的逗号）。 */
function splitParameters(parameters: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const char of parameters) {
    if ('{[<('.includes(char)) depth += 1
    if ('}]>)'.includes(char)) depth -= 1
    if (char === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  parts.push(current)
  return parts.map(part => part.trim()).filter(part => part !== '')
}

/** 参数属性：某个参数的开头就是修饰符。 */
const PARAMETER_PROPERTY_MODIFIER = /^(?:public|private|protected|readonly)\s+[A-Za-z_$]/u

/** `enum` 声明（`const enum` 同样不可擦除）。 */
const ENUM_DECLARATION = /^\s*(?:export\s+)?(?:const\s+)?enum\s+[A-Za-z_$]/mu

/** 非 `declare` 的 `namespace`/`module` 声明。 */
const NAMESPACE_DECLARATION = /^\s*(?:export\s+)?namespace\s+[A-Za-z_$]/mu

/** 一条命中说明；没有命中返回 undefined。 */
function violationOf(rawSource: string): string | undefined {
  const source = withoutComments(rawSource)
  for (const parameters of constructorParameters(source)) {
    if (splitParameters(parameters).some(parameter => PARAMETER_PROPERTY_MODIFIER.test(parameter))) {
      return '构造函数参数属性（constructor(readonly x: T)）'
    }
  }
  if (ENUM_DECLARATION.test(source)) return 'enum 声明'
  if (NAMESPACE_DECLARATION.test(source)) return 'namespace 声明'
  return undefined
}

describe('strip-only 类型擦除能接受的语法', () => {
  it('检测器本身认得这几类写法', () => {
    expect(violationOf('class A { constructor(readonly x: string) {} }')).toContain('参数属性')
    expect(violationOf('enum Color { Red }')).toContain('enum')
    expect(violationOf('namespace Foo { }')).toContain('namespace')
    expect(violationOf('class A { constructor(private readonly y: number) {} }')).toContain('参数属性')
    expect(violationOf('class A { readonly x: string; constructor(x: string) { this.x = x } }')).toBeUndefined()
    expect(violationOf('declare namespace Foo { }')).toBeUndefined()
  })

  it('src 里没有会让模块 import 失败的写法', () => {
    const offenders = sourceFiles(SRC)
      .map(file => ({ file: file.slice(SRC.length + 1), violation: violationOf(readFileSync(file, 'utf8')) }))
      .filter((entry): entry is { file: string; violation: string } => entry.violation !== undefined)
    expect(
      offenders,
      '这些文件用了不可擦除的语法：DSH 用 strip-only 擦除，整个模块会 import 失败',
    ).toEqual([])
  })
})
