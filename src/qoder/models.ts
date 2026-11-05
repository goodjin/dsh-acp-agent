/**
 * Qoder 国际版的模型清单。
 *
 * 核对时间：2026-11-05。清单来自 `{catalogBase}/api/v2/model/list?Encode=1`，
 * 要登录才有（带 Bearer）。
 *
 * **应答是按场景分组的对象**，不是数组：`{"assistant": [ … ], "其他场景": [ … ] }`。
 * 取 `assistant` 那一组——CLI 侧用的场景名就是 `assistant`。
 *
 * 每条模型的 `key` 就是请求体里要发的模型 id；`display_name` 是给人看的名字。
 */

import { qoderIdentityHeaders, resolveEndpoints } from './endpoints.ts'
import type { QoderEndpoints } from './endpoints.ts'
import type { QoderCredential } from './auth.ts'

/** 一条模型。 */
export type QoderModel = {
  /** 模型 id：请求体里就发它。 */
  readonly id: string
  /** 给人看的名字。 */
  readonly name: string
  /** 描述。 */
  readonly description?: string | undefined
  /** 输入长度上限。 */
  readonly contextWindow?: number | undefined
  /** 这个模型提供的推理档位。 */
  readonly efforts?: readonly string[] | undefined
  /** 支不支持图片。 */
  readonly supportsImages?: boolean | undefined
  /**
   * 请求体里「最大 token」用哪个字段名。
   *
   * Qoder 自己的模型用 `max_completion_tokens`，别的走 OpenAI 那一套
   * `max_tokens`——发错字段名，服务端要么忽略要么拒。
   */
  readonly maxTokensField?: 'max_tokens' | 'max_completion_tokens' | undefined
}

/** 清单按场景分组，CLI 用的那一组叫 `assistant`。 */
const SCENE = 'assistant'

/**
 * worker 内置的模型（国际版）。
 *
 * 清单要登录才有；清单没到手时，这些是 worker 自己会用的模型。它们声明的最大
 * token 字段名是 `max_completion_tokens`——发成 `max_tokens` 服务端不认。
 */
export const BUILTIN_MODELS: Readonly<Record<string, {
  readonly displayName: string
  readonly maxTokensField: 'max_tokens' | 'max_completion_tokens'
}>> = {
  'qwen3.8-max': { displayName: 'Qwen 3.8 Max', maxTokensField: 'max_completion_tokens' },
}

/**
 * 从应答里取模型清单。
 * @param payload - `/api/v2/model/list` 的应答。
 * @returns 模型清单；形状不认识时是空清单。
 */
export function parseModels(payload: unknown): QoderModel[] {
  const data = record(payload)
  const entries = data[SCENE]
  if (!Array.isArray(entries)) return []
  const models: QoderModel[] = []
  for (const entry of entries) {
    const model = record(entry)
    const id = model['key']
    if (typeof id !== 'string' || id === '') continue
    const name = typeof model['display_name'] === 'string' && model['display_name'] !== '' ? model['display_name'] : id
    const description = typeof model['description'] === 'string' && model['description'] !== '' ? model['description'] : undefined
    const contextWindow = typeof model['max_input_tokens'] === 'number' ? model['max_input_tokens'] : undefined
    const efforts = effortsOf(model)
    const supportsImages = typeof model['is_vl'] === 'boolean' ? model['is_vl'] : undefined
    const maxTokensField = model['maxTokensField'] === 'max_completion_tokens' ? 'max_completion_tokens' : 'max_tokens'
    models.push({
      id,
      name,
      ...(description === undefined ? {} : { description }),
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(efforts === undefined ? {} : { efforts }),
      ...(supportsImages === undefined ? {} : { supportsImages }),
      maxTokensField,
    })
  }
  return models
}

/**
 * 取一次模型清单。
 * @param options - 凭据、端点与 fetch 实现。
 * @returns 模型清单。
 */
export async function fetchModels(options: {
  readonly credential: QoderCredential
  readonly endpoints?: QoderEndpoints | undefined
  readonly fetchImpl?: typeof fetch | undefined
}): Promise<QoderModel[]> {
  const endpoints = options.endpoints ?? resolveEndpoints()
  const fetchImpl = options.fetchImpl ?? fetch
  const response = await fetchImpl(endpoints.modelListUrl, {
    method: 'GET',
    redirect: 'error',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${options.credential.accessToken}`,
      ...qoderIdentityHeaders(),
    },
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`Qoder 模型清单取不到（HTTP ${response.status}）`)
  }
  return parseModels(await response.json())
}

/** 推理档位：支持列表优先，没有就用默认档。 */
function effortsOf(model: Record<string, unknown>): readonly string[] | undefined {
  const efforts = model['efforts']
  if (Array.isArray(efforts)) {
    const list = efforts.filter((effort): effort is string => typeof effort === 'string' && effort !== '')
    return list.length === 0 ? undefined : list
  }
  const fallback = model['default_effort']
  return typeof fallback === 'string' && fallback !== '' ? [fallback] : undefined
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
