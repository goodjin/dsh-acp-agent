/**
 * 目录的清单韧性：报错之后选择器不得丢当前模型。
 *
 * 背景（2026-11-17 现场）：宿主按 Host 代际缓存目录快照，某次加载时某行交不出
 * 模型会被「粘住」，选择器一直显示「请选择模型」。与 qoder 行同款的硬保证：
 * 账本空覆盖不抹旧值；listModels 任何异常降级用声明清单回答。
 *
 * 范围边界：present-and-empty（运行时自报空清单）的「agent 什么都不服务」语义
 * 只对**外部 agent 行**有意义（claude/codex 等真的可能不服务任何模型）；对
 * 模型行（zcode/minimaxi，DSH 自己应答的那两行）空清单只能是异常状态，必须
 * 回退声明清单。
 */

import { describe, expect, it } from 'vitest'
import { catalogAdapter, providerRoute } from '../src/catalog.ts'
import { runtimeModels } from '../src/catalog-registration.ts'
import type { PresetConfig } from '../src/registry.ts'

describe('运行时账本：空清单不抹掉非空旧值', () => {
  it('非空 → 空：保留旧值', () => {
    const ledger = runtimeModels()
    ledger.record('p', [{ id: 'glm-5.3', name: 'GLM 5.3' }])
    ledger.record('p', [])
    expect(ledger.modelsOf('p')?.map(m => m.id)).toEqual(['glm-5.3'])
  })

  it('非空 → 只含无效条目（id 非字符串）：同样不抹旧值', () => {
    const ledger = runtimeModels()
    ledger.record('p', [{ id: 'glm-5.3', name: 'GLM 5.3' }])
    ledger.record('p', [{ id: 42, name: 'bad' } as never])
    expect(ledger.modelsOf('p')?.map(m => m.id)).toEqual(['glm-5.3'])
  })

  it('非空 → 非空：正常替换', () => {
    const ledger = runtimeModels()
    ledger.record('p', [{ id: 'glm-5.3', name: 'GLM 5.3' }])
    ledger.record('p', [{ id: 'glm-5.5', name: 'GLM 5.5' }])
    expect(ledger.modelsOf('p')?.map(m => m.id)).toEqual(['glm-5.5'])
  })

  it('空 → 空：保持空（没有旧值可保）', () => {
    const ledger = runtimeModels()
    ledger.record('p', [])
    expect(ledger.modelsOf('p')).toEqual([])
  })
})

const ZCODE_CONFIG: PresetConfig = {
  presets: {
    'acp-zcode': { agent: 'zcode', models: [{ id: 'glm-5.3', name: 'GLM 5.3' }] },
    'acp-claude': { agent: 'claude', command: 'claude-agent-acp', models: [{ id: 'claude-opus-4', name: 'Claude Opus 4' }] },
  },
}

function zcodeAdapterWith(runtimeModelsOf: unknown, ensureModels?: () => Promise<void>) {
  return catalogAdapter(ZCODE_CONFIG, {
    modelsOf: (presetId: string) => ZCODE_CONFIG.presets[presetId]?.models ?? [],
    ...(runtimeModelsOf === undefined ? {} : { runtimeModelsOf: runtimeModelsOf as (presetId: string) => readonly { id: string; name: string }[] | undefined }),
    dialectOf: () => undefined,
    ...(ensureModels === undefined ? {} : { ensureModels }),
  })
}

describe('目录适配器：模型行的空与异常都回退声明清单', () => {
  it('zcode present-and-empty → listModels 回退声明清单', async () => {
    const adapter = zcodeAdapterWith(() => [])
    const models = await adapter.listModels(providerRoute('acp-zcode'))
    expect(models.map(m => m.id)).toEqual(['glm-5.3'])
  })

  it('外部 agent present-and-empty → 保持空（那是 agent 说自己不服务）', async () => {
    const adapter = zcodeAdapterWith((presetId: string) => presetId === 'acp-claude' ? [] : undefined)
    const models = await adapter.listModels(providerRoute('acp-claude'))
    expect(models).toEqual([])
  })

  it('ensureModels 抛错 → listModels 仍按声明清单回答', async () => {
    const adapter = zcodeAdapterWith(undefined, async () => { throw new Error('upstream refused') })
    const models = await adapter.listModels(providerRoute('acp-zcode'))
    expect(models.map(m => m.id)).toEqual(['glm-5.3'])
  })

  it('runtimeModelsOf 抛错 → listModels 仍按声明清单回答', async () => {
    const adapter = zcodeAdapterWith(() => { throw new Error('ledger blew up') })
    const models = await adapter.listModels(providerRoute('acp-zcode'))
    expect(models.map(m => m.id)).toEqual(['glm-5.3'])
  })

  it('非空运行时清单照旧权威（回退只兜异常与模型行的空）', async () => {
    const adapter = zcodeAdapterWith((presetId: string) => presetId === 'acp-zcode' ? [{ id: 'rt-model', name: 'Runtime Only' }] : undefined)
    const models = await adapter.listModels(providerRoute('acp-zcode'))
    expect(models.map(m => m.id)).toEqual(['rt-model'])
  })

  it('resolveModel 对模型行的 present-and-empty 也按声明清单解析', async () => {
    const adapter = zcodeAdapterWith(() => [])
    const resolved = await adapter.resolveModel(providerRoute('acp-zcode'), 'glm-5.3')
    expect(resolved).toMatchObject({ id: 'glm-5.3', name: 'GLM 5.3' })
  })
})
