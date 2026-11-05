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

  it('模型 id 就是条目的 key，没有 key 的条目跳过', () => {
    expect(parseModels({ assistant: [{ display_name: '无名' }, { key: '', display_name: '空' }] })).toEqual([])
  })

  it('形状不认识时给空清单，不抛错', () => {
    expect(parseModels({})).toEqual([])
    expect(parseModels({ assistant: 'x' })).toEqual([])
    expect(parseModels(null)).toEqual([])
  })

  it('拉清单带上 Bearer 与身份头', async () => {
    const mock = vi.fn().mockResolvedValue(Response.json({ assistant: [{ key: 'm', display_name: 'M' }] }))
    const models = await fetchModels({
      credential: { accessToken: 'tok', machineId: 'mid' },
      fetchImpl: mock,
    })
    expect(mock.mock.calls[0]?.[0]).toBe('https://api3.qoder.sh/api/v2/model/list?Encode=1')
    const headers = mock.mock.calls[0]?.[1]?.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer tok')
    expect(headers['Cosy-ClientType']).toBe('5')
    expect(models.map(model => model.id)).toEqual(['m'])
  })

  it('拉不到时只报状态码，不把令牌反射出去', async () => {
    const mock = vi.fn().mockResolvedValue(new Response('tok', { status: 401 }))
    await expect(fetchModels({
      credential: { accessToken: 'tok', machineId: 'mid' },
      fetchImpl: mock,
    })).rejects.toThrow(/HTTP 401/)
    await expect(fetchModels({
      credential: { accessToken: 'tok', machineId: 'mid' },
      fetchImpl: mock,
    })).rejects.not.toThrow(/tok/)
  })
})
