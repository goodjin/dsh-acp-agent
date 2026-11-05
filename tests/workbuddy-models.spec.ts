/**
 * WorkBuddy 的模型清单。
 *
 * 清单来自站点下发的产品配置（`/v3/config`），要登录才有——没登录时那份配置里
 * `models` 是空的。所以这一层要能认得出「空」与「坏」，并把空与坏都变成空清单，
 * 让选择器退回兜底清单，而不是整个分组消失。
 *
 * 钉住：字段怎么读（描述取中文、上下文长度、推理档位、支不支持工具与图片）、
 * 积分倍率要进描述（用户选模型前要知道这个模型花多少）、以及取数时的两个头。
 */

import { describe, expect, it } from 'vitest'
import { fetchModels, parseModels } from '../src/workbuddy/models.ts'

/** 一份站点配置的样子（字段按真机那份裁剪）。 */
function config(models: readonly unknown[] | null): unknown {
  return { code: 0, msg: 'OK', data: { models } }
}

describe('解析清单', () => {
  it('读出每个模型的字段', () => {
    const models = parseModels(config([
      {
        id: 'auto',
        name: 'Auto',
        descriptionZh: '自动选模',
        descriptionEn: 'picks a model',
        maxInputTokens: 256000,
        maxOutputTokens: 32000,
        reasoning: { defaultEffort: 'high', supportedEfforts: ['low', 'medium', 'high'] },
        supportsToolCall: true,
        supportsImages: true,
        credits: 'x0.15',
      },
    ]))
    expect(models).toHaveLength(1)
    expect(models[0]?.id).toBe('auto')
    // 倍率进名字：选择器里显示的就是名字，倍率塞在描述里看不见。
    expect(models[0]?.name).toBe('Auto（x0.15）')
    expect(models[0]?.description).toContain('自动选模')
    expect(models[0]?.contextWindow).toBe(256000)
    expect(models[0]?.efforts).toEqual(['low', 'medium', 'high'])
    expect(models[0]?.supportsToolCall).toBe(true)
    expect(models[0]?.supportsImages).toBe(true)
    // 积分倍率要看得见：用户选模型前要知道这个模型花多少。
    // 倍率在名字上，描述里不再重复一遍。
    expect(models[0]?.description).not.toContain('x0.15')
    expect(models[0]?.credits).toBe('x0.15')
  })

  it('没有中文描述就用英文的', () => {
    const models = parseModels(config([{ id: 'hy3', name: 'Hy3', descriptionEn: 'hunyuan' }]))
    expect(models[0]?.description).toContain('hunyuan')
  })

  it('只有默认档时，档位就是那一档', () => {
    const models = parseModels(config([{ id: 'hy3', name: 'Hy3', reasoning: { defaultEffort: 'high' } }]))
    expect(models[0]?.efforts).toEqual(['high'])
  })

  it('没有推理配置的模型就没有档位轴', () => {
    const models = parseModels(config([{ id: 'plain', name: 'Plain' }]))
    expect(models[0]?.efforts).toBeUndefined()
  })

  it('清单是空或形状不认识时返回空清单，不抛', () => {
    expect(parseModels(config(null))).toEqual([])
    expect(parseModels(config([]))).toEqual([])
    expect(parseModels({ code: 0 })).toEqual([])
    expect(parseModels(undefined)).toEqual([])
  })
})

describe('取清单', () => {
  it('打产品配置地址，带「要完整配置」的头与访问令牌', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const fetchImpl: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} })
      return new Response(JSON.stringify(config([{ id: 'auto', name: 'Auto' }])), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const models = await fetchModels({ credential: { accessToken: 'ACCESS' }, fetchImpl })

    expect(models.map(model => model.id)).toEqual(['auto'])
    expect(calls[0]?.url).toBe('https://www.workbuddy.cn/v3/config')
    const headers = calls[0]?.init.headers as Record<string, string>
    expect(headers['__codebuddyProductConfigurationRequest']).toBe('true')
    expect(headers['authorization']).toBe('Bearer ACCESS')
  })

  it('没登录时报错，消息里没有令牌', async () => {
    const fetchImpl: typeof fetch = async () => new Response('unauthorized', { status: 401 })
    let message = ''
    try {
      await fetchModels({ credential: { accessToken: 'SECRET-TOKEN' }, fetchImpl })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).not.toContain('SECRET-TOKEN')
    expect(message).toContain('401')
  })
})
