/**
 * WorkBuddy 的模型清单。
 *
 * 同一个账号有两份清单，来源不同、口径不同：
 * - **桌面版缓存的那份**（`~/.workbuddy/local_storage` 里，桌面版登录后自己写下的
 *   产品配置）：模型全，**带官方积分倍率**（套餐档位与各家模型的倍率都在里面）。
 * - **我们自己问站点要的那份**（`GET {端点}/v3/config`）：模型少一截，也没有倍率
 *   （个人作用域的令牌拿到的是缩水版）。
 *
 * 实测过桌面版那份里的模型（hy4-preview、fast-model 这些）用我们的令牌照样跑得
 * 通——差的只是清单口径，不是能力。所以**优先用桌面版那份**，借不到就用我们自己
 * 那份，两样都没有才是空（界面退回静态兜底清单）。
 *
 * 借桌面版的缓存是本仓库的老路子：zcode 解密桌面版的登录密钥、minimaxi 复用
 * MiniMax Code 的凭据，都是同一件事——桌面版已经登录了，我们就不必再折腾一遍。
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { desktopCatalogDir, resolveEndpoints, workBuddyHeaders } from './endpoints.ts'
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
  /** 官方积分倍率（站点给的原值，如 `x0.29`）。 */
  readonly credits?: string | undefined
}

/** 清单从哪来的。 */
export type WorkBuddyCatalogSource = 'desktop' | 'cloud' | 'none'

/** 一份清单，连同它的出处与端点。 */
export type WorkBuddyCatalog = {
  readonly models: readonly WorkBuddyModel[]
  /** 站点告诉我们的模型端点（清单与模型请求应该打同一个地方）。 */
  readonly endpoint?: string | undefined
  readonly source: WorkBuddyCatalogSource
}

/**
 * 从产品配置里取出模型清单。
 *
 * 两种外壳都认：站点的 `{code, data:{models}}`，以及桌面版缓存里的
 * `[{userId, data:{models}}]`。
 * @param payload - 配置应答。
 * @returns 模型清单；配置是空的或形状不认识时是空清单。
 */
export function parseModels(payload: unknown): WorkBuddyModel[] {
  const models = modelsOf(payload)
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
    const credits = typeof model['credits'] === 'string' ? model['credits'] : undefined
    parsed.push({
      id,
      name,
      ...(description === undefined ? {} : { description }),
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(efforts === undefined ? {} : { efforts }),
      ...(supportsToolCall === undefined ? {} : { supportsToolCall }),
      ...(supportsImages === undefined ? {} : { supportsImages }),
      ...(credits === undefined ? {} : { credits }),
    })
  }
  return parsed
}

/** 配置里的模型数组（两种外壳都找一遍）。 */
function modelsOf(payload: unknown): unknown {
  if (isRecord(payload)) {
    const data = payload['data']
    if (isRecord(data) && Array.isArray(data['models'])) return data['models']
    if (Array.isArray(payload['models'])) return payload['models']
    return undefined
  }
  if (Array.isArray(payload)) {
    for (const entry of payload) {
      const found = modelsOf(entry)
      if (found !== undefined) return found
    }
  }
  return undefined
}

/** 配置里的端点（两种外壳都找一遍）。 */
function endpointOf(payload: unknown): string | undefined {
  if (isRecord(payload)) {
    const data = payload['data']
    if (isRecord(data) && typeof data['endpoint'] === 'string' && data['endpoint'] !== '') {
      return data['endpoint']
    }
    if (typeof payload['endpoint'] === 'string' && payload['endpoint'] !== '') return payload['endpoint']
    return undefined
  }
  if (Array.isArray(payload)) {
    for (const entry of payload) {
      const found = endpointOf(entry)
      if (found !== undefined) return found
    }
  }
  return undefined
}

/**
 * 读桌面版缓存的那份清单。
 *
 * 桌面版把站点下发的产品配置缓存在 `~/.workbuddy/local_storage/*.info` 里；文件名
 * 是哈希，条目也不止一条，所以按「最新的、里面带模型的」那条取。
 * @param options - 缓存目录。
 * @returns 清单与端点；没有可用缓存时是 `undefined`。
 */
export async function readDesktopCatalog(options: {
  readonly dir?: string | undefined
}): Promise<{ models: readonly WorkBuddyModel[]; endpoint?: string | undefined } | undefined> {
  const dir = options.dir ?? desktopCatalogDir()
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return undefined
  }
  const files: { path: string; at: number }[] = []
  for (const name of names.filter(candidate => candidate.endsWith('.info'))) {
    const path = join(dir, name)
    try {
      const info = await stat(path)
      if (info.isFile()) files.push({ path, at: info.mtimeMs })
    } catch {
      // 读不到就当没有这一条。
    }
  }
  files.sort((left, right) => right.at - left.at)
  for (const file of files) {
    let payload: unknown
    try {
      payload = JSON.parse(await readFile(file.path, 'utf8')) as unknown
    } catch {
      continue
    }
    const models = parseModels(payload)
    if (models.length === 0) continue
    const endpoint = endpointOf(payload)
    return { models, ...(endpoint === undefined ? {} : { endpoint }) }
  }
  return undefined
}

/**
 * 取一份模型清单：桌面版缓存优先，其次我们自己问站点。
 * @param options - 凭据、端点、缓存目录与 fetch 实现。
 * @returns 清单、端点与出处。
 */
export async function loadCatalog(options: {
  readonly credential: WorkBuddyCredential
  readonly endpoints?: WorkBuddyEndpoints | undefined
  readonly fetchImpl?: typeof fetch | undefined
  readonly desktopDir?: string | undefined
}): Promise<WorkBuddyCatalog> {
  const desktop = await readDesktopCatalog({
    ...(options.desktopDir === undefined ? {} : { dir: options.desktopDir }),
  }).catch(() => undefined)
  if (desktop !== undefined && desktop.models.length > 0) {
    return {
      models: desktop.models,
      ...(desktop.endpoint === undefined ? {} : { endpoint: desktop.endpoint }),
      source: 'desktop',
    }
  }

  const endpoints = options.endpoints ?? resolveEndpoints()
  const fetchImpl = options.fetchImpl ?? fetch
  const token = options.credential.accessToken
  let payload: unknown
  try {
    const response = await fetchImpl(endpoints.configUrl, {
      method: 'GET',
      headers: workBuddyHeaders({
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        [PRODUCT_CONFIGURATION_REQUEST_HEADER]: 'true',
      }),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`WorkBuddy 模型清单取不到（${String(response.status)}）：${scrub(detail.slice(0, 300), token)}`)
    }
    payload = JSON.parse(await response.text()) as unknown
  } catch {
    return { models: [], source: 'none' }
  }
  const models = parseModels(payload)
  if (models.length === 0) return { models: [], source: 'none' }
  const endpoint = endpointOf(payload)
  return {
    models,
    ...(endpoint === undefined ? {} : { endpoint }),
    source: 'cloud',
  }
}

/**
 * 取一次模型清单（只问站点）。
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
    headers: workBuddyHeaders({
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      [PRODUCT_CONFIGURATION_REQUEST_HEADER]: 'true',
    }),
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
