/**
 * WorkBuddy 的模型清单。
 *
 * 清单来自站点下发的产品配置（`/v3/config`），要登录才有——没登录时那份配置里
 * `models` 是空的。所以取不到就返回空清单，让选择器退回兜底清单，而不是整个
 * 分组从界面上消失。
 *
 * 只取需要的字段：名字、描述、上下文长度、推理档位、支不支持工具与图片。积分
 * 倍率拼进描述里——用户选模型前要知道这个模型花多少。
 */

import { resolveEndpoints } from './endpoints.ts'
import type { WorkBuddyEndpoints } from './endpoints.ts'
import type { WorkBuddyCredential } from './credential.ts'

/** 「要完整配置」的那个头：少了它，站点只给一份精简配置。 */
const PRODUCT_CONFIGURATION_REQUEST_HEADER = '__codebuddyProductConfigurationRequest'

export type WorkBuddyModel = {
  readonly id: string
  readonly name: string
  readonly description?: string | undefined
  /** 上下文长度（输入 token 上限）。 */
  readonly contextWindow?: number | undefined
  /** 这个模型提供的推理档位。 */
  readonly efforts?: readonly string[] | undefined
  readonly supportsToolCall?: boolean | undefined
  readonly supportsImages?: boolean | undefined
}

/**
 * 从产品配置里取出模型清单。
 * @param payload - `/v3/config` 的应答。
 * @returns 模型清单；配置是空的或形状不认识时是空清单。
 */
export function parseModels(payload: unknown): WorkBuddyModel[] {
  if (!isRecord(payload)) return []
  const data = payload['data']
  if (!isRecord(data)) return []
  const models = data['models']
  if (!Array.isArray(models)) return []
  const parsed: WorkBuddyModel[] = []
  for (const model of models) {
    if (!isRecord(model)) continue
    const id = typeof model['id'] === 'string' ? model['id'] : ''
    if (id === '') continue
    const name = typeof model['name'] === 'string' && model['name'] !== '' ? model['name'] : id
    const description = describe(model)
    const contextWindow = typeof model['maxInputTokens'] === 'number' ? model['maxInputTokens'] : undefined
    const efforts = effortsOf(model)
    const supportsToolCall = typeof model['supportsToolCall'] === 'boolean' ? model['supportsToolCall'] : undefined
    const supportsImages = typeof model['supportsImages'] === 'boolean' ? model['supportsImages'] : undefined
    parsed.push({
      id,
      name,
      ...(description === undefined ? {} : { description }),
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(efforts === undefined ? {} : { efforts }),
      ...(supportsToolCall === undefined ? {} : { supportsToolCall }),
      ...(supportsImages === undefined ? {} : { supportsImages }),
    })
  }
  return parsed
}

/**
 * 取一次模型清单。
 * @param options - 凭据、端点与 fetch 实现。
 * @returns 模型清单。
 */
export async function fetchModels(options: {
  readonly credential: WorkBuddyCredential
  readonly endpoints?: WorkBuddyEndpoints | undefined
  readonly fetchImpl?: typeof fetch | undefined
}): Promise<WorkBuddyModel[]> {
  const endpoints = options.endpoints ?? resolveEndpoints()
  const fetchImpl = options.fetchImpl ?? fetch
  const token = options.credential.accessToken
  const response = await fetchImpl(endpoints.configUrl, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      [PRODUCT_CONFIGURATION_REQUEST_HEADER]: 'true',
    },
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`WorkBuddy 模型清单取不到（${String(response.status)}）：${scrub(detail.slice(0, 300), token)}`)
  }
  const text = await response.text().catch(() => '')
  let payload: unknown
  try {
    payload = JSON.parse(text) as unknown
  } catch {
    throw new Error('WorkBuddy 模型清单：应答不是 JSON')
  }
  return parseModels(payload)
}

/** 描述：中文优先，英文兜底，积分倍率附在后面。 */
function describe(model: Record<string, unknown>): string | undefined {
  const zh = typeof model['descriptionZh'] === 'string' ? model['descriptionZh'] : ''
  const en = typeof model['descriptionEn'] === 'string' ? model['descriptionEn'] : ''
  const base = zh !== '' ? zh : en
  const credits = typeof model['credits'] === 'string' ? model['credits'] : ''
  if (base === '' && credits === '') return undefined
  if (credits === '') return base
  return base === '' ? `积分 ${credits}` : `${base}（积分 ${credits}）`
}

/** 推理档位：支持列表优先，没有就用默认档。 */
function effortsOf(model: Record<string, unknown>): readonly string[] | undefined {
  const reasoning = model['reasoning']
  if (!isRecord(reasoning)) return undefined
  const supported = reasoning['supportedEfforts']
  if (Array.isArray(supported)) {
    const efforts = supported.filter((effort): effort is string => typeof effort === 'string' && effort !== '')
    return efforts.length === 0 ? undefined : efforts
  }
  const fallback = reasoning['defaultEffort']
  return typeof fallback === 'string' && fallback !== '' ? [fallback] : undefined
}

function scrub(text: string, token: string): string {
  if (token === '') return text
  return text.split(token).join('[redacted]')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
