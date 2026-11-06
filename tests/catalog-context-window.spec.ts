/**
 * 适配器交给宿主的模型元数据必须带上上下文窗口。
 *
 * 宿主的上下文压缩（dsh-compaction-basic）在压缩前通过 resolveModel 要
 * `context.contextWindow`；适配器不带这个字段，压缩就以
 * "no context capacity … configure contextWindow on that adapter model" 失败，
 * 模型切换在压缩这一步死掉（2026-11-07 现场，MiniMax-M3.1-Flash）。
 * 声明清单里的 contextWindow 是唯一事实来源，resolveModel 要把它原样交出去。
 */

import { describe, expect, it } from 'vitest'
import { catalogAdapter, providerRoute } from '../src/catalog.ts'
import { grokDialect } from '../src/index.ts'
import type { PresetConfig } from '../src/registry.ts'

const CONFIG: PresetConfig = {
  presets: {
    'acp-minimax': {
      agent: 'minimaxi',
      models: [
        { id: 'MiniMax-M3.1-Flash', name: 'M3.1 Flash', description: 'MiniMax Code 登录', contextWindow: 512_000 },
        { id: 'MiniMax-M3', name: 'MiniMax M3', description: 'MiniMax Code 登录', contextWindow: 512_000 },
      ],
    },
  },
}

const adapter = catalogAdapter(CONFIG, {
  modelsOf: presetId => CONFIG.presets[presetId]?.models ?? [],
  dialectOf: () => grokDialect,
})

describe('适配器模型元数据带上下文窗口', () => {
  it('resolveModel 把声明清单里的 contextWindow 交出去', async () => {
    const resolved = await adapter.resolveModel(providerRoute('acp-minimax'), 'MiniMax-M3.1-Flash')
    expect(resolved.context).toEqual({ contextWindow: 512_000 })
  })

  it('没声明窗口的模型不带 context 字段（宿主按未声明处理）', async () => {
    const bare = catalogAdapter({
      presets: { 'acp-minimax': { agent: 'minimaxi', models: [{ id: 'MiniMax-M3.1-Flash', name: 'M3.1 Flash' }] } },
    }, { modelsOf: () => [], dialectOf: () => grokDialect })
    const resolved = await bare.resolveModel(providerRoute('acp-minimax'), 'MiniMax-M3.1-Flash')
    expect(resolved.context).toBeUndefined()
  })
})
