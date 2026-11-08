/**
 * 压缩的摘要请求要有一条能服务后台请求的路由。
 *
 * 2026-11-06 现场（两次，11-07 又一次）：会话跑在 grok（外部 agent）上，用户
 * 切到 iquest，宿主压缩在切换那一步要生成摘要——而摘要请求发往会话**当前**的
 * 路由（切换前的 grok）。外部 agent 只回答对话轮次，不接后台请求，于是摘要被
 * 拒（"does not serve background compaction requests"），整个切换以
 * MODEL_SWITCH_COMPACTION_FAILED 失败。
 *
 * 宿主的出口是 compaction-basic 的 summarizationProvider / summarizationModel：
 * 配了它，摘要就走那条路由；不配就继承会话目标（= 撞上外部 agent）。宿主把它
 * 配在 isolate 的 group 里，插件的 patch 按 id 覆盖它——行会被提升到顶层，
 * 配置值落在同一行上（`dsh --dump-config` 可见）。
 *
 * 这条路由必须是**原生**路由（宿主自己的 LLM 服务），不能是 ACP 行：ACP 的
 * 模型行（zcode/minimax）只在 preset 里注册，不在宿主的 llm 注册表里，宿主
 * 按 provider 找不到它们。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PATCH = readFileSync(`${ROOT}/cordis.patch.yml`, 'utf8')

/** patch 里一个顶层行的正文：从它自己的 - id: 行到下一个同级行（或文件尾）。 */
function topLevelBody(id: string): string {
  const starts = [...PATCH.matchAll(/^ {0,2}- id: (\S+)$/gm)]
  const index = starts.findIndex(match => match[1] === id)
  if (index === -1) return ''
  const start = starts[index]?.index ?? 0
  const end = starts[index + 1]?.index ?? PATCH.length
  return PATCH.slice(start, end)
}

describe('压缩的摘要路由', () => {
  it('声明了压缩后端的摘要路由（否则切模型时摘要撞上外部 agent）', () => {
    const body = topLevelBody('compaction-basic')
    expect(body, 'patch 里没有 compaction-basic 的覆盖行').not.toBe('')
    expect(body, '覆盖行没带 summarizationProvider').toContain('summarizationProvider')
    expect(body, '覆盖行没带 summarizationModel').toContain('summarizationModel')
  })

  it('覆盖的是宿主那个压缩后端（行名要对得上，否则宿主跳过它）', () => {
    const body = topLevelBody('compaction-basic')
    expect(body).toContain("name: '@deepseek-ai/dsh-compaction-basic'")
  })

  it('摘要路由不是 ACP 行（宿主按 provider 找不到它们）', () => {
    const body = topLevelBody('compaction-basic')
    const provider = /summarizationProvider:\s*['"]?([^'"\n]+)/.exec(body)?.[1]?.trim() ?? ''
    expect(provider, '没读到 summarizationProvider 的值').not.toBe('')
    expect(provider.startsWith('acp:'), 'ACP 行不在宿主的 llm 注册表里，宿主按它找不到路由').toBe(false)
  })
})
