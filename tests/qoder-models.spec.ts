import { describe, expect, it, vi } from 'vitest'
import { fetchModels, parseModels } from '../src/qoder/models.ts'

describe('Qoder 国际版的模型清单', () => {
  it('清单按场景分组，取 assistant 那一组', () => {
    const models = parseModels({
      assistant: [
        {
          key: 'qwen3.8-max',
          display_name: 'Qwen 3.8 Max',
          is_reasoning: true,
          max_input_tokens: 1000000,
          is_vl: true,
          efforts: ['low', 'high'],
        },
        { key: 'fast', display_name: 'Fast' },
      ],
      other: [{ key: 'nope', display_name: 'Nope' }],
    })
    expect(models.map(model => model.id)).toEqual(['qwen3.8-max', 'fast'])
    expect(models[0]).toMatchObject({
      name: 'Qwen 3.8 Max',
      contextWindow: 1000000,
      supportsImages: true,
    })
    expect(models[0]?.efforts).toEqual(['low', 'high'])
  })

  it('条目上的最大 token 字段名要认下来', () => {
    const models = parseModels({ assistant: [
      { key: 'qwen3.8-max', display_name: 'Qwen 3.8 Max', maxTokensField: 'max_completion_tokens' },
      { key: 'plain', display_name: 'Plain' },
    ] })
    expect(models[0]?.maxTokensField).toBe('max_completion_tokens')
    expect(models[1]?.maxTokensField).toBe('max_tokens')
  })

  it('模型 id 就是条目的 key，没有 key 的条目跳过', () => {
    expect(parseModels({ assistant: [{ display_name: '无名' }, { key: '', display_name: '空' }] })).toEqual([])
  })

  it('形状不认识时给空清单，不抛错', () => {
    expect(parseModels({})).toEqual([])
    expect(parseModels({ assistant: 'x' })).toEqual([])
    expect(parseModels(null)).toEqual([])
  })

  it('清单走 SDK：拿不到时是空清单，不把令牌反射出去', async () => {
    // 站点那份清单要 Qoder 自己的原生模块算签名，JS 复刻不了——所以借 SDK
    // （协议本身见 tests/workbuddy-qoder-catalog.spec.ts）。
    const models = await fetchModels({
      credential: { accessToken: 'tok', machineId: 'mid' },
      sdkPath: '/nowhere/qoder-sdk.mjs',
      spawnSdk: () => undefined,
    })
    expect(models).toEqual([])
  })
})
