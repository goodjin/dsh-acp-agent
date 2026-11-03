/**
 * 入口可载入闸门：按宿主的方式把本包每个入口真载入一遍。
 *
 * 2026-11-03 现场：一句参数属性让 `src/minimaxi/credential.ts` 在 strip-only 载入时
 * 直接失败，而它被主入口与 MiniMax 配额入口引用——那一行拿不到 fiber，宿主与浏览器
 * 半边一起消失，界面上什么都不剩、日志里一个字都没有。语法扫描（strip-only-syntax）
 * 能挡住那一句写法，但挡不住这里所有别的死法：导出路径写错、相对路径少一层、
 * 顶层代码抛错、依赖没装。
 *
 * 所以这里不用 vitest 的转换器（它会转译 TS，正好绕过宿主真实的那条路），而是起一个
 * 真 node 子进程，用 `import()` 载入 package.json 里声明的每个宿主入口。载不进来就是红的。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

interface ManifestShape {
  exports?: Record<string, { default?: string } | string>
}

/** 读 package.json 的 exports：子路径 → 默认目标文件。 */
function exportTargets(): { subpath: string; target: string }[] {
  const manifest = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as ManifestShape
  const targets: { subpath: string; target: string }[] = []
  for (const [subpath, value] of Object.entries(manifest.exports ?? {})) {
    const target = typeof value === 'string' ? value : value.default
    if (typeof target === 'string') targets.push({ subpath, target })
  }
  return targets
}

/** 宿主侧的入口：`.ts` 源码（浏览器那半边是构建产物，不在这条路的覆盖里）。 */
const HOST_ENTRIES = exportTargets().filter(({ target }) => target.endsWith('.ts'))

/** 用真 node、按宿主的 strip-only 方式载入一个模块，返回它的报错（成功则 null）。 */
function loadFailure(absolutePath: string): string | null {
  const url = pathToFileURL(absolutePath).href
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(url)})`], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
  })
  if (run.error !== undefined) return String(run.error)
  if (run.status === 0) return null
  return `${run.status === null ? 'killed' : `exit ${String(run.status)}`}: ${(run.stderr || run.stdout).trim()}`
}

describe('入口可载入（真 node，strip-only）', () => {
  it('先确认真的覆盖到宿主入口，而不是一个都挑不出来', () => {
    expect(HOST_ENTRIES.length).toBeGreaterThanOrEqual(9)
    const subpaths = HOST_ENTRIES.map(entry => entry.subpath)
    for (const required of ['.', './index', './roster-filter', './zcode-quota', './minimaxi-quota', './codex-quota', './claude-quota', './health']) {
      expect(subpaths).toContain(required)
    }
  })

  it.each(HOST_ENTRIES.map(({ subpath, target }) => [subpath, target] as const))(
    '子路径 %s 指向的文件存在，且能被载入',
    (subpath, target) => {
      const absolute = resolve(ROOT, target)
      expect(existsSync(absolute), `${subpath} → ${target} 不存在`).toBe(true)
      const failure = loadFailure(absolute)
      expect(failure, `${subpath} → ${target} 载入失败：${failure ?? ''}`).toBeNull()
    },
  )
})
