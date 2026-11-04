/**
 * 设置页「提供方与模型」读目录这条链：用**构建产物**跑一遍真实客户端路径。
 *
 * 现场报错是「读取模型目录失败：e is not a function」——一个被压缩过的 TypeError。
 * 宿主侧的 RPC 本身是好的（直接 POST `/api/session/modelCatalog` 能拿到完整目录），
 * 所以问题在浏览器半边：读目录、解析、发布快照这一段里有个调用在运行时不是函数。
 * 这份测试按页面的方式执行 `lib/client.js`（模拟 `window.__ModuleLoader__`、用页面
 * 给的 require 取 react / primitives），再驱动设置栏目的 catalog store，把真实目录
 * 喂进去——压缩后的名字藏不住问题，它照样会在这里炸。
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const BUNDLE = fileURLToPath(new URL('../lib/client.js', import.meta.url))
const CATALOG = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/model-catalog.json', import.meta.url)), 'utf8')) as {
  groups: { id: string; name: string; models: { id: string; name: string }[] }[]
  failures?: unknown[]
}

type LoadedRow = { id: string; factory: (require: (specifier: string) => unknown) => Record<string, unknown> }

/** 把产物按页面的方式执行一遍，取出它的模块导出。 */
async function loadPlugin(): Promise<Record<string, unknown>> {
  const rows: LoadedRow[] = []
  const previous = (globalThis as { window?: unknown }).window
  ;(globalThis as { window?: unknown }).window = { __ModuleLoader__: { load: (row: LoadedRow) => { rows.push(row) } } }
  try {
    await import(BUNDLE)
  } finally {
    ;(globalThis as { window?: unknown }).window = previous
  }
  expect(rows).toHaveLength(1)
  const react = await import('react')
  // 页面模块表里的基线模块：react 与 primitives（见 vitest.config.ts 的别名替身）。
  const primitives = await import('./support/primitives-stub.tsx')
  return rows[0]!.factory((specifier: string) => {
    if (specifier === 'react' || specifier === 'react/jsx-runtime') return react
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`产物请求了模块表外的模块：${specifier}`)
  })
}

/** 一个记录注册项的假 slots：settings.section 的注册项能取回它的 inject face。 */
function fakeSlots(): { inject(key: string, callback: () => unknown): unknown; register(options: Record<string, unknown>, component: unknown): () => void; entries(key: string): unknown[]; subscribe(key: string, fn: () => void): () => void; sections: Record<string, unknown>[] } {
  const sections: Record<string, unknown>[] = []
  return {
    sections,
    inject(_key: string, callback: () => unknown) {
      return callback()
    },
    register(options: Record<string, unknown>) {
      sections.push(options)
      return () => {}
    },
    entries() { return [] },
    subscribe() { return () => {} },
  }
}

// acp-agent 不把 lib/client.js 入库（.gitignore 里有 lib/），所以干净检出里没有产物。
// 这条测试跑的是产物本身，缺产物时明确跳过而不是红：本地先 `npm run build:client`。
const hasBundle = existsSync(BUNDLE)

describe.skipIf(!hasBundle)('设置页读模型目录（真实产物 + 真实目录数据）', () => {
  it('catalog store 能把目录读成 ready，ACP 分组与失败项都在', async () => {
    const plugin = await loadPlugin()
    // localStorage：真实的可见性选择存在这里，node 里没有就补一个最小实现。
    const store = new Map<string, string>()
    ;(globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value) },
    }

    const slots = fakeSlots()
    const ctx = {
      logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
      effect: (callback: () => unknown) => callback(),
      locale: { register: () => () => {} },
      get: (name: string) => (name === 'remote.session'
        ? {
          modelCatalog: async () => ({ ok: true, value: CATALOG }),
        }
        : name === 'remote'
          ? { session: { modelCatalog: async () => ({ ok: true, value: CATALOG }) } }
          : undefined),
      slots,
    }

    const apply = plugin['apply'] as (ctx: unknown, config: unknown, log?: unknown) => void
    expect(() => apply(ctx, undefined, () => {})).not.toThrow()

    const section = slots.sections.find(entry => entry['id'] === 'acp-agent-acp-visibility')
    expect(section, '设置里的「提供方与模型」应当注册进 settings.section').toBeDefined()
    const face = (section!['inject'] as () => { catalog: { load(): Promise<void>; getSnapshot(): { status: string; agents: { key: string; models: unknown[] }[]; error: unknown } } })()
    await face.catalog.load()
    const snapshot = face.catalog.getSnapshot()
    expect(snapshot.status, `目录读取失败：${JSON.stringify(snapshot.error)}`).toBe('ready')
    expect(snapshot.agents.map(agent => agent.key)).toContain('acp-codex')
    expect(snapshot.error).toBeNull()
  })
})
