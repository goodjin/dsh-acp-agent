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
import { readSelection } from './model-selection.ts'
import { BUILTIN_MODELS, fetchModels, resolveCredential, streamQoder } from './qoder/index.ts'
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

/** 每一行声明了哪些模型（按 preset 记，跨 preset 共用）。 */
const declaredModels = new Map<string, readonly { readonly id: string; readonly name: string; readonly description?: string | undefined }[]>()

/** 每一行的清单发布口（写进目录的运行时账本）。 */
const publishers = new Map<string, {
  readonly declared: readonly { readonly id: string; readonly name: string; readonly description?: string | undefined }[]
  readonly publish: (models: readonly QoderReportedModel[]) => void
}>()

/** 每个模型的最大 token 字段名（按模型 id 记，跨 preset 共用）。 */
const modelMaxTokensField = new Map<string, 'max_tokens' | 'max_completion_tokens'>()

// 清单没到手时，内置模型的字段名也得是对的。
for (const [id, model] of Object.entries(BUILTIN_MODELS)) modelMaxTokensField.set(id, model.maxTokensField)

/**
 * 默认勾了哪些模型（挂载行里声明的那份）。
 *
 * 设置界面要显示「当前生效的是哪些」——用户还没自己勾过时，生效的就是这一份。
 */
export function qoderDeclaredModelIds(): readonly string[] {
  const first = [...declaredModels.values()][0]
  return first === undefined ? [] : first.map(entry => entry.id)
}

/**
 * 声明的那份模型（带名字）。
 *
 * 站点的整份清单要 Qoder 自己的签名才拿得到（见 docs/agent-acp/qoder-global.md），
 * 所以设置里的列表在拿不到站点清单时退回这一份——空着更没用。
 */
export function qoderDeclaredModels(): readonly QoderModel[] {
  const first = [...declaredModels.values()][0]
  return first === undefined ? [] : [...first]
}

/**
 * 把清单缓存丢掉，下次重新拉。
 *
 * 登录成功、勾选变了之后要用：新的状态可能拿到更大的清单，旧的缓存别再挡着。
 */
export function invalidateQoderCatalog(): void {
  modelListAt.clear()
}

/**
 * 重新拉一次清单并写进目录账本。
 *
 * 勾选完立刻调用：选择器下一次打开就是新的那份。
 */
export async function refreshQoderModels(): Promise<void> {
  if (publishers.size === 0) return
  let credential: QoderCredential
  try {
    credential = await resolveCredential()
  } catch {
    return
  }
  const models = await fetchModels({ credential }).catch(() => undefined)
  if (models === undefined || models.length === 0) return
  modelListAt.set([...publishers.keys()][0] ?? '', { at: Date.now(), ok: true })
  rememberEfforts(models)
  const byId = new Map(models.map(model => [model.id, model]))
  for (const publisher of publishers.values()) {
    publisher.publish(publisher.declared.map(entry => {
      const found = byId.get(entry.id)
      const description = found?.description ?? entry.description
      return {
        id: entry.id,
        name: found?.name ?? entry.name,
        ...(description === undefined ? {} : { description }),
      }
    }))
  }
}

/**
 * 这一行真正提供哪些模型。
 *
 * 用户在设置里勾过的优先（那是他的意思），没勾过就用挂载行里声明的那一份。
 */
async function effectiveDeclared(
  declared: readonly { readonly id: string; readonly name: string; readonly description?: string | undefined }[],
): Promise<readonly { readonly id: string; readonly name: string; readonly description?: string | undefined }[]> {
  const selected = await readSelection('qoder').catch(() => undefined)
  if (selected === undefined) return declared
  return selected.map(id => ({ id, name: id }))
}

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
  // 登记默认清单与发布口：设置界面要显示「默认勾了哪些」，勾完要立刻重发清单。
  for (const [presetId, preset] of Object.entries(config.presets)) {
    if (preset.agent !== 'qoder-global') continue
    declaredModels.set(presetId, (preset.models ?? []).map(model => ({
      id: model.id,
      name: model.name,
      ...(model.description === undefined ? {} : { description: model.description }),
    })))
    publishers.set(presetId, {
      declared: preset.models ?? [],
      publish: models => { deps?.onRuntimeModels?.(presetId, models) },
    })
  }
  return (presetId, request) => {
    const preset = config.presets[presetId]
    if (preset?.agent !== 'qoder-global') return undefined
    return answer(presetId, request, deps, preset.models ?? [])
  }
}

async function* answer(
  presetId: string,
  request: CatalogTurnRequest,
  deps: {
    readonly onRuntimeModels?: ((presetId: string, models: readonly QoderReportedModel[]) => void) | undefined
  } | undefined,
  declared: readonly { readonly id: string; readonly name: string; readonly description?: string | undefined }[],
): AsyncGenerator<WorkBuddyStreamChunk> {
  const credential = await resolveCredential()
  await publishModels(presetId, credential, deps, await effectiveDeclared(declared))
  yield* streamQoder(requestWithKnownEffort(request), {
    credential: (rejectedToken?: string) => resolveCredential({ rejectedToken }),
    maxTokensField: modelMaxTokensField.get(request.model),
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
  declared: readonly { readonly id: string; readonly name: string; readonly description?: string | undefined }[],
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
  // 声明的清单说了算（白名单）：站点给的清单只用来补名字与描述。
  const byId = new Map(models.map(model => [model.id, model]))
  const merged = declared.map(entry => {
    const found = byId.get(entry.id)
    const description = found?.description ?? entry.description
    return {
      id: entry.id,
      name: found?.name ?? entry.name,
      ...(description === undefined ? {} : { description }),
    }
  })
  deps?.onRuntimeModels?.(presetId, merged)
}

/** 记住每个模型支持哪些档位。 */
function rememberEfforts(models: readonly QoderModel[]): void {
  for (const model of models) {
    if (model.efforts !== undefined) modelEfforts.set(model.id, model.efforts)
    if (model.maxTokensField !== undefined) modelMaxTokensField.set(model.id, model.maxTokensField)
  }
}
