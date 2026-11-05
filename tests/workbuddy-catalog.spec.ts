/**
 * 模型清单从哪来。
 *
 * 同一个账号有两份清单：
 * - 我们自己去问站点要的那份：**39 个模型、没有倍率**（个人作用域的令牌拿到的是
 *   缩水版）；
 * - 桌面版自己那份缓存：**61 个模型、39 个带官方倍率**（套餐档位与各家模型的
 *   积分倍率都在里面）。
 *
 * 实测过：桌面版清单里的模型（hy4-preview、fast-model 这些）用我们的令牌照样
 * 跑得通——差的只是清单口径，不是能力。所以清单优先用桌面版那份，借不到就用我们
 * 自己那份，两样都没有才退回静态兜底。
 *
 * 这里钉住：两份清单的取舍、桌面版缓存的挑法（取最新那份带模型的）、以及我们
 * 自己那份请求必须带 UA（不带就是 400）。
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadCatalog, parseModels, readDesktopCatalog } from '../src/workbuddy/models.ts'
import { WORKBUDDY_UA } from '../src/workbuddy/endpoints.ts'

let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wb-catalog-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** 桌面版缓存里的一条（形状照真机那份）。 */
function desktopEntry(models: readonly unknown[], endpoint = 'https://copilot.tencent.com'): unknown {
  return [{ userId: 'uid-1', data: { endpoint, models } }]
}

/** 站点下发的配置（形状照真机那份）。 */
function cloudPayload(models: readonly unknown[], endpoint = 'https://copilot.tencent.com'): unknown {
  return { code: 0, data: { endpoint, models } }
}

const ONE_MODEL = [{ id: 'auto', name: 'Auto', credits: 'x0.15' }]

describe('解析清单', () => {
  it('两种外壳都认：站点的 data.models 与桌面版缓存里的同形', () => {
    expect(parseModels(cloudPayload(ONE_MODEL))).toHaveLength(1)
    expect(parseModels(desktopEntry(ONE_MODEL))).toHaveLength(1)
    expect(parseModels({ models: ONE_MODEL })).toHaveLength(1)
  })
})

describe('桌面版缓存', () => {
  it('取最新那份带模型的，并认出端点', async () => {
    await writeFile(join(dir, 'old.info'), JSON.stringify(desktopEntry([{ id: 'old', name: '旧' }])), 'utf8')
    await writeFile(join(dir, 'new.info'), JSON.stringify(desktopEntry(ONE_MODEL)), 'utf8')
    // 让 new 更新
    const { utimes } = await import('node:fs/promises')
    const now = new Date()
    await utimes(join(dir, 'old.info'), now, new Date(now.getTime() - 60_000))
    await utimes(join(dir, 'new.info'), now, now)

    const catalog = await readDesktopCatalog({ dir })
    expect(catalog?.models.map(model => model.id)).toEqual(['auto'])
    expect(catalog?.endpoint).toBe('https://copilot.tencent.com')
  })

  it('没有缓存目录或没有模型时是空，不是报错', async () => {
    expect(await readDesktopCatalog({ dir: join(dir, 'nope') })).toBeUndefined()
    await writeFile(join(dir, 'x.info'), JSON.stringify({ hello: 'world' }), 'utf8')
    expect(await readDesktopCatalog({ dir })).toBeUndefined()
  })
})

describe('取清单', () => {
  it('有桌面版缓存就用它，不再问站点', async () => {
    await writeFile(join(dir, 'new.info'), JSON.stringify(desktopEntry([{ id: 'hy4-preview', name: 'Hy4', credits: 'x0.29' }])), 'utf8')
    let asked = 0
    const catalog = await loadCatalog({
      credential: { accessToken: 'ACCESS' },
      desktopDir: dir,
      fetchImpl: (async () => { asked += 1; return new Response('{}', { status: 200 }) }) as unknown as typeof fetch,
    })
    expect(catalog.source).toBe('desktop')
    expect(catalog.models.map(model => model.id)).toEqual(['hy4-preview'])
    expect(asked).toBe(0)
  })

  it('借不到桌面版就用我们自己那份，请求带 UA', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = []
    const catalog = await loadCatalog({
      credential: { accessToken: 'ACCESS' },
      desktopDir: join(dir, 'none'),
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> })
        return new Response(JSON.stringify(cloudPayload([{ id: 'hy3', name: 'Hy3' }])), { status: 200 })
      }) as unknown as typeof fetch,
    })
    expect(catalog.source).toBe('cloud')
    expect(catalog.models.map(model => model.id)).toEqual(['hy3'])
    expect(calls[0]?.headers['user-agent']).toBe(WORKBUDDY_UA)
  })

  it('两边都没有时是空清单，不抛', async () => {
    const catalog = await loadCatalog({
      credential: { accessToken: 'ACCESS' },
      desktopDir: join(dir, 'none'),
      fetchImpl: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
    })
    expect(catalog.models).toEqual([])
    expect(catalog.source).toBe('none')
  })
})
