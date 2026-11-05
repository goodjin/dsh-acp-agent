/**
 * Qoder 国际版这一行在宿主里挂得对不对。
 *
 * 逐模块的行为在各自的文件里（端点、登录、凭据、清单、请求、模型行、路由）。
 * 这一份只钉**接线**：预置行、登录路由行、自报健康行、包的导出——它们错了的话，
 * 功能会整块不见，而且没有报错。
 */

import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { EXPECTED_ROWS } from '../src/health.ts'

const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

describe('Qoder 国际版的接线', () => {
  it('预置行在，agent 是 qoder-global', () => {
    expect(patch).toContain('id: acp-qoder-global')
    expect(patch).toContain('agent: qoder-global')
  })

  it('登录路由行在，挂的是这个包', () => {
    expect(patch).toContain('id: acp-agent-qoder-login')
    expect(patch).toContain('@goodjin2/dsh-acp-agent/qoder-login')
  })

  it('这一行把静默看门狗放宽到 5 分钟', () => {
    // 模型请求在长时间思考时可能几十秒不出帧；默认的 120 秒会把这一轮杀掉。
    const row = patch.slice(patch.indexOf('id: acp-qoder-global'), patch.indexOf('id: acp-qoder-global') + 1500)
    expect(row).toContain('stallMs: 300000')
  })

  it('两行都在自报健康的期望清单里', () => {
    const ids = EXPECTED_ROWS.map(row => row.id)
    expect(ids).toContain('acp-qoder-global')
    expect(ids).toContain('acp-agent-qoder-login')
  })

  it('包名与导出对得上', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      exports?: Record<string, unknown>
    }
    expect(manifest.exports?.['./qoder-login']).toBeDefined()
  })
})
