/**
 * 自报门面：本包的装载行到底挂上没有。
 *
 * 2026-11-03 现场：一句不可擦除的 TS 写法让模块 import 直接失败，Loader 那一行拿不到
 * fiber，宿主半边与浏览器半边一起消失——而日志里一个字都没有。所以这一层只做两件事：
 * 在一行里说清「挂了几行、缺哪几行、为什么缺」，并把同一份账目挂到一条只读路由上，
 * 让运维（和下一次出事的我们）不必再靠猜。
 *
 * 审计只看 Loader 的条目：装配出清单但没挂上的行仍然在树里，只是没有 fiber；模块本身的
 * 原始错误靠重导入一次取回（语法/链接错误重导入会返回同一份错误，不重复干活）。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  apply,
  auditRows,
  EXPECTED_ROWS,
  HEALTH_ROUTE_PATH,
  healthPayload,
  installHealth,
  summarizeAudit,
} from '../src/health.ts'
import type { HealthContext, LoaderEntryLike } from '../src/health.ts'

/** 包根：补丁与期望清单要对得上。 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 一条已挂上的条目：有 fiber，状态 2 = active。 */
function mounted(id: string, name = '@goodjin2/dsh-acp-agent'): LoaderEntryLike {
  return { options: { id, name }, fiber: { state: 2 } }
}

/** 装配进树但模块没载入：没有 fiber，重导入时抛原始错误。 */
function failedImport(id: string, name: string, message: string): LoaderEntryLike {
  return {
    options: { id, name },
    parent: {
      tree: {
        import: async () => {
          throw new Error(message)
        },
      },
    },
  }
}

/** 装配进树、模块载入了，但 apply 抛错：fiber 状态 3 = failed。 */
function failedApply(id: string, name: string, message: string): LoaderEntryLike {
  return {
    options: { id, name },
    fiber: {
      state: 3,
      await: async () => {
        throw new Error(message)
      },
    },
  }
}

/** 装配进树、等依赖服务：fiber 状态 0 = pending。 */
function pendingOn(id: string, name: string, missing: string[]): LoaderEntryLike {
  return {
    options: { id, name },
    fiber: {
      state: 0,
      inject: Object.fromEntries(missing.map(service => [service, true])),
      ctx: { get: () => undefined },
    },
  }
}

/** 全部 13 行都在、都挂上。 */
function allMounted(): LoaderEntryLike[] {
  return EXPECTED_ROWS.map(row => mounted(row.id))
}

/** 按 id 把一条用例里的条目铺齐：没被替换的行都算已挂载。 */
function withRows(overrides: Record<string, LoaderEntryLike>): LoaderEntryLike[] {
  return EXPECTED_ROWS.map(row => overrides[row.id] ?? mounted(row.id))
}

describe('auditRows', () => {
  it('全部挂上时，每一行都是 mounted', async () => {
    const rows = await auditRows(allMounted())
    expect(rows.map(row => row.status)).toEqual(EXPECTED_ROWS.map(() => 'mounted'))
    expect(rows).toHaveLength(EXPECTED_ROWS.length)
  })

  it('模块载入失败的行：failed，并带上重导入取回的原始错误', async () => {
    const rows = await auditRows(withRows({
      'threadharbor-minimaxi-quota': failedImport(
        'threadharbor-minimaxi-quota',
        '@goodjin2/dsh-acp-agent/minimaxi-quota',
        'TypeScript parameter property is not supported in strip-only mode',
      ),
    }))
    const row = rows.find(entry => entry.id === 'threadharbor-minimaxi-quota')
    expect(row?.status).toBe('failed')
    expect(row?.detail).toContain('parameter property')
  })

  it('缺 fiber 且拿不到模块（没有 import 面）时，仍报 failed 而不是沉默', async () => {
    const rows = await auditRows(withRows({
      'acp-agent-client': { options: { id: 'acp-agent-client', name: '@goodjin2/dsh-acp-agent' } },
    }))
    const row = rows.find(entry => entry.id === 'acp-agent-client')
    expect(row?.status).toBe('failed')
    expect(row?.detail).toBeTruthy()
  })

  it('apply 抛错的行：failed，并带上错误原文', async () => {
    const rows = await auditRows(withRows({
      'acp-qoder': failedApply('acp-qoder', '@deepseek-ai/dsh-agent-preset', 'preset schema rejected'),
    }))
    const row = rows.find(entry => entry.id === 'acp-qoder')
    expect(row?.status).toBe('failed')
    expect(row?.detail).toContain('preset schema rejected')
  })

  it('等依赖服务的行：pending，并点名缺哪个服务', async () => {
    const rows = await auditRows(withRows({
      'threadharbor-zcode-quota': pendingOn(
        'threadharbor-zcode-quota',
        '@goodjin2/dsh-acp-agent/zcode-quota',
        ['webServer'],
      ),
    }))
    const row = rows.find(entry => entry.id === 'threadharbor-zcode-quota')
    expect(row?.status).toBe('pending')
    expect(row?.detail).toContain('webServer')
  })

  it('树里根本没有的行：absent（装配的清单与树对不上）', async () => {
    const rows = await auditRows(allMounted().filter(entry => entry.options.id !== 'acp-grok'))
    const row = rows.find(entry => entry.id === 'acp-grok')
    expect(row?.status).toBe('absent')
  })

  it('被 disabled 的行单列，不当作未挂载', async () => {
    const rows = await auditRows(withRows({
      'acp-cursor': { ...mounted('acp-cursor'), disabled: true },
    }))
    const row = rows.find(entry => entry.id === 'acp-cursor')
    expect(row?.status).toBe('disabled')
  })

  it('disabled 表达式求值抛错时：failed 并带上原文，不让审计整条崩掉', async () => {
    const broken: LoaderEntryLike = {
      options: { id: 'acp-cursor', name: '@deepseek-ai/dsh-agent-preset' },
      get disabled(): boolean {
        throw new Error('disabled expression failed')
      },
    }
    const rows = await auditRows(withRows({ 'acp-cursor': broken }))
    const row = rows.find(entry => entry.id === 'acp-cursor')
    expect(row?.status).toBe('failed')
    expect(row?.detail).toContain('disabled expression failed')
  })

  it('只看本包的行：别的插件的条目混在树里也不进账', async () => {
    const rows = await auditRows([...allMounted(), mounted('some-other-row', '@someone/other-plugin')])
    expect(rows).toHaveLength(EXPECTED_ROWS.length)
  })
})

describe('summarizeAudit', () => {
  it('全部挂上时一行说清「几行挂上」', async () => {
    const line = summarizeAudit(await auditRows(allMounted()))
    expect(line).toContain(`${EXPECTED_ROWS.length}/${EXPECTED_ROWS.length}`)
    expect(line).not.toContain('\n')
  })

  it('缺行时一行里点名缺哪几行、为什么缺', async () => {
    const line = summarizeAudit(await auditRows(withRows({
      'threadharbor-minimaxi-quota': failedImport(
        'threadharbor-minimaxi-quota',
        '@goodjin2/dsh-acp-agent/minimaxi-quota',
        'TypeScript parameter property is not supported in strip-only mode',
      ),
      'acp-minimax': { options: { id: 'acp-minimax', name: '@deepseek-ai/dsh-agent-preset' } },
    })))
    expect(line).toContain('threadharbor-minimaxi-quota')
    expect(line).toContain('acp-minimax')
    expect(line).toContain('parameter property')
    expect(line).not.toContain('\n')
  })

  it('被禁用的行在行尾说明，不算未挂载，也不冒充已挂载', async () => {
    const line = summarizeAudit(await auditRows(withRows({
      'acp-cursor': { ...mounted('acp-cursor'), disabled: true },
    })))
    expect(line).toContain('禁用')
    expect(line).toContain('acp-cursor')
    expect(line).toContain(`${EXPECTED_ROWS.length - 1}/${EXPECTED_ROWS.length}`)
    expect(line).not.toContain('未挂载')
  })
})

describe('healthPayload', () => {
  it('全部挂上：ok 为真，账目带上每一行', async () => {
    const payload = healthPayload(await auditRows(allMounted()))
    expect(payload.ok).toBe(true)
    expect(payload.mounted).toBe(EXPECTED_ROWS.length)
    expect(payload.total).toBe(EXPECTED_ROWS.length)
    expect(payload.rows).toHaveLength(EXPECTED_ROWS.length)
  })

  it('有行没挂上：ok 为假，未挂载的数字对得上', async () => {
    const payload = healthPayload(await auditRows(allMounted().filter(entry => entry.options.id !== 'acp-grok')))
    expect(payload.ok).toBe(false)
    expect(payload.mounted).toBe(EXPECTED_ROWS.length - 1)
  })
})

describe('期望清单与补丁一一对应', () => {
  /** 补丁里 insert 段顶层的行 id（本包的装载行都在这里；健康行自己不算期望）。 */
  function topLevelRowIds(): string[] {
    const text = readFileSync(resolve(ROOT, 'cordis.patch.yml'), 'utf8')
    return [...text.matchAll(/^ {4}- id: (\S+)$/gm)].map(match => match[1] ?? '').filter(id => id !== '')
  }

  it('期望清单里的每一行，补丁里真有', () => {
    const ids = topLevelRowIds()
    for (const row of EXPECTED_ROWS) expect(ids, `补丁里没有 ${row.id}`).toContain(row.id)
  })

  it('补丁里的每一行（除自报门面自己），期望清单里也真有', () => {
    const expected = EXPECTED_ROWS.map(row => row.id)
    for (const id of topLevelRowIds()) {
      if (id === 'threadharbor-health') continue
      expect(expected, `期望清单里没有 ${id}`).toContain(id)
    }
  })
})

/** 捕获出来的 stderr 行，用来断言「确实说了一声」。 */
function rig(options: { withLoader?: boolean; withWebServer?: boolean } = {}) {
  const warnings: string[] = []
  const routes: { kind: string; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }[] = []
  const disposers: (() => void)[] = []
  const entries = allMounted()
  const child = {
    webServer: {
      register(route: { kind: string; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }) {
        routes.push(route)
        return () => {}
      },
    },
    connection: { admit: () => ({ peer: { role: 'operator' } }) },
  }
  const ctx = {
    logger: { warn: (message: string) => void warnings.push(message) },
    loader: options.withLoader === false ? undefined : { entries: () => entries, await: async () => {} },
    get: (name: string) => (name === 'loader' && options.withLoader !== false ? { entries: () => entries, await: async () => {} } : undefined),
    inject(deps: string[], body: (child: unknown) => void) {
      if (options.withWebServer === false) return
      body(child)
    },
    effect(factory: () => unknown) {
      const dispose = factory()
      if (typeof dispose === 'function') disposers.push(dispose as () => void)
      return dispose
    },
  } as unknown as HealthContext
  return { ctx, warnings, routes, disposers }
}

/** 让排到定时器里的审计跑完（schedule 立即执行，等一串微任务）。 */
async function flush(): Promise<void> {
  await new Promise<void>(resolve => { setTimeout(resolve, 0) })
}

describe('installHealth / apply', () => {
  it('boot 后只打一行，并且同时走 logger 与 stderr', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const { ctx, warnings } = rig()
      installHealth(ctx, { schedule: run => run() })
      await flush()
      const health = warnings.filter(line => line.includes('acp-agent'))
      expect(health).toHaveLength(1)
      expect(health[0]).toContain(`${EXPECTED_ROWS.length}/${EXPECTED_ROWS.length}`)
      const written = stderr.mock.calls.map(call => String(call[0])).filter(line => line.includes('acp-agent'))
      expect(written).toHaveLength(1)
    } finally {
      stderr.mockRestore()
    }
  })

  it('缺行时那一行会点名缺哪一行——这正是「没生效但没日志」的反面', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const { ctx, warnings } = rig()
      const entries = [
        ...allMounted().filter(entry => entry.options.id !== 'threadharbor-minimaxi-quota'),
        failedImport(
          'threadharbor-minimaxi-quota',
          '@goodjin2/dsh-acp-agent/minimaxi-quota',
          'TypeScript parameter property is not supported in strip-only mode',
        ),
      ]
      ;(ctx as unknown as { loader: { entries: () => LoaderEntryLike[] } }).loader = { entries: () => entries }
      installHealth(ctx, { schedule: run => run() })
      await flush()
      expect(warnings.join('\n')).toContain('threadharbor-minimaxi-quota')
      expect(warnings.join('\n')).toContain('parameter property')
    } finally {
      stderr.mockRestore()
    }
  })

  it('拿不到 loader 服务时明确说一声，而不是静默', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const { ctx, warnings } = rig({ withLoader: false })
      installHealth(ctx, { schedule: run => run() })
      await flush()
      expect(warnings.join('\n')).toContain('loader')
    } finally {
      stderr.mockRestore()
    }
  })

  it('注册一条只读路由在固定路径，返回账目 JSON', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const { ctx, routes } = rig()
      installHealth(ctx, { schedule: run => run() })
      await flush()
      expect(routes).toHaveLength(1)
      const route = routes[0]
      if (route === undefined) throw new Error('路由没有注册')
      expect(route).toMatchObject({ kind: 'exact', path: HEALTH_ROUTE_PATH })
      const chunks: string[] = []
      const res = {
        writeHead() {},
        end(body?: unknown) { chunks.push(String(body ?? '')) },
      } as unknown as ServerResponse
      await route.handler({ method: 'GET', headers: {} } as IncomingMessage, res)
      const payload = JSON.parse(chunks.join('')) as { ok: boolean; total: number }
      expect(payload.ok).toBe(true)
      expect(payload.total).toBe(EXPECTED_ROWS.length)
    } finally {
      stderr.mockRestore()
    }
  })

  it('没人注入 webServer 时照样打日志，只是没有路由', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const { ctx, warnings, routes } = rig({ withWebServer: false })
      installHealth(ctx, { schedule: run => run() })
      await flush()
      expect(routes).toHaveLength(0)
      expect(warnings.join('\n')).toContain('acp-agent')
    } finally {
      stderr.mockRestore()
    }
  })

  it('apply 把 config 之后的宿主面接到同一个实现上', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const { ctx, warnings } = rig()
      apply(ctx)
      await flush()
      expect(warnings.join('\n')).toContain('acp-agent')
    } finally {
      stderr.mockRestore()
    }
  })
})

describe('那一行落到看得见的地方', () => {
  it('同时写进日志文件：桌面版从 Finder 起、stderr 没人接，也能事后看', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const written: { path: string; text: string }[] = []
      const { ctx } = rig()
      installHealth(ctx, {
        schedule: run => run(),
        logPath: '/tmp/whatever/logs/acp-agent-health.log',
        writeLog: (path, text) => void written.push({ path, text }),
      })
      await flush()
      expect(written).toHaveLength(1)
      expect(written[0]?.path).toContain('acp-agent-health.log')
      expect(written[0]?.text).toContain(`${EXPECTED_ROWS.length}/${EXPECTED_ROWS.length}`)
      // 一行一次开机：带时间戳、单行、以换行收尾。
      expect(written[0]?.text).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
      expect(written[0]?.text.trimEnd().split('\n')).toHaveLength(1)
      expect(written[0]?.text.endsWith('\n')).toBe(true)
    } finally {
      stderr.mockRestore()
    }
  })

  it('默认落在 $DSH_HOME/logs 下，目录不存在会先建出来', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-health-'))
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const { ctx } = rig()
      installHealth(ctx, { schedule: run => run() })
      await flush()
      const file = join(home, 'logs', 'acp-agent-health.log')
      expect(existsSync(file)).toBe(true)
      expect(readFileSync(file, 'utf8')).toContain('acp-agent health')
    } finally {
      stderr.mockRestore()
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('写盘失败不带走那一次自报：stderr 上仍然有那一行', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const { ctx, warnings } = rig()
      installHealth(ctx, {
        schedule: run => run(),
        writeLog: () => {
          throw new Error('EACCES: permission denied')
        },
      })
      await flush()
      expect(warnings.join('\n')).toContain('acp-agent health')
    } finally {
      stderr.mockRestore()
    }
  })
})
