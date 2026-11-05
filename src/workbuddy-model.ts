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
  attachAccount,
  credentialResolver,
  fetchAccount,
  forceRefreshCredential,
  loadCatalog,
  readSelection,
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
const MODEL_LIST_TTL_MS = 10 * 60_000

/** 清单没拉到，多久之内不再试（没登录时每一轮都去撞上游）。 */
const MODEL_LIST_RETRY_MS = 5 * 60_000

/** 每个 preset 上次拉清单的时间与结果。 */
const modelListAt = new Map<string, { at: number; ok: boolean }>()

/** 上次拉到的清单（连同站点给的端点）。 */
let lastCatalog: { at: number; models: readonly WorkBuddyReportedModel[]; endpoint?: string | undefined } | undefined

/** 上次拉清单失败的时间（失败后别马上再撞）。 */
let lastCatalogFailedAt: number | undefined

/**
 * 把清单缓存丢掉，下次重新拉。
 *
 * 登录成功时要用：刚拿到的新令牌可能能拿到更大的清单，旧的缓存不能再挡着。
 */
export function invalidateWorkBuddyCatalog(): void {
  lastCatalog = undefined
  lastCatalogFailedAt = undefined
  modelListAt.clear()
}

/**
 * 这一行真正提供哪些模型。
 *
 * 用户在设置里勾过的优先（那是他的意思），没勾过（没有这个文件）就用挂载行里
 * 声明的那份——装上就有默认的一套，用户可以改。
 */
async function effectiveDeclared(
  declared: readonly { readonly id: string; readonly name: string; readonly description?: string | undefined }[],
): Promise<readonly { readonly id: string; readonly name: string; readonly description?: string | undefined }[]> {
  const selected = await readSelection().catch(() => undefined)
  if (selected === undefined) return declared
  // 勾选只给 id：名字与描述从站点那份清单里补（勾了但站点没有的，按 id 显示）。
  return selected.map(id => ({ id, name: id }))
}

/**
 * 每一行的清单发布口。
 *
 * `declared` 是那一行**声明要提供哪些模型**（挂载行里的 `models`）——它就是白名单：
 * 站点给的清单可能有几十个，我们只提供声明过的那些。
 */
type WorkBuddyPublisher = {
  readonly declared: readonly { readonly id: string; readonly name: string; readonly description?: string | undefined }[]
  readonly publish: (models: readonly WorkBuddyReportedModel[]) => void
}

/** 每个 preset 的清单发布口（写进目录的运行时账本）。 */
const publishers = new Map<string, WorkBuddyPublisher>()

/**
 * 登记某一行的清单发布口。
 *
 * 清单要**主动**进目录账本：选择器在用户打开时就会问「这一行有哪些模型」，
 * 等他先发一条消息才更新，用户看到的就是一份过期的（静态兜底）清单。
 * @param presetId - 那一行的 id。
 * @param publish - 发布口。
 */
export function registerWorkBuddyModelPublisher(
  presetId: string,
  declared: readonly { readonly id: string; readonly name: string; readonly description?: string | undefined }[],
  publish: (models: readonly WorkBuddyReportedModel[]) => void,
): void {
  publishers.set(presetId, { declared, publish })
}

/**
 * 声明的清单与站点给的清单合起来。
 *
 * **声明的清单说了算**：这一行提供哪些模型由挂载行决定（白名单），站点给的清单只
 * 用来补名字、积分倍率与上下文——站点没提到的那个模型，仍然按声明里写的显示。
 * @param declared - 那一行声明的模型。
 * @param runtime - 站点给的清单（可能几十个，也可能没有）。
 * @returns 这一行真正提供的模型。
 */
export function mergeDeclaredModels(
  declared: readonly { readonly id: string; readonly name: string; readonly description?: string | undefined }[],
  runtime: readonly WorkBuddyReportedModel[],
): WorkBuddyReportedModel[] {
  const byId = new Map(runtime.map(model => [model.id, model]))
  const resolved = declared.map(entry => {
    const found = byId.get(entry.id)
    const name = found?.name ?? entry.name
    const description = found?.description ?? entry.description
    return {
      id: entry.id,
      name,
      ...(description === undefined ? {} : { description }),
    }
  })
  // 同名的（站点的 hy4free 与 hy4std 都叫「Hy4」）在选择器里会长得一模一样，
  // 分不出谁是谁——补上 id 让人认得出。
  const nameCount = new Map<string, number>()
  for (const entry of resolved) {
    nameCount.set(entry.name, (nameCount.get(entry.name) ?? 0) + 1)
  }
  return resolved.map(entry => (
    (nameCount.get(entry.name) ?? 0) > 1
      ? { ...entry, name: `${entry.name}（${entry.id}）` }
      : entry
  ))
}

/**
 * 默认勾了哪些模型（挂载行里声明的那份）。
 *
 * 设置界面要显示「当前生效的是哪些」——用户还没自己勾过时，生效的就是这一份。
 */
export function workBuddyDeclaredModelIds(): readonly string[] {
  const first = [...publishers.values()][0]
  return first?.declared.map(entry => entry.id) ?? []
}

/**
 * 把清单拉出来并写进目录账本。
 *
 * 没登录就没有清单（拉了也是空），安静地跳过——界面退回静态兜底清单。
 * @param presetId - 那一行的 id；不给就刷所有登记过的行。
 * @param options - 端点与 fetch 实现（测试注入）。
 */
export async function ensureWorkBuddyModels(
  presetId?: string,
  options?: { readonly endpoints?: WorkBuddyEndpoints | undefined; readonly fetchImpl?: typeof fetch | undefined },
): Promise<void> {
  const targets = presetId === undefined ? [...publishers.keys()] : [presetId]
  if (targets.length === 0) return
  const endpoints = options?.endpoints ?? resolveEndpoints()
  let credential: WorkBuddyCredential
  try {
    credential = await credentialResolver({ endpoints })()
  } catch {
    return
  }
  const catalog = await loadWorkBuddyCatalog(credential, endpoints, options?.fetchImpl)
  if (catalog === undefined || catalog.models.length === 0) return
  for (const target of targets) {
    const publisher = publishers.get(target)
    if (publisher === undefined) continue
    const declared = await effectiveDeclared(publisher.declared)
    publisher.publish(mergeDeclaredModels(declared, catalog.models))
  }
}

/**
 * 取一次清单（带缓存），连同站点给的模型端点。
 *
 * 端点跟着清单一起走：站点说模型在哪儿，模型请求就打哪儿——两处不同源就会出现
 * 「清单能列出来、模型请求却被拒」。
 */
async function loadWorkBuddyCatalog(
  credential: WorkBuddyCredential,
  endpoints: WorkBuddyEndpoints,
  fetchImpl?: typeof fetch,
): Promise<{ models: readonly WorkBuddyReportedModel[]; endpoint?: string | undefined } | undefined> {
  if (lastCatalog !== undefined && Date.now() - lastCatalog.at < MODEL_LIST_TTL_MS) return lastCatalog
  if (lastCatalogFailedAt !== undefined && Date.now() - lastCatalogFailedAt < MODEL_LIST_RETRY_MS) return undefined
  const loaded = await loadCatalog({
    credential,
    endpoints,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  }).catch(() => undefined)
  if (loaded === undefined || loaded.models.length === 0) {
    // 没拉到：记住这次失败，过一会儿再试，别每轮都去撞一次。
    lastCatalogFailedAt = Date.now()
    return undefined
  }
  lastCatalogFailedAt = undefined
  const models: WorkBuddyReportedModel[] = loaded.models.map(model => ({
    id: model.id,
    name: model.name,
    ...(model.description === undefined ? {} : { description: model.description }),
  }))
  lastCatalog = {
    at: Date.now(),
    models,
    ...(loaded.endpoint === undefined ? {} : { endpoint: loaded.endpoint }),
  }
  return lastCatalog
}

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
  // 登记发布口：清单要能主动进目录账本，不能等用户先发一条消息。
  //
  // 登记本身不依赖回调在不在——设置界面要显示「默认勾了哪些」，那一份就是挂载行
  // 里声明的，宿主有没有给账本回调都得能读到。
  for (const [presetId, preset] of Object.entries(config.presets)) {
    if (preset.agent !== 'workbuddy') continue
    registerWorkBuddyModelPublisher(
      presetId,
      preset.models ?? [],
      models => { deps?.onRuntimeModels?.(presetId, models) },
    )
  }
  return (presetId, request) => {
    const preset = config.presets[presetId]
    if (preset?.agent !== 'workbuddy') return undefined
    // 端点一处说了算：登录、清单、模型请求都从它派生，不会出现两处不同源。
    const endpoints = resolveEndpoints(preset.baseUrl)
    return answer(presetId, request, deps, endpoints, preset.baseUrl === undefined, preset.models ?? [])
  }
}

async function* answer(
  presetId: string,
  request: CatalogTurnRequest,
  deps: {
    readonly onRuntimeModels?: ((presetId: string, models: readonly WorkBuddyReportedModel[]) => void) | undefined
  } | undefined,
  endpoints: WorkBuddyEndpoints,
  /** 端点是不是由站点给的（配置里显式写了端点时，以配置为准）。 */
  followCatalogEndpoint: boolean,
  /** 这一行声明要提供哪些模型（白名单）。 */
  declared: readonly { readonly id: string; readonly name: string; readonly description?: string | undefined }[],
): AsyncGenerator<WorkBuddyStreamChunk> {
  const resolve = credentialResolver({ endpoints })
  const credential = await resolveWithAccount(resolve, endpoints)
  const catalog = await loadWorkBuddyCatalog(credential, endpoints)
  publishModels(presetId, catalog?.models, deps, await effectiveDeclared(declared))
  // 站点说模型在哪儿就打哪儿；配置里显式写了端点就听配置的（那是部署方的意思）。
  const modelEndpoints = followCatalogEndpoint && catalog?.endpoint !== undefined
    ? resolveEndpoints(catalog.endpoint)
    : endpoints

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
    endpoints: modelEndpoints,
    // 令牌被作废时续期一次再重试；续不了就让这一轮以失败结束。
    onUnauthorized: async () => {
      const refreshed = await forceRefreshCredential({ endpoints }).catch(() => undefined)
      return refreshed?.accessToken
    },
  })
}

/**
 * 把拉到的模型清单写进目录账本。
 *
 * 拉不到就安静地跳过：选择器还有 preset 行里声明的兜底清单，这一轮照样发。
 */
function publishModels(
  presetId: string,
  models: readonly WorkBuddyReportedModel[] | undefined,
  deps: {
    readonly onRuntimeModels?: ((presetId: string, models: readonly WorkBuddyReportedModel[]) => void) | undefined
  } | undefined,
  declared: readonly { readonly id: string; readonly name: string; readonly description?: string | undefined }[],
): void {
  if (deps?.onRuntimeModels === undefined || models === undefined || models.length === 0) return
  modelListAt.set(presetId, { at: Date.now(), ok: true })
  deps.onRuntimeModels(presetId, mergeDeclaredModels(declared, models))
}

/**
 * 凭据里没有账户信息时补一次。
 *
 * 登录拿到的令牌不带账户信息（uid、企业 id），而模型请求要带 `X-User-Id`、界面要
 * 显示是谁。补不上也不影响发请求。
 */
async function resolveWithAccount(
  resolve: () => Promise<WorkBuddyCredential>,
  endpoints: WorkBuddyEndpoints,
): Promise<WorkBuddyCredential> {
  const credential = await resolve()
  if (credential.account !== undefined) return credential
  const account = await fetchAccount({ accessToken: credential.accessToken, endpoints }).catch(() => undefined)
  if (account === undefined) return credential
  const attached = await attachAccount(account).catch(() => undefined)
  return attached ?? { ...credential, account }
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
