/**
 * External agents presented to the model selector as providers.
 *
 * DSH's model catalog is Host-generation-global by design, and the adapter
 * contract explicitly blesses an adapter that only advertises models
 * ("Adapters used there must advertise their available models; the base empty
 * catalog offers no GUI selection"). So each external agent gets one provider
 * route, and the existing UI — which already renders provider + model — gains
 * those groups with no client change at all.
 *
 * The route is also the routing key: a selection carries the route, which is
 * what lets "pick a model, switch agent" work without a second lookup table.
 */

import type { AcpDialect } from './index.ts'
import type { MiniMaxStreamChunk } from './minimaxi/index.ts'
import type { GlmStreamChunk } from './zcode/index.ts'
import type { OpenAiStreamChunk } from './openai-stream/sse.ts'
import type { PresetConfig } from './registry.ts'
import { baseIdOf } from './selection.ts'
import { GatewayChunkQueue } from './gateway.ts'
import type { GatewayChunk, GatewaySink } from './gateway.ts'
import { collapseEffortModels, collapsedToCatalog, presetOfRoute } from '@goodjin2/dsh-model-kit'
import type { CatalogModel } from '@goodjin2/dsh-model-kit'

// 路由命名、档位折叠、目录模型类型已迁到 @goodjin2/dsh-model-kit；这里继续用它们，
// 并把对外的名字再导出一层，保持本仓既有的引用路径（switch.ts / index.ts / 各 spec）不变。
export { collapseEffortModels, collapsedToCatalog, presetOfRoute, providerRoute } from '@goodjin2/dsh-model-kit'
export type { CatalogModel } from '@goodjin2/dsh-model-kit'

/** What the adapter needs from the outside world. */
export type CatalogDeps = {
  /** The models one preset's agent reports for itself. */
  modelsOf(presetId: string): readonly { readonly id: string; readonly name: string; readonly description?: string }[]
  /**
   * The models one preset's agent reported on its live `session/new` reply, or
   * `undefined` while none has arrived this host generation. Present wins over
   * `modelsOf` — including present-and-empty, which is the agent saying it
   * serves nothing; the configured list must not resurrect over that answer.
   */
  runtimeModelsOf?(presetId: string): readonly { readonly id: string; readonly name: string; readonly description?: string }[] | undefined
  /** The frame dialect of one preset's agent. */
  dialectOf(presetId: string): AcpDialect | undefined
  /**
   * Make sure one preset's model list is in the runtime ledger before the
   * catalog answers.
   *
   * A model plugin can learn its list on its own (it logs in and asks the
   * upstream). The picker asks for the list when the user opens it — which is
   * before anyone sent a message — so the list has to be ready by then, or the
   * user sees the static fallback instead of the real one.
   */
  ensureModels?(presetId: string): Promise<void>
  /**
   * The in-place answerer for sessions this row does not drive. When the
   * adapter is absent, a foreign conversation request can only be refused.
   */
  gateway?: {
    answer(sessionId: string, presetId: string, request: {
      readonly messages: readonly unknown[]
      readonly modelId?: string
      readonly reasoningEffort?: string
      readonly signal?: AbortSignal
      /** The open turn and step when the caller knows them; the gateway
       *  otherwise resolves them from the loop's own announcement. */
      readonly position?: { readonly turn: number; readonly step: number }
    }, sink: GatewaySink): Promise<void>
  }
  /**
   * A preset that is itself a model. Returning a stream answers the request
   * here — tools included — and the native loop keeps the turn. Returning
   * `undefined` leaves the request on the gateway path.
   */
  modelStream?(presetId: string, request: CatalogTurnRequest): AsyncIterable<GlmStreamChunk | MiniMaxStreamChunk | OpenAiStreamChunk> | undefined
}

/** Which preset serves one exact model, if any. */
export function presetForModel(
  config: PresetConfig,
  deps: CatalogDeps,
  route: string,
  modelId: string,
): string | undefined {
  const presetId = presetOfRoute(route)
  if (presetId === undefined) return undefined
  if (config.presets[presetId] === undefined) return undefined
  // Base-to-base: effort publishers declare `base[effort]` while the picker
  // collapses to the base, so a pick that arrives here names the bare base —
  // an exact comparison would call the row's own collapsed pick unserved and
  // the switch chain would die as "the takeover did not happen" before it
  // could plan anything.
  const base = baseIdOf(modelId)
  return (deps.runtimeModelsOf?.(presetId) ?? deps.modelsOf(presetId)).some(model => baseIdOf(model.id) === base)
    ? presetId
    : undefined
}

/**
 * What a native model request carries into `stream`.
 *
 * The loop passes a full generate request. ACP routes only need the fields
 * the gateway already forwarded; a model plugin also needs the tools, the
 * system text, and the output cap, because it is the model.
 */
export type CatalogTurnRequest = {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: unknown
  readonly sessionId?: unknown
  readonly messages?: readonly unknown[]
  readonly purpose?: unknown
  readonly signal?: unknown
  readonly tools?: readonly { readonly name: string; readonly description?: string; readonly parameters?: Record<string, unknown> }[]
  readonly system?: unknown
  readonly maxTokens?: unknown
}

/** Chunks a catalog stream may yield: the gateway's text, or a real model's tool calls. */
export type CatalogStreamChunk = GatewayChunk | GlmStreamChunk | MiniMaxStreamChunk | OpenAiStreamChunk

/**
 * The catalog-facing adapter.
 *
 * ACP agents only advertise models here. Their turns are driven by the
 * replaced step, so `stream` for those routes borrows the agent through the
 * gateway and refuses anything that is not a conversation. A model plugin is
 * the exception: its `stream` is the model call, tool calls included, and the
 * native loop keeps the turn.
 */
export function catalogAdapter(config: PresetConfig, deps: CatalogDeps): CatalogAdapterLike {
  // One source of truth for every catalog-facing answer: the agent's own
  // report once one has landed, the operator's configured list until then.
  // Resolving and routing must read the same list the picker advertised, or a
  // selection can advertise from one list and route against another.
  const modelsFor = (presetId: string): readonly { readonly id: string; readonly name: string; readonly description?: string }[] =>
    deps.runtimeModelsOf?.(presetId) ?? deps.modelsOf(presetId)
  const adapter: CatalogAdapterLike = {
    providerInfo: (provider: string) => {
      const presetId = presetOfRoute(provider) ?? ''
      const agent = config.presets[presetId]?.agent
      return { id: provider, name: (agent === undefined ? undefined : DISPLAY[agent]) ?? presetId }
    },

    listModels: async (provider: string) => {
      const presetId = presetOfRoute(provider)
      if (presetId === undefined) return []
      if (config.presets[presetId] === undefined) return []
      // 先让模型插件把清单备好（它自己登录、自己问上游），再回答。
      await deps.ensureModels?.(presetId)
      const models = modelsFor(presetId)
      // 声明的强度只取 wire 值：各家预设的 effort 名都等于 effortLabelOf(值)，
      // 交给 kit 的 collapsedToCatalog 现算标签，结果与本仓旧实现一字不差。
      const declaredEfforts = config.presets[presetId]?.efforts
      // Collapse same-base entries (one model published as base[low]…base[ultra])
      // into a single row carrying its efforts, so the picker shows the model
      // once and reasoning effort becomes a separate axis rather than N rows.
      // A preset that opts out (cursor, whose ids carry a config suffix rather
      // than an effort) gets one row per id, uncollapsed.
      if (config.presets[presetId]?.collapseEfforts === false) {
        return models.map(model => collapsedToCatalog(provider, {
          baseId: model.id,
          displayName: model.name,
          ...(model.description === undefined ? {} : { description: model.description }),
          efforts: undefined,
        }, declaredEfforts))
      }
      return collapseEffortModels(models).map(model => collapsedToCatalog(provider, model, declaredEfforts))
    },

    // The catalog resolves every advertised model once at build time, and the
    // runtime also resolves ids that never went through the catalog (a session
    // stamped with one before the list changed). An adapter that omits this
    // method takes its whole provider group out of the picker as a failure, so
    // undeclared ids get the runtime's own default answer — identity metadata —
    // rather than a throw.
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
      // The id may be a base the catalog collapsed (the picker selects the base
      // and rides effort separately) or a bare id an older session carries.
      // Resolve it against the collapsed list so metadata and reasoning stay
      // aligned with what the picker advertised.
      const collapsed = presetId === undefined
        ? undefined
        : collapseEffortModels(modelsFor(presetId)).find(entry => entry.baseId === model)
      if (collapsed === undefined) return { provider, id: model, name: model }
      return collapsedToCatalog(provider, collapsed, config.presets[presetId ?? '']?.efforts)
    },

    // An async generator rather than a synchronous throw: the switch hook is
    // async, and the generator's rejection surfaces to the loop as the turn's
    // error — loud, and never a silently empty answer.
    providerRetryPolicy: (): undefined => undefined,
    stream: function stream(options: CatalogTurnRequest): AsyncIterable<CatalogStreamChunk> {
      return (async function* foreignModelRequest(): AsyncIterable<CatalogStreamChunk> {
        const presetId = presetOfRoute(options.provider)
        // A model plugin answers as the model. Background calls (a title, a
        // compaction) are ordinary requests for it, and tool chunks go back
        // to the loop that asked.
        if (presetId !== undefined && deps.modelStream !== undefined) {
          const direct = deps.modelStream(presetId, options)
          if (direct !== undefined) {
            yield* direct
            return
          }
        }
        // Background housekeeping (session titles, compaction) borrows the
        // session's route but is not a conversation turn: prompting the
        // external agent for a title would double-bill and drift the
        // conversation. It refuses by name instead — the title then falls back
        // to the first-prompt text, exactly as it already does for sessions
        // our rows drive (verified against the reference: only these two
        // purposes exist, and the turn's own request never sets one).
        if (typeof options.purpose === 'string' && options.purpose !== '') {
          throw new Error(
            `acp catalog: ${options.provider}/${options.model} does not serve background ${options.purpose} requests — only a conversation turn may reach the external agent`,
          )
        }
        if (presetId === undefined) {
          throw new Error(
            `acp catalog: ${options.provider}/${options.model} never streams on its own — an external turn is either driven by the replaced step or answered in place through the gateway`,
          )
        }
        if (typeof options.sessionId !== 'string' || presetId === undefined || deps.gateway === undefined) {
          // Sessions our rows drive never reach a native model request — the
          // takeover replaces the step — so a request arriving here without a
          // session (or an answerer) has nowhere honest to go.
          throw new Error(
            `acp catalog: ${options.provider}/${options.model} never streams on its own — an external turn is either driven by the replaced step or answered in place through the gateway`,
          )
        }
        // The pick is answered in place: the conversation stays in this
        // session, and the external agent's words arrive as this model's own
        // chunk stream. Nothing moves.
        const queue = new GatewayChunkQueue()
        const messages = Array.isArray(options.messages) ? options.messages : []
        const answering = deps.gateway.answer(options.sessionId, presetId, {
          messages,
          ...(typeof options.model === 'string' ? { modelId: options.model } : {}),
          ...(typeof options.reasoningEffort === 'string' && options.reasoningEffort !== ''
            ? { reasoningEffort: options.reasoningEffort }
            : {}),
          ...(options.signal instanceof AbortSignal ? { signal: options.signal } : {}),
          // 不传 position。GenerateOptions 本就没有轮次步数，硬塞一个 0/0 占位
          // 会让会话日志收下一组永远对不上的编号：界面按事件落在哪两个边界之间
          // 定位，看不出来；而 session-format 的 requireStep 是打开会话时才查的，
          // 那时整份日志已经打不开。网关会自己去问循环报出的那一对。
        }, { chunk: chunk => { queue.push(chunk) } })
        void answering.then(
          () => { queue.close() },
          error => { queue.close(error) },
        )
        yield* queue.iterate()
      })()
    },

    // The loop resolves every native step through `llm.prepareCall()` before
    // the request is admitted (reference agent-loop `prepareRequest`, which
    // tolerates only a missing adapter — not a broken one), and the runtime
    // forwards that to the adapter unconditionally. A class-based adapter
    // inherits a default that composes `resolveModel` + `stream`; the runtime
    // packages cannot be imported here (see `dispatch.ts` for why), so the
    // same composition is stated on the object. Without it, a pick of one of
    // our models in a session that still runs its native step dies as a
    // TypeError before `stream` — and the switch chain behind it — runs.
    prepareCall: async (provider: string, model: string) => ({
      model: await adapter.resolveModel(provider, model),
      stream: (options: Parameters<CatalogAdapterLike['stream']>[0]) => adapter.stream(options),
    }),
  }
  return adapter
}

/** Names shown in the selector for the agents we drive. */
const DISPLAY: Readonly<Record<string, string>> = {
  grok: 'Grok',
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
  qoder: 'Qoder',
  'qoder-global': 'Qoder 国际版',
  zcode: 'ZCode',
  minimaxi: 'MiniMax',
  doubao: '豆包',
}

/** The adapter surface the runtime consumes, stated here so this compiles alone. */
export type CatalogAdapterLike = {
  providerInfo(provider: string): { id: string; name: string }
  listModels(provider: string): Promise<readonly CatalogModel[]>
  /**
   * The runtime resolves exact model metadata through this — once per advertised
   * model while the catalog builds, and for any model id a session carries. An
   * adapter that omits it has every route it owns reported as a catalog
   * failure, which the picker then silently drops.
   */
  resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<CatalogModel>
  /**
   * The loop's per-step preparation entry: the runtime calls this on the
   * adapter for every native step on one of our routes, before the request is
   * admitted or dispatched. The base class a class-based adapter inherits
   * composes `resolveModel` + `stream`; an object adapter states the same
   * composition or the step dies as a TypeError before the switch chain runs.
   */
  prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{
    model: CatalogModel
    stream(options: CatalogTurnRequest): AsyncIterable<CatalogStreamChunk>
  }>
  stream(options: CatalogTurnRequest): AsyncIterable<CatalogStreamChunk>
  /**
   * The runtime asks every registered adapter for this, without checking that
   * it exists — an adapter that omits it takes down every route, not just its
   * own. Undefined means "use the normal defaults", which is what we mean.
   */
  providerRetryPolicy(provider: string): undefined
  /** Same deal: consumed unconditionally, so it has to be present. */
  requestImagePricing?(options: unknown): undefined
}
