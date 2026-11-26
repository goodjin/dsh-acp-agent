/**
 * 设置段「选择可用模型」用**构建产物**跑一遍真实客户端路径。
 *
 * 这条测试按页面的方式执行 `lib/client.js`（模拟 `window.__ModuleLoader__`、用页面
 * 给的 require 取 react / primitives），再把宿主 `/acp-agent/selection` 路由的读写
 * 接进去，确认设置段真的注册进 settings.section、能按 preset 读到 RAW 清单、勾选
 * 真的 POST 到宿主路由。压缩后的名字藏不住问题，它照样会在这里炸。
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const BUNDLE = fileURLToPath(new URL('../lib/client.js', import.meta.url))

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
function fakeSlots(): { inject(key: string, callback: () => unknown): unknown; register(options: Record<string, unknown>, component: unknown): () => void; sections: Record<string, unknown>[] } {
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
  }
}

// acp-agent 不把 lib/client.js 入库（.gitignore 里有 lib/），所以干净检出里没有产物。
// 这条测试跑的是产物本身，缺产物时明确跳过而不是红：本地先 `npm run build:client`。
const hasBundle = existsSync(BUNDLE)

describe.skipIf(!hasBundle)('设置段「选择可用模型」（真实产物 + 真实路由接线）', () => {
  it('设置段注册进 settings.section，读 RAW 清单、勾选 POST 到宿主路由', async () => {
    const plugin = await loadPlugin()

    // 宿主 `/acp-agent/selection` 路由的内存模型：GET 回各 preset 的 RAW 清单 + 勾选，
    // POST 落盘（这里只记最后一次）。
    const stored = new Map<string, readonly string[]>()
    const rawModels: Record<string, { id: string; name: string }[]> = {
      'acp-codex': [{ id: 'gpt-6.1-sol[low]', name: '6.1 Sol (low)' }, { id: 'gpt-6.1-sol[high]', name: '6.1 Sol (high)' }],
      'acp-grok': [{ id: 'grok-4.7', name: 'Grok 4.7' }],
    }
    let lastPost: { preset: string; ids: string[] | undefined } | undefined
    const readSelections = async () => ({
      ok: true,
      presets: Object.entries(rawModels).map(([preset, models]) => ({
        preset,
        scope: preset,
        name: preset,
        models,
        selected: stored.get(preset),
        custom: stored.has(preset),
      })),
    })
    const saveSelection = async (preset: string, ids: readonly string[] | undefined) => {
      lastPost = { preset, ids: ids === undefined ? undefined : [...ids] }
      if (ids === undefined) stored.delete(preset)
      else stored.set(preset, [...ids])
    }

    const slots = fakeSlots()
    const ctx = {
      logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
      effect: (callback: () => unknown) => callback(),
      locale: { register: () => () => {} },
      get: () => undefined,
      slots,
    }

    // 浏览器用相对路径 fetch；node 的 fetch 需要绝对 URL，这里桩一个把路径原样
    // 接到内存路由上的 fetch（页面里宿主的服务 worker / origin 会做等价的事）。
    const previousFetch = (globalThis as { fetch?: unknown }).fetch
    ;(globalThis as { fetch?: unknown }).fetch = (async (url: string | URL, init?: RequestInit) => {
      const path = String(url)
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body ?? '{}')) as { preset?: string; ids?: string[] }
        const preset = body.preset ?? ''
        if (body.ids === undefined) stored.delete(preset)
        else stored.set(preset, [...body.ids])
        lastPost = { preset, ids: body.ids === undefined ? undefined : [...body.ids] }
        return new Response(JSON.stringify({ ok: true, scope: preset }), { status: 200 })
      }
      return new Response(JSON.stringify(await readSelections()), { status: 200 })
    }) as typeof fetch

    try {
      const apply = plugin['apply'] as (ctx: unknown, config: unknown, log?: unknown) => void
      expect(() => apply(ctx, undefined, () => {})).not.toThrow()

      const section = slots.sections.find(entry => entry['id'] === 'acp-agent-acp-selection')
      expect(section, '设置段「选择可用模型」应当注册进 settings.section').toBeDefined()
      const face = (section!['inject'] as () => Record<string, unknown>)()
      expect(typeof face['readSelections']).toBe('function')
      expect(typeof face['saveSelection']).toBe('function')

      const reply = await (face['readSelections'] as () => Promise<unknown>)()
      const parsed = reply as { ok: boolean; presets: { preset: string; models: { id: string }[] }[] }
      expect(parsed.ok).toBe(true)
      expect(parsed.presets.map(p => p.preset)).toEqual(['acp-codex', 'acp-grok'])
      expect(parsed.presets[0]?.models.map(m => m.id)).toEqual(['gpt-6.1-sol[low]', 'gpt-6.1-sol[high]'])

      // 模拟勾选落盘：保存 codex 的一个子集。
      await (face['saveSelection'] as (p: string, ids: readonly string[] | undefined) => Promise<void>)('acp-codex', ['gpt-6.1-sol[low]'])
      expect(lastPost).toEqual({ preset: 'acp-codex', ids: ['gpt-6.1-sol[low]'] })
    } finally {
      ;(globalThis as { fetch?: unknown }).fetch = previousFetch
    }
  })
})
