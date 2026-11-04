/**
 * WorkBuddy 作为模型，而不是作为 ACP agent。
 *
 * DSH 的循环已经会读文件、跑命令、请求批准、取消、写会话了。这里只回答「模型
 * 那一问」：解出凭据、把这一轮的历史与工具发给 WorkBuddy 的模型、把回来的文本、
 * 推理与工具调用交回循环。
 *
 * 登录后拉到���模型清单会写进目录的运行时账本——选择器以它为准（agent 自报为准是
 * 这一层的规矩）；拉不到也不影响发消息，preset 行里声明的兜底清单还在。
 */

import type { CatalogTurnRequest } from './catalog.ts'
import type { PresetConfig } from './registry.ts'
import {
  credentialResolver,
  fetchModels,
  forceRefreshCredential,
  resolveEndpoints,
  streamWorkBuddy,
} from './workbuddy/index.ts'
import type { WorkBuddyCredential, WorkBuddyEndpoints, WorkBuddyStreamChunk } from './workbuddy/index.ts'

/** 运行时清单写进目录账本时用的形状。 */
export type WorkBuddyReportedModel = {
  readonly id: string
  readonly name: string
  readonly description?: string | undefined
}

/** 清单拉到了，多久之内不重拉。 */
const MODEL_LIST_TTL_MS = 24 * 60 * 60_000

/** 清单没拉到，多久之内不再试（没登录时每一轮都去试会把上游打爆）。 */
const MODEL_LIST_RETRY_MS = 5 * 60_000

/** 每个 preset 上次拉清单的时间与结果。 */
const modelListAt = new Map<string, { at: number; ok: boolean }>()

/**
 * 认下 WorkBuddy 那一行，并把它变成模型插件。
 * @param config - 预置配置；用它判断哪一行是 WorkBuddy。
 * @param deps - 可选回调：把运行时清单写进目录账本。
 * @returns 回答函数；不是 WorkBuddy 那一行时返回 `undefined`。
 */
export function workBuddyModelStream(
  config: PresetConfig,
  deps?: {
    readonly onRuntimeModels?: ((presetId: string, models: readonly WorkBuddyReportedModel[]) => void) | undefined
  },
): (presetId: string, request: CatalogTurnRequest) => AsyncIterable<WorkBuddyStreamChunk> | undefined {
  return (presetId, request) => {
    const preset = config.presets[presetId]
    if (preset?.agent !== 'workbuddy') return undefined
    // 端点一处说了算：登录、清单、模型请求都从它派生，不会出现两处不同源。
    const endpoints = resolveEndpoints(preset.baseUrl)
    return answer(presetId, request, deps, endpoints)
  }
}

async function* answer(
  presetId: string,
  request: CatalogTurnRequest,
  deps: {
    readonly onRuntimeModels?: ((presetId: string, models: readonly WorkBuddyReportedModel[]) => void) | undefined
  } | undefined,
  endpoints: WorkBuddyEndpoints,
): AsyncGenerator<WorkBuddyStreamChunk> {
  const resolve = credentialResolver({ endpoints })
  const credential = await resolve()
  await publishModels(presetId, credential, deps, endpoints)

  const tools = normalizeTools(request.tools)
  yield* streamWorkBuddy({
    model: request.model,
    messages: Array.isArray(request.messages) ? request.messages : [],
    ...(typeof request.system === 'string' ? { system: request.system } : {}),
    ...(tools === undefined ? {} : { tools }),
    ...(typeof request.reasoningEffort === 'string' && request.reasoningEffort !== ''
      ? { reasoningEffort: request.reasoningEffort }
      : {}),
    ...(typeof request.maxTokens === 'number' ? { maxTokens: request.maxTokens } : {}),
    ...(request.signal instanceof AbortSignal ? { signal: request.signal } : {}),
    accessToken: credential.accessToken,
    ...(credential.account === undefined ? {} : { account: credential.account }),
    endpoints,
    // 令牌被作废时续期一次再重试；续不了就让这一轮以失败结束。
    onUnauthorized: async () => {
      const refreshed = await forceRefreshCredential({ endpoints }).catch(() => undefined)
      return refreshed?.accessToken
    },
  })
}

/**
 * 把登录后拉到的模型清单写进目录账本。
 *
 * 拉不到就安静地跳过：选择器还有 preset 行里声明的兜底清单，这一轮照样发。
 */
async function publishModels(
  presetId: string,
  credential: WorkBuddyCredential,
  deps: {
    readonly onRuntimeModels?: ((presetId: string, models: readonly WorkBuddyReportedModel[]) => void) | undefined
  } | undefined,
  endpoints: WorkBuddyEndpoints,
): Promise<void> {
  if (deps?.onRuntimeModels === undefined) return
  const last = modelListAt.get(presetId)
  if (last !== undefined) {
    const ttl = last.ok ? MODEL_LIST_TTL_MS : MODEL_LIST_RETRY_MS
    if (Date.now() - last.at < ttl) return
  }
  const models = await fetchModels({ credential, endpoints }).catch(() => undefined)
  if (models === undefined || models.length === 0) {
    // 没拉到：记住这次失败，过一会儿再试，别每轮都去撞一次。
    modelListAt.set(presetId, { at: Date.now(), ok: false })
    return
  }
  modelListAt.set(presetId, { at: Date.now(), ok: true })
  deps.onRuntimeModels(presetId, models.map(model => ({
    id: model.id,
    name: model.name,
    ...(model.description === undefined ? {} : { description: model.description }),
  })))
}

function normalizeTools(
  tools: CatalogTurnRequest['tools'],
): { name: string; description?: string; parameters?: Record<string, unknown> }[] | undefined {
  if (tools === undefined) return undefined
  return tools.flatMap(tool => {
    if (typeof tool?.name !== 'string' || tool.name === '') return []
    return [{
      name: tool.name,
      ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
      ...(tool.parameters !== undefined && typeof tool.parameters === 'object' ? { parameters: tool.parameters } : {}),
    }]
  })
}
