/**
 * 正向白名单（per-preset selection）的读写与语义：
 * - src/selection.ts 的落盘路径、读写、applySelection 语义（undefined=全在、
 *   空数组=全在防零模型、有值=只留勾中的）；
 * - selection-route 的 GET 列 RAW 清单 + POST 落盘，非本插件 preset 回 not-ours。
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applySelection,
  clearSelection,
  currentSelection,
  loadAllSelections,
  loadSelection,
  readSelection,
  selectionFilePath,
  writeSelection,
} from '../src/selection.ts'
import { apply, notOurs, registerSelectionRoute, SELECTION_ROUTE_PATH } from '../src/selection-route.ts'

let dir = ''
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'wb-selroute-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('selection 落盘路径', () => {
  it('按 scope 分开放，DSH_HOME 说了算', () => {
    expect(selectionFilePath('acp-codex', { DSH_HOME: '/tmp/x' })).toBe('/tmp/x/acp-codex/selection.json')
    expect(selectionFilePath('acp-grok', { DSH_HOME: '/tmp/x' })).toBe('/tmp/x/acp-grok/selection.json')
  })
})

describe('applySelection 语义（正向白名单）', () => {
  const models = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  it('undefined（没勾过）→ 原样返回，默认全在', () => {
    expect(applySelection(models, undefined)).toEqual(models)
  })
  it('空数组（一个都不勾）→ 当作没勾过，原样返回，防零模型', () => {
    expect(applySelection(models, [])).toEqual(models)
  })
  it('有值 → 只留勾中的那几个', () => {
    expect(applySelection(models, ['a', 'c'])).toEqual([{ id: 'a' }, { id: 'c' }])
  })
  it('勾了不存在的 id → 只留真有的', () => {
    expect(applySelection(models, ['a', 'zzz'])).toEqual([{ id: 'a' }])
  })
})

describe('读写与内存快照', () => {
  it('写进去能读回来，顺序照旧', async () => {
    await writeSelection('acp-codex', ['glm-5.3', 'qoder-turbo'], join(dir, 'codex.json'))
    expect(await readSelection('acp-codex', join(dir, 'codex.json'))).toEqual(['glm-5.3', 'qoder-turbo'])
  })
  it('没勾过是 undefined', async () => {
    expect(await readSelection('acp-grok', join(dir, 'absent.json'))).toBeUndefined()
  })
  it('清掉之后回到 undefined', async () => {
    const file = join(dir, 'grok.json')
    await writeSelection('acp-grok', ['grok-4.7'], file)
    await clearSelection('acp-grok', file)
    expect(await readSelection('acp-grok', file)).toBeUndefined()
  })
  it('坏文件当没勾过，不崩', async () => {
    const { writeFile } = await import('node:fs/promises')
    const file = join(dir, 'bad.json')
    await writeFile(file, 'not json', 'utf8')
    expect(await readSelection('acp-codex', file)).toBeUndefined()
  })
  it('loadSelection / currentSelection：启动时读进快照', async () => {
    await writeSelection('acp-codex', ['a'], join(dir, 'codex.json'))
    const env = { DSH_HOME: dir }
    // 注意：writeSelection 用 join(dir,'codex.json')，但 loadSelection 走 DSH_HOME 默认路径，
    // 所以这里直接写一个 DSH_HOME 布局的文件。
    await writeSelection('acp-codex', ['b'], undefined, env)
    const loaded = await loadSelection('acp-codex', env)
    expect(loaded).toEqual(['b'])
    expect(currentSelection('acp-codex')).toEqual(['b'])
  })
  it('loadAllSelections：读全部内置 scope，无文件的不进 map', async () => {
    const env = { DSH_HOME: dir }
    await writeSelection('acp-codex', ['x'], undefined, env)
    await writeSelection('acp-minimax', ['y'], undefined, env)
    const all = await loadAllSelections(env)
    expect(all.get('acp-codex')).toEqual(['x'])
    expect(all.get('acp-minimax')).toEqual(['y'])
    expect(all.has('acp-grok')).toBe(false)
  })
})

/** 注册路由时的假 webServer / connection。 */
function fakeHost() {
  const routes = new Map<string, (req: { method?: string }, res: { writeHead(s: number, h?: Record<string, string>): void; end(b: string): void }) => void>()
  return {
    routes,
    ctx: {
      effect: (fn: () => unknown) => fn(),
      webServer: {
        register: (route: { path: string; handler: (req: unknown, res: unknown) => void | Promise<void> }) => {
          routes.set(route.path, route.handler as never)
          return () => {}
        },
      },
      connection: { admit: () => ({ peer: {} }) },
    } as never,
  }
}

describe('selection-route', () => {
  it('GET 列出各 preset 的 RAW 模型清单 + 勾选；POST 落盘', async () => {
    const { ctx, routes } = fakeHost()
    const config = {
      presets: {
        'acp-codex': { agent: 'codex' },
        'acp-grok': { agent: 'grok' },
      },
    }
    const written: { scope: string; ids: string[] }[] = []
    registerSelectionRoute(ctx, {
      configOf: () => config as never,
      modelsOf: presetId => presetId === 'acp-codex'
        ? [{ id: 'gpt-6.1-sol[low]', name: '6.1 Sol (low)' }, { id: 'gpt-6.1-sol[high]', name: '6.1 Sol (high)' }]
        : presetId === 'acp-grok'
          ? [{ id: 'grok-4.7', name: 'Grok 4.7' }]
          : [],
      persist: {
        write: async (scope, ids) => { written.push({ scope, ids: [...ids] }) },
        clear: async () => {},
      },
    })
    const handler = routes.get(SELECTION_ROUTE_PATH)
    expect(handler).toBeDefined()

    // GET：列出全部 6 个内置 scope；未配置清单的 preset 给空 models。
    const reply = await callJson(handler!, 'GET')
    expect(reply['ok']).toBe(true)
    const presets = reply['presets'] as { preset: string; models: { id: string }[]; name: string }[]
    expect(presets.map(p => p.preset)).toEqual(['acp-codex', 'acp-claude', 'acp-grok', 'acp-cursor', 'acp-zcode', 'acp-minimax'])
    const codex = presets.find(p => p.preset === 'acp-codex')
    expect(codex?.models.map(m => m.id)).toEqual(['gpt-6.1-sol[low]', 'gpt-6.1-sol[high]'])
    expect(codex?.name).toBe('Codex')
    expect(presets.find(p => p.preset === 'acp-grok')?.models.map(m => m.id)).toEqual(['grok-4.7'])
    // 未配置清单的 preset（acp-claude 等）给空 models。
    expect(presets.find(p => p.preset === 'acp-claude')?.models).toEqual([])

    // POST 保存子集
    const post = await callJson(handler!, 'POST', { preset: 'acp-codex', ids: ['gpt-6.1-sol[low]'] })
    expect(post['ok']).toBe(true)
    expect(written).toEqual([{ scope: 'acp-codex', ids: ['gpt-6.1-sol[low]'] }])
  })

  it('POST 非本插件 preset → not-ours', async () => {
    const { ctx, routes } = fakeHost()
    registerSelectionRoute(ctx, { configOf: () => ({ presets: {} }) as never })
    const reply = await callJson(routes.get(SELECTION_ROUTE_PATH)!, 'POST', { preset: 'acp-qoder-global' })
    expect(reply['ok']).toBe(false)
    expect(reply['code']).toBe('not-ours')
  })

  it('POST 无 ids → 回到默认（clear）', async () => {
    const { ctx, routes } = fakeHost()
    let cleared = false
    registerSelectionRoute(ctx, {
      configOf: () => ({ presets: { 'acp-grok': { agent: 'grok' } } }) as never,
      persist: { write: async () => {}, clear: async () => { cleared = true } },
    })
    const reply = await callJson(routes.get(SELECTION_ROUTE_PATH)!, 'POST', { preset: 'acp-grok' })
    expect(reply['ok']).toBe(true)
    expect(cleared).toBe(true)
  })

  it('apply 装载入口：挂上路由', () => {
    const { ctx, routes } = fakeHost()
    apply(ctx, { configOf: () => ({ presets: {} }) as never })
    expect(routes.has(SELECTION_ROUTE_PATH)).toBe(true)
  })

  it('notOurs 文案不透内部腔', () => {
    const reply = notOurs('acp-qoder-global')
    expect(reply.error).not.toContain('internal')
  })
})

/** 调一次 handler 并解析它的 JSON 应答。 */
async function callJson(
  handler: (req: { method?: string }, res: { writeHead(s: number, h?: Record<string, string>): void; end(b: string): void }) => void,
  method: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const chunks = body === undefined ? [] : [JSON.stringify(body)]
  const req = { method, [Symbol.asyncIterator](): AsyncIterator<Buffer> {
    let i = 0
    return { next: async () => (i < chunks.length ? { value: Buffer.from(chunks[i++] as string), done: false } : { value: undefined as never, done: true }) }
  } }
  let status = 0
  let payload = ''
  const res = {
    writeHead(s: number) { status = s },
    end(b: string) { payload = b },
  }
  await handler(req as never, res)
  expect(status).toBe(200)
  return JSON.parse(payload) as Record<string, unknown>
}
