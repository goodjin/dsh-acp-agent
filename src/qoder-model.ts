/**
 * Qoder 国际版作为模型，而不是作为 ACP agent。
 *
 * DSH 的循环已经会读文件、跑命令、请求批准、取消、写会话了。这里只回答「模型
 * 那一问」：解出凭据、把这一轮的历史与工具发给 Qoder 国际版的模型、把回来的
 * 文本、推理与工具调用交回循环。
 *
 * 登录后拉到的模型清单会写进目录的运行时账本——选择器以它为准（agent 自报为准
 * 是这一层的规矩）；拉不到也不影响发消息，preset 行里声明的兜底清单还在。
 *
 * **推理档位按模型过滤**：Qoder 的每个模型自己声明支持哪些档位（清单里的
 * `efforts`），发一个它不认的档位，服务端会拒——而且拒绝的理由往往含糊得
 * 看不出是档位的事。
 */

import type { CatalogTurnRequest } from './catalog.ts'
import type { PresetConfig } from './registry.ts'
import { fetchModels, resolveCredential, streamQoder } from './qoder/index.ts'
import type { QoderCredential, QoderModel } from './qoder/index.ts'
import type { WorkBuddyStreamChunk } from './workbuddy/sse.ts'

/** 运行时清单写进目录账本时用的形状。 */
export type QoderReportedModel = {
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

/** 每个模型支持哪些档位（按模型 id 记，跨 preset 共用）。 */
const modelEfforts = new Map<string, readonly string[]>()

/**
 * 认下 Qoder 国际版那一行，并把它变成模型插件。
 * @param config - 预置配置；用它判断哪一行是 Qoder 国际版。
 * @param deps - 可选回调：把运行时清单写进目录账本。
 * @returns 回答函数；不是那一行时返回 `undefined`。
 */
export function qoderModelStream(
  config: PresetConfig,
  deps?: {
    readonly onRuntimeModels?: ((presetId: string, models: readonly QoderReportedModel[]) => void) | undefined
  },
): (presetId: string, request: CatalogTurnRequest) => AsyncGenerator<WorkBuddyStreamChunk> | undefined {
  return (presetId, request) => {
    const preset = config.presets[presetId]
    if (preset?.agent !== 'qoder-global') return undefined
    return answer(presetId, request, deps)
  }
}

async function* answer(
  presetId: string,
  request: CatalogTurnRequest,
  deps: {
    readonly onRuntimeModels?: ((presetId: string, models: readonly QoderReportedModel[]) => void) | undefined
  } | undefined,
): AsyncGenerator<WorkBuddyStreamChunk> {
  const credential = await resolveCredential()
  await publishModels(presetId, credential, deps)
  yield* streamQoder(requestWithKnownEffort(request), {
    credential: (rejectedToken?: string) => resolveCredential({ rejectedToken }),
  })
}

/**
 * 把这一轮里模型不支持的档位摘掉。
 *
 * 清单还没拉到时不知道模型支持什么，那就原样下发——用户自己选的档位，比我们
 * 猜的强。
 */
function requestWithKnownEffort(request: CatalogTurnRequest): CatalogTurnRequest {
  const effort = request.reasoningEffort
  if (typeof effort !== 'string' || effort === '') return request
  const supported = modelEfforts.get(request.model)
  if (supported === undefined || supported.includes(effort)) return request
  return { ...request, reasoningEffort: undefined }
}

/**
 * 把登录后拉到的模型清单写进目录账本。
 *
 * 拉不到就安静地跳过：选择器还有 preset 行里声明的兜底清单，这一轮照样发。
 */
async function publishModels(
  presetId: string,
  credential: QoderCredential,
  deps: {
    readonly onRuntimeModels?: ((presetId: string, models: readonly QoderReportedModel[]) => void) | undefined
  } | undefined,
): Promise<void> {
  const last = modelListAt.get(presetId)
  if (last !== undefined) {
    const ttl = last.ok ? MODEL_LIST_TTL_MS : MODEL_LIST_RETRY_MS
    if (Date.now() - last.at < ttl) return
  }
  const models = await fetchModels({ credential }).catch(() => undefined)
  if (models === undefined || models.length === 0) {
    // 没拉到：记住这次失败，过一会儿再试，别每轮都去撞一次。
    modelListAt.set(presetId, { at: Date.now(), ok: false })
    return
  }
  modelListAt.set(presetId, { at: Date.now(), ok: true })
  rememberEfforts(models)
  deps?.onRuntimeModels?.(presetId, models.map(model => ({
    id: model.id,
    name: model.name,
    ...(model.description === undefined ? {} : { description: model.description }),
  })))
}

/** 记住每个模型支持哪些档位。 */
function rememberEfforts(models: readonly QoderModel[]): void {
  for (const model of models) {
    if (model.efforts !== undefined) modelEfforts.set(model.id, model.efforts)
  }
}
