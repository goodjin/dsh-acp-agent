/**
 * 配额胶囊的挂载接线：浏览器半边必须**按口径各挂一只**。
 *
 * 2026-11 现场：迁进本仓时（2026-11-02 从 threadharbor 的 dsh-client 并过来）
 * 丢掉了「每个口径一只轮询器、各挂一条 dock」这段装配，只剩 GLM 一套，而且
 * 那只轮询器建好之后**从没 start 过**——于是：
 *
 * - 轮询器不跑 → 快照永远是 undefined → 胶囊整行不渲染（哪一家都不出现）；
 * - 只有一条 dock 条目、只有一条路由 → 就算轮询器跑了，选 MiniMax/Codex/Claude
 *   的模型时也没有对应的条目去画。
 *
 * 宿主那几条路由（/threadharbor/minimax/quota 等）都好好挂着，取数也正常，
 * 缺的是浏览器这半边的装配——所以界面上一个字都没有。
 *
 * 这里钉三件事：
 * 1. 每个口径都挂一条 dock 条目（id 逐个对上）；
 * 2. 每只轮询器都真的开跑（start 会立刻问一次路由）；
 * 3. 每只轮询器问的是**自己那条**路由（GLM 那条与 MiniMax 那条不是同一个）。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.ts'
import { QUOTA_PILL_SPECS } from '../src/client/quota-pill.ts'

interface DockEntry {
  readonly name?: string
  readonly id?: string
  readonly order?: number
}

/** 假宿主：只给 apply 用到的三样（slots / get / effect），其余让它安静退回。 */
function fakeHost(): {
  ctx: unknown
  registered: DockEntry[]
  dispose: () => void
} {
  const registered: DockEntry[] = []
  const disposers: (() => void)[] = []
  const slots = {
    inject(key: string, callback: () => unknown): () => void {
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose as () => void)
      return () => {}
    },
    register(options: Record<string, unknown>): () => void {
      registered.push(options as DockEntry)
      return () => {}
    },
  }
  const ctx = {
    slots,
    get: () => undefined,
    effect(callback: () => unknown): unknown {
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose as () => void)
      return dispose
    },
  }
  return {
    ctx,
    registered,
    dispose: () => { for (const dispose of disposers.splice(0)) dispose() },
  }
}

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

describe('配额胶囊的浏览器装配', () => {
  it('每个口径都挂一条 dock 条目，各挂各的', () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true, quota: {} }), { status: 200 })) as unknown as typeof fetch
    const host = fakeHost()
    try {
      apply(host.ctx, undefined, () => {})
      const dockIds = host.registered
        .filter(entry => entry.name === 'conversation.composer.dock')
        .map(entry => entry.id)
      expect(dockIds).toEqual(QUOTA_PILL_SPECS.map(spec => spec.dockId))
    } finally {
      host.dispose()
    }
  })

  it('每只轮询器都开跑，而且问的是自己那条路由', async () => {
    const asked: string[] = []
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      asked.push(String(input))
      return new Response(JSON.stringify({ ok: true, quota: {} }), { status: 200 })
    }) as unknown as typeof fetch
    const host = fakeHost()
    try {
      apply(host.ctx, undefined, () => {})
      // start() 会立刻问一次；轮询间隔很长，等第二次没有意义。
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(asked).toEqual(QUOTA_PILL_SPECS.map(spec => spec.routePath))
    } finally {
      host.dispose()
    }
  })
})
