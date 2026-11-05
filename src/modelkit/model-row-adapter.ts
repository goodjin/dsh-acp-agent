/**
 * 模型行的目录适配器。
 *
 * 一条模型行向宿主目录宣告：它是谁（providerInfo）、它有哪些模型（listModels）、
 * 某个 id 的元数据是什么（resolveModel）、以及一次请求怎么跑（stream/prepareCall）。
 * 这一支只做「模型」——请求由它自己应答，工具调用也一并交回原生循环。外部 ACP
 * 行的调度/网关/审批不在这里，那是各插件自己的事。
 */

import type { CatalogModel, ModelStreamChunk, ModelTurnRequest } from './types.ts'
import { collapsedToCatalog, collapseEffortModels, type DeclaredEffort } from './efforts.ts'
import { presetOfRoute } from './provider-route.ts'
import type { ReportedModel } from './runtime-models.ts'

/** 造一个模型行适配器需要的输入。 */
export type ModelRowAdapterOptions = {
  /** 这一行的 id。 */
  readonly presetId: string
  /** 选择器里这一组显示的名字。 */
  readonly displayName: string
  /** 挂载行里声明的那份模型清单。 */
  readonly declaredModels: readonly { readonly id: string; readonly name: string; readonly description?: string }[]
  /** 运行时（各家自报）的清单，到了就优先于声明那份。 */
  readonly runtimeModelsOf?: ((presetId: string) => readonly ReportedModel[] | undefined) | undefined
  /** 回答目录之前先把这一行的清单备好（自己登录、自己问上游）。 */
  readonly ensureModels?: ((presetId: string) => Promise<void>) | undefined
  /** 一次模型请求怎么跑：返回流就在这里应答（工具包含），返回 undefined 就交回宿主。 */
  readonly modelStream?: ((presetId: string, request: ModelTurnRequest) => AsyncIterable<ModelStreamChunk> | undefined) | undefined
  /** 是否把 `base[effort]` 折成一条（WorkBuddy 的行 id 不带强度后缀，关掉）。 */
  readonly collapseEfforts?: boolean | undefined
  /** 行声明的强度，在折叠不到强度时兜底；可带自定义显示名。 */
  readonly efforts?: readonly DeclaredEffort[] | undefined
}

/** 宿主运行时消费的适配器面。 */
export type ModelRowAdapterLike = {
  providerInfo(provider: string): { id: string; name: string }
  listModels(provider: string): Promise<readonly CatalogModel[]>
  resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<CatalogModel>
  prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{ model: CatalogModel; stream(options: ModelTurnRequest): AsyncIterable<ModelStreamChunk> }>
  stream(options: ModelTurnRequest): AsyncIterable<ModelStreamChunk>
  providerRetryPolicy(provider: string): undefined
}

/**
 * 造一个模型行适配器。
 * @param options - 见 {@link ModelRowAdapterOptions}。
 * @returns 宿主运行时消费的适配器。
 */
export function modelRowAdapter(options: ModelRowAdapterOptions): ModelRowAdapterLike {
  const deps = options
  // 单一真相：一家一旦有运行时清单就用它，没有再用操作员配置的那份。
  // 解析与路由必须读同一份选择器宣告的清单，否则会一边宣告、一边按另一份路由。
  const modelsFor = (presetId: string): readonly { id: string; name: string; description?: string }[] =>
    deps.runtimeModelsOf?.(presetId) ?? deps.declaredModels

  const adapter: ModelRowAdapterLike = {
    providerInfo: (provider: string) => ({ id: provider, name: deps.displayName }),

    listModels: async (provider: string) => {
      const presetId = presetOfRoute(provider)
      if (presetId === undefined) return []
      // 先让这一行把清单备好（它自己登录、自己问上游），再回答。
      await deps.ensureModels?.(presetId)
      const models = modelsFor(presetId)
      const declaredEfforts = deps.efforts
      // 折叠开关关上的行（id 不带强度后缀的那种）拿到一行一条；开着的把同 base 的
      // 强度并成一条，让选择器只显示模型一次、强度单独成轴。
      if (deps.collapseEfforts === false) {
        return models.map(model => collapsedToCatalog(provider, {
          baseId: model.id,
          displayName: model.name,
          ...(model.description === undefined ? {} : { description: model.description }),
          efforts: undefined,
        }, declaredEfforts))
      }
      return collapseEffortModels(models).map(model => collapsedToCatalog(provider, model, declaredEfforts))
    },

    // 运行时给每个宣告过的模型在构建时解析一次，也给会话里出现过的、从没进过目录的
    // id 解析一次。省掉这个方法，它名下的每条路由都会被整组当成目录失败、被选择器悄悄
    // 丢掉。未声明的 id 拿到的是运行时的默认答案（身份元数据），而不是抛错。
    resolveModel: async (provider: string, model: string): Promise<CatalogModel> => {
      const presetId = presetOfRoute(provider)
      const declared = presetId === undefined
        ? undefined
        : modelsFor(presetId).find(candidate => candidate.id === model)
      if (declared !== undefined) {
        return {
          provider,
          id: declared.id,
          name: declared.name,
          ...(declared.description === undefined ? {} : { description: declared.description }),
        }
      }
      // 这个 id 可能是被折叠的 base（选择器选 base、强度单独走），也可能是老会话带着的
      // 裸 id。按折叠后的清单解析，让元数据与强度跟选择器宣告的一致。
      const collapsed = presetId === undefined
        ? undefined
        : collapseEffortModels(modelsFor(presetId)).find(entry => entry.baseId === model)
      if (collapsed === undefined) return { provider, id: model, name: model }
      return collapsedToCatalog(provider, collapsed, deps.efforts)
    },

    // 原生循环每步都先过 llm.prepareCall() 才放行请求；运行时把这个无条件转给适配器。
    // 省掉它，会话里选了我们的模型、却还跑原生步的那一步会在进 stream 之前就 TypeError。
    prepareCall: async (provider: string, model: string) => ({
      model: await adapter.resolveModel(provider, model),
      stream: (options: ModelTurnRequest) => adapter.stream(options),
    }),

    // 模型行作为模型应答：请求就在这里跑，工具调用也一并回到问它的循环。宿主把一次
    // 完整生成请求交给这里——它需要工具、系统文本、输出上限，因为它就是模型。
    stream: function stream(options: ModelTurnRequest): AsyncIterable<ModelStreamChunk> {
      return (async function* modelRequest(): AsyncIterable<ModelStreamChunk> {
        const presetId = presetOfRoute(options.provider)
        if (presetId === undefined) {
          throw new Error(
            `model-kit: ${options.provider}/${options.model} 不是模型行路由，无法自行流式`,
          )
        }
        if (deps.modelStream === undefined) {
          throw new Error(
            `model-kit: ${options.provider}/${options.model} 没有配 modelStream，模型行无法应答`,
          )
        }
        const direct = deps.modelStream(presetId, options)
        if (direct === undefined) {
          throw new Error(
            `model-kit: ${options.provider}/${options.model} 的 modelStream 未应答这次请求`,
          )
        }
        yield* direct
      })()
    },

    // 运行时不检查它是否存在就要这个——省了它，整组路由一起遭殃。undefined 即「用
    // 正常默认值」。
    providerRetryPolicy: (): undefined => undefined,
  }
  return adapter
}
