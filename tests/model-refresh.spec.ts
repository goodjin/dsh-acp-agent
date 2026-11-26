/**
 * 「刷新模型列表」的宿主侧核心：登记表、zcode 合并规则、grok 探针、按 kind 的分派。
 *
 * 合并规则（任务验收的口径）：上游 id 与声明仅大小写不同 = 同一模型，保留声明的
 * id/名称/窗口；glm-5 族的新模型沿用该族已声明窗口；其余新模型不带窗口并计数说明。
 * 探针走假 transport 喂帧：initialize → session/new → dialect 读清单 → close。
 */

import { describe, expect, it } from 'vitest'
import { AcpClient } from '../src/client.ts'
import type { AcpTransport } from '../src/transport.ts'
import {
  clearModelRefreshers,
  mergeZcodeModels,
  modelRefresherOf,
  probeGrokModels,
  refreshPresetModels,
  registerModelRefresher,
} from '../src/model-refresh.ts'
import type { ReportedModel } from '../src/catalog-registration.ts'
import { grokDialect } from '../src/dialects/grok.ts'

/** 声明清单（cordis.patch.yml acp-zcode 的三条）。 */
const DECLARED: readonly ReportedModel[] = [
  { id: 'GLM-5.3', name: 'GLM 5.3', description: 'GLM Coding Plan', contextWindow: 1000000 },
  { id: 'GLM-5.3-Flash', name: 'GLM 5.3-Flash', description: 'GLM Coding Plan', contextWindow: 1000000 },
  { id: 'GLM-5.2', name: 'GLM 5.2', description: 'GLM Coding Plan', contextWindow: 1000000 },
]

/** 网关真机清单（2026-11-24 实测的 13 条，全小写）。 */
const UPSTREAM = [
  { id: 'glm-4.5', name: 'GLM-4.5' },
  { id: 'glm-4.5-air', name: 'GLM-4.5-Air' },
  { id: 'glm-4.6', name: 'GLM-4.6' },
  { id: 'glm-4.7', name: 'GLM-4.7' },
  { id: 'glm-5', name: 'GLM-5' },
  { id: 'glm-5-turbo', name: 'GLM-5-Turbo' },
  { id: 'glm-5.1', name: 'GLM-5.1' },
  { id: 'glm-5.2', name: 'GLM-5.2' },
  { id: 'glm-5.3', name: 'GLM-5.3' },
  { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash' },
  { id: 'glm-5.3-flashx', name: 'GLM-5.3-FlashX' },
  { id: 'glm-5.3-flashx-legal', name: 'GLM-5.3-FlashX-Legal' },
  { id: 'glm-5.4', name: 'GLM-5.4' },
]

describe('mergeZcodeModels（大小写合并与窗口规则）', () => {
  const merged = mergeZcodeModels(DECLARED, UPSTREAM)

  it('13 条全保，新增 10 条', () => {
    expect(merged.models).toHaveLength(13)
    expect(merged.added).toBe(10)
  })

  it('仅大小写不同的 id 用声明的 id、名称、描述与窗口', () => {
    const byId = new Map(merged.models.map(model => [model.id, model]))
    expect(byId.get('GLM-5.3')).toEqual({
      id: 'GLM-5.3', name: 'GLM 5.3', description: 'GLM Coding Plan', contextWindow: 1000000,
    })
    expect(byId.get('GLM-5.3-Flash')?.id).toBe('GLM-5.3-Flash')
    expect(byId.get('GLM-5.2')?.contextWindow).toBe(1000000)
    // 上游的小写写法不保留
    expect(byId.get('glm-5.3')).toBeUndefined()
  })

  it('glm-5 族新模型沿用族窗口（6 条），并计数', () => {
    const byId = new Map(merged.models.map(model => [model.id, model]))
    for (const id of ['glm-5', 'glm-5-turbo', 'glm-5.1', 'glm-5.4', 'glm-5.3-flashx', 'glm-5.3-flashx-legal']) {
      expect(byId.get(id)?.contextWindow, id).toBe(1000000)
      expect(byId.get(id)?.description, id).toBeUndefined()
    }
    expect(merged.familyWindow).toBe(6)
  })

  it('族外新模型不带窗口（4 条），并计数', () => {
    const byId = new Map(merged.models.map(model => [model.id, model]))
    for (const id of ['glm-4.5', 'glm-4.5-air', 'glm-4.6', 'glm-4.7']) {
      const model = byId.get(id)
      expect(model, id).toBeDefined()
      expect(model?.contextWindow, id).toBeUndefined()
    }
    expect(merged.unverifiedWindow).toBe(4)
  })

  it('声明里没有任何 glm-5 族窗口时，族外规则兜底（不带窗口）', () => {
    const merged = mergeZcodeModels([{ id: 'GLM-4.6', name: 'GLM 4.6' }], [{ id: 'glm-5.9', name: 'GLM-5.9' }])
    expect(merged.models[0]?.contextWindow).toBeUndefined()
    expect(merged.unverifiedWindow).toBe(1)
    expect(merged.familyWindow).toBe(0)
  })

  it('保序（按上游顺序）且大小写无关去重', () => {
    const merged = mergeZcodeModels([], [{ id: 'b', name: 'B' }, { id: 'a', name: 'A' }, { id: 'B', name: 'B2' }])
    expect(merged.models.map(model => model.id)).toEqual(['b', 'a'])
    expect(merged.added).toBe(2)
  })
})

/** 会喂帧的假 transport：记录发出的行，测试手工投递应答。 */
function fakeTransport(): AcpTransport & {
  readonly sent: string[]
  deliver(frame: unknown): void
  die(reason: string): void
  closeCount(): number
} {
  const sent: string[] = []
  let handler: (line: string) => void = () => {}
  let death: (reason: string) => void = () => {}
  let closes = 0
  const transport = {
    sent,
    send: (line: string) => { sent.push(line) },
    onLine: (next: (line: string) => void) => { handler = next },
    onDeath: (next: (reason: string) => void) => { death = next },
    lastFrameAt: () => 0,
    lastDiagnosticAt: () => 0,
    stderrTail: () => [] as readonly string[],
    close: () => { closes += 1 },
    deliver: (frame: unknown) => { handler(JSON.stringify(frame)) },
    die: (reason: string) => { death(reason) },
    closeCount: () => closes,
  }
  return transport as typeof transport & AcpTransport
}

/** grok 真机 session/new 应答的清单形状（dialect.readModels 读的就是它）。 */
function sessionNewReply(models: readonly { modelId: string; name: string; description?: string }[]): unknown {
  return {
    jsonrpc: '2.0',
    id: 2,
    result: {
      sessionId: 'ext-probe-1',
      models: { availableModels: models },
    },
  }
}

describe('probeGrokModels（起进程 → initialize → session/new → 读清单 → 杀进程）', () => {
  it('读到 agent 自报清单，结束后进程被关闭', async () => {
    const transport = fakeTransport()
    const probe = probeGrokModels({
      command: '/usr/local/bin/grok',
      createTransport: async () => transport,
    })
    // initialize（id 1）→ session/new（id 2）：探针按 JSON-RPC 顺序发问。
    await new Promise(resolve => setTimeout(resolve, 0))
    const initialize = transport.sent.find(line => line.includes('"initialize"'))
    expect(initialize, '探针发过 initialize').toBeDefined()
    transport.deliver({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(transport.sent.some(line => line.includes('"session/new"')), '探针发过 session/new').toBe(true)
    transport.deliver(sessionNewReply([
      { modelId: 'grok-4.7', name: 'Grok 4.7' },
      { modelId: 'grok-4.5', name: 'Grok 4.5' },
    ]))
    const models = await probe
    expect(models.map(model => model.id)).toEqual(['grok-4.7', 'grok-4.5'])
    expect(transport.closeCount()).toBeGreaterThan(0)
  })

  it('空清单当失败（「没拿到」不能假装成功）', async () => {
    const transport = fakeTransport()
    const probe = probeGrokModels({ command: 'grok', createTransport: async () => transport })
    await new Promise(resolve => setTimeout(resolve, 0))
    transport.deliver({ jsonrpc: '2.0', id: 1, result: {} })
    await new Promise(resolve => setTimeout(resolve, 0))
    transport.deliver(sessionNewReply([]))
    await expect(probe).rejects.toThrow('reported no models')
    expect(transport.closeCount()).toBeGreaterThan(0)
  })

  it('超时折成明确错误，进程仍被关闭', async () => {
    const transport = fakeTransport()
    await expect(probeGrokModels({
      command: 'grok',
      createTransport: async () => transport,
      timeoutMs: 20,
    })).rejects.toThrow('grok model probe did not answer within 20ms')
    expect(transport.closeCount()).toBeGreaterThan(0)
  })

  it('dialect 面不动：探针读的就是运行时那份 readModels', () => {
    const reply = sessionNewReply([
      { modelId: 'grok-4.6', name: 'Grok 4.6', description: 'flagship' },
    ]) as { result: unknown }
    expect(grokDialect.readModels(reply['result'])).toEqual([{ id: 'grok-4.6', name: 'Grok 4.6', description: 'flagship' }])
  })
})

describe('refreshPresetModels（按 kind 分派）', () => {
  it('grok：探针结果原样入账本，计数说清新增与未验证窗口', async () => {
    const recorded: ReportedModel[][] = []
    const probes: string[] = []
    const outcome = await refreshPresetModels({
      presetId: 'acp-grok',
      agent: 'grok',
      declared: [{ id: 'grok-4.7', name: 'Grok 4.7', contextWindow: 1100000 }],
      previous: undefined,
      record: models => { recorded.push([...models]) },
      command: '/opt/grok',
      deps: {
        probeGrok: async options => {
          probes.push(options.command)
          return [{ id: 'grok-4.7', name: 'Grok 4.7' }, { id: 'grok-9.9', name: 'Grok 9.9' }]
        },
      },
    })
    expect(recorded).toHaveLength(1)
    expect(recorded[0]?.map(model => model.id)).toEqual(['grok-4.7', 'grok-9.9'])
    expect(probes).toEqual(['/opt/grok'])
    expect(outcome).toEqual({
      ok: true, kind: 'upstream', agent: 'grok', total: 2, added: 1, familyWindow: 0, unverifiedWindow: 1,
    })
  })

  it('grok：探针失败向上抛，账本不写', async () => {
    const recorded: ReportedModel[][] = []
    await expect(refreshPresetModels({
      presetId: 'acp-grok',
      agent: 'grok',
      declared: [],
      previous: undefined,
      record: models => { recorded.push([...models]) },
      deps: { probeGrok: async () => { throw new Error('serve refused to start') } },
    })).rejects.toThrow('serve refused to start')
    expect(recorded).toHaveLength(0)
  })

  it('zcode：上游清单按规则合并后入账本，计数齐全', async () => {
    const recorded: ReportedModel[][] = []
    const outcome = await refreshPresetModels({
      presetId: 'acp-zcode',
      agent: 'zcode',
      declared: DECLARED,
      previous: undefined,
      record: models => { recorded.push([...models]) },
      deps: { fetchZcode: async () => UPSTREAM },
    })
    expect(recorded[0]).toHaveLength(13)
    expect(outcome).toEqual({
      ok: true, kind: 'upstream', agent: 'zcode', total: 13, added: 10, familyWindow: 6, unverifiedWindow: 4,
    })
  })

  it('其余 kind：如实回「已重读」，账本不写', async () => {
    const recorded: ReportedModel[][] = []
    for (const agent of ['claude', 'codex', 'cursor', 'qoder', 'minimaxi']) {
      const outcome = await refreshPresetModels({
        presetId: `acp-${agent}`,
        agent,
        declared: [],
        previous: undefined,
        record: models => { recorded.push([...models]) },
      })
      expect(outcome).toEqual({ ok: true, kind: 'reread', agent })
    }
    expect(recorded).toHaveLength(0)
  })
})

describe('refreshPresetModels（ACP 行的通用探针）', () => {
  it('没有本地命令的 ACP 行：如实回「已重读」（没什么可拉起）', async () => {
    const recorded: ReportedModel[][] = []
    const outcome = await refreshPresetModels({
      presetId: 'acp-claude',
      agent: 'claude',
      declared: [],
      previous: undefined,
      record: models => { recorded.push([...models]) },
    })
    expect(outcome).toEqual({ ok: true, kind: 'reread', agent: 'claude' })
    expect(recorded).toHaveLength(0)
  })
})

describe('刷新器登记表', () => {
  it('登记后可查，重复登记覆盖，未登记的查不到', async () => {
    clearModelRefreshers()
    const calls: string[] = []
    registerModelRefresher('acp-grok', async () => { calls.push('one'); return { ok: true, kind: 'reread', agent: 'grok' } })
    expect(modelRefresherOf('acp-grok')).toBeDefined()
    expect(modelRefresherOf('acp-zcode')).toBeUndefined()
    registerModelRefresher('acp-grok', async () => { calls.push('two'); return { ok: true, kind: 'reread', agent: 'grok' } })
    await modelRefresherOf('acp-grok')?.()
    expect(calls).toEqual(['two'])
    clearModelRefreshers()
    expect(modelRefresherOf('acp-grok')).toBeUndefined()
  })
})

describe('探针用 AcpClient 的最小面（不碰权限/终端）', () => {
  it('客户端构造后 permission 默认拒绝：探针绝不被权限卡死', async () => {
    const transport = fakeTransport()
    const client = new AcpClient(transport, grokDialect)
    const decision = await client.onPermissionRequest({ sessionId: 's', options: [], kind: 'permission' } as never)
    expect(decision.outcome).toBe('reject')
  })
})
