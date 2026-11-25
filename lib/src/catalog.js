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
import { isModelBackedAgent } from "./model-plugins.js";
import { baseIdOf } from "./selection.js";
import { GatewayChunkQueue } from "./gateway.js";
/**
 * One collapsed base model as the catalog publishes it: base id, base display
 * name, the declared description, and — only when the agent publishes efforts —
 * a `reasoning.efforts` array, which is the signal DSH's picker reads to render
 * the effort as a separate choice instead of one row per effort.
 *
 * Deliberately omits `defaultEffort`: DSH's picker treats an absent default as
 * "show a Provider default row and pre-select nothing" (it synthesizes that row
 * only when `defaultEffort` is undefined), which is the honest first paint — the
 * agent picks its own default until the user chooses an effort. Setting one here
 * would silently pre-select an effort the user never chose.
 */
function collapsedToCatalog(provider, model, declaredEfforts) {
    // 档位来源有两条：模型 id 里归并出来的（codex 那种 `base[effort]`），或者 preset
    // 声明的（claude/grok 的会话级选项、zcode/minimax 这种模型插件）。前者优先——
    // 它带着 wire id，能一字不差拼回去。
    const efforts = model.efforts !== undefined
        ? model.efforts.map(effort => ({ id: effort.id, name: effort.name }))
        : declaredEfforts?.map(effort => ({ id: effort.id, name: effort.name ?? effortLabelOf(effort.id) }));
    return {
        provider,
        id: model.baseId,
        name: model.displayName,
        ...(model.description === undefined ? {} : { description: model.description }),
        ...(efforts === undefined || efforts.length === 0 ? {} : { reasoning: { efforts } }),
        ...(model.contextWindow === undefined ? {} : { context: { contextWindow: model.contextWindow } }),
    };
}
/**
 * 强度的显示名：只写强度本身，不重复模型名。
 *
 * 真机清单里 codex 每一项都叫 `<模型> (low)` 这种，选择器把 effort 当**模型下的一档**
 * 渲染，于是下拉里出现「6.1 Sol (low)」——模型名在上面已经有了，这里再写一遍既长又
 * 分不清档位。按档位名给独立单词：`low` → `Low`、`xhigh` → `xHigh`、`max` → `Max`，
 * 未知后缀首字母大写兜底（不猜语义，也不把它丢掉）。
 * @param effort - `[suffix]` 里的原始写法。
 * @returns 只含强度本身的标签。
 */
export function effortLabelOf(effort) {
    const known = {
        none: 'None',
        off: 'Off',
        minimal: 'Minimal',
        low: 'Low',
        medium: 'Medium',
        high: 'High',
        xhigh: 'xHigh',
        max: 'Max',
        ultra: 'Ultra',
    };
    const normalized = effort.trim().toLowerCase();
    const label = known[normalized];
    if (label !== undefined)
        return label;
    return normalized === '' ? effort : `${normalized.slice(0, 1).toUpperCase()}${normalized.slice(1)}`;
}
/**
 * Split a model id into its base and reasoning-effort suffix.
 *
 * Some agents (codex-acp, confirmed on a live `session/new` 2026-10-12) publish
 * one model per effort as `base[effort]` — six genuinely distinct wire ids, not a
 * display label. Others (claude, grok) publish bare ids with no suffix. This
 * returns the split for a suffixed id and `undefined` effort for a bare one, so
 * the caller can collapse same-base entries without assuming a fixed vocabulary.
 */
function splitEffort(id) {
    const open = id.lastIndexOf('[');
    if (open === -1 || !id.endsWith(']'))
        return undefined;
    const base = id.slice(0, open);
    const effort = id.slice(open + 1, -1);
    if (base === '' || effort === '' || effort.includes(']') || effort.includes('['))
        return undefined;
    return { base, effort };
}
/**
 * Collapse same-base models into one entry and collect their efforts.
 *
 * This is what makes "reasoning effort its own choice" and "no duplicate models"
 * hold at once: a model published as `base[low]`…`base[ultra]` becomes a single
 * `base` entry carrying every effort, so DSH's picker shows the model once and
 * offers the effort as a separate axis (it renders a reasoning sub-control
 * exactly when the model advertises `reasoning.efforts`). A bare-id agent is
 * returned unchanged — no invented efforts, no collapsed rows.
 *
 * The base display name keeps what the agent reported; each effort is labelled by
 * the effort alone（`Low`/`High`…，见 {@link effortLabelOf}），because the picker
 * already shows the model name above the effort control。The base id is the most
 * common spelling among a model's entries (first wins ties),
 * which is stable because a model's entries share one spelling in practice.
 * @param models - The models one preset's agent offers, possibly with `[effort]` suffixes.
 * @returns One entry per base model, in first-seen order, efforts in first-seen order.
 */
export function collapseEffortModels(models) {
    const order = [];
    const byBase = new Map();
    for (const model of models) {
        const split = splitEffort(model.id);
        if (split === undefined) {
            // Bare-id agent (claude, grok): collapse by display name, not wire id.
            // claude publishes five entries (default/opus/fable/sonnet/haiku) that all
            // display as "GLM-5.3"; without name-based dedup the picker shows five
            // identical rows. The first entry's real wire id is kept as baseId so a
            // selection re-attaches to a real id, not the display label.
            const existing = byBase.get(model.name);
            if (existing === undefined) {
                order.push(model.name);
                byBase.set(model.name, { wireId: model.id, displayName: model.name, count: 1, ...(model.description === undefined ? {} : { description: model.description }), ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }), efforts: undefined });
            }
            else {
                existing.count += 1;
                if (existing.description === undefined && model.description !== undefined)
                    existing.description = model.description;
                if (existing.contextWindow === undefined && model.contextWindow !== undefined)
                    existing.contextWindow = model.contextWindow;
            }
            continue;
        }
        const existing = byBase.get(split.base);
        if (existing === undefined) {
            order.push(split.base);
            byBase.set(split.base, { displayName: baseName(model.name, split.effort), ...(model.description === undefined ? {} : { description: model.description }), ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }), count: 1, efforts: [{ id: split.effort, name: effortLabelOf(split.effort), wireId: model.id }] });
            continue;
        }
        existing.count += 1;
        if (existing.description === undefined && model.description !== undefined)
            existing.description = model.description;
        if (existing.contextWindow === undefined && model.contextWindow !== undefined)
            existing.contextWindow = model.contextWindow;
        if (existing.efforts !== undefined && !existing.efforts.some(effort => effort.id === split.effort)) {
            existing.efforts.push({ id: split.effort, name: effortLabelOf(split.effort), wireId: model.id });
        }
    }
    return order.map(base => {
        const entry = byBase.get(base);
        // Bare-id rows carry the real wire id; suffixed rows use the stripped base id.
        return { baseId: entry.wireId ?? base, displayName: entry.displayName, ...(entry.description === undefined ? {} : { description: entry.description }), ...(entry.contextWindow === undefined ? {} : { contextWindow: entry.contextWindow }), efforts: entry.efforts };
    });
}
/**
 * The accumulator entry for one base model, with `description` omitted entirely
 * when the agent reported none — `exactOptionalPropertyTypes` rejects an explicit
 * `undefined` for an optional property, so the field is left off rather than set.
 */
/** Strip a trailing ` (effort)` from a display name, leaving the base model's label. */
function baseName(name, effort) {
    const suffix = `(${effort})`;
    return name.endsWith(suffix) ? name.slice(0, -suffix.length).trim() : name;
}
const ROUTE_PREFIX = 'acp:';
/**
 * The provider route for one preset.
 *
 * Derived from the preset id rather than stored, so it is stable across calls
 * and carries the preset back with it.
 */
export function providerRoute(presetId) {
    return `${ROUTE_PREFIX}${presetId}`;
}
/** The preset a route stands for, or `undefined` for a native route. */
export function presetOfRoute(route) {
    return route.startsWith(ROUTE_PREFIX) ? route.slice(ROUTE_PREFIX.length) : undefined;
}
/** Which preset serves one exact model, if any. */
export function presetForModel(config, deps, route, modelId) {
    const presetId = presetOfRoute(route);
    if (presetId === undefined)
        return undefined;
    if (config.presets[presetId] === undefined)
        return undefined;
    // Base-to-base: effort publishers declare `base[effort]` while the picker
    // collapses to the base, so a pick that arrives here names the bare base —
    // an exact comparison would call the row's own collapsed pick unserved and
    // the switch chain would die as "the takeover did not happen" before it
    // could plan anything.
    const base = baseIdOf(modelId);
    return (deps.runtimeModelsOf?.(presetId) ?? deps.modelsOf(presetId)).some(model => baseIdOf(model.id) === base)
        ? presetId
        : undefined;
}
/** Names shown in the selector for the agents we drive. */
const DISPLAY = {
    grok: 'Grok',
    claude: 'Claude',
    codex: 'Codex',
    cursor: 'Cursor',
    // The `qoder` agent id is the **domestic** build (`qoderclicn`) → "QoderCN".
    // The `acp-qoder-cn` preset row was retired (dsh-qodercn direct-signing row
    // replaced it); the qoder dialect stays registered in this plugin, so this
    // DISPLAY label is kept for the dialect's provider name.
    qoder: 'QoderCN',
    zcode: 'ZCode',
    minimaxi: 'MiniMax',
    doubao: '豆包',
};
/**
 * The catalog-facing adapter.
 *
 * ACP agents only advertise models here. Their turns are driven by the
 * replaced step, so `stream` for those routes borrows the agent through the
 * gateway and refuses anything that is not a conversation. A model plugin is
 * the exception: its `stream` is the model call, tool calls included, and the
 * native loop keeps the turn.
 */
export function catalogAdapter(config, deps) {
    // One source of truth for every catalog-facing answer: the agent's own
    // report once one has landed, the operator's configured list until then.
    // Resolving and routing must read the same list the picker advertised, or a
    // selection can advertise from one list and route against another.
    //
    // Scope note on present-and-empty: for an external agent row an empty
    // report means "this agent serves nothing" — deliberate, the configured
    // list must not resurrect over it. For a model-backed row (zcode/minimaxi,
    // answered in our own loop) an empty report can only be an anomaly, and the
    // host caches the catalog per generation — one empty answer sticks and the
    // picker keeps showing "select a model" (2026-11-17 field report). So a
    // model-backed row falls back to the declared list instead.
    const modelsFor = (presetId) => {
        const runtimeList = deps.runtimeModelsOf?.(presetId);
        if (runtimeList !== undefined && (runtimeList.length > 0 || !isModelBackedAgent(config.presets[presetId]?.agent))) {
            return runtimeList;
        }
        return deps.modelsOf(presetId);
    };
    const adapter = {
        providerInfo: (provider) => {
            const presetId = presetOfRoute(provider) ?? '';
            const agent = config.presets[presetId]?.agent;
            return { id: provider, name: (agent === undefined ? undefined : DISPLAY[agent]) ?? presetId };
        },
        listModels: async (provider) => {
            const presetId = presetOfRoute(provider);
            if (presetId === undefined)
                return [];
            if (config.presets[presetId] === undefined)
                return [];
            // Whole-body guard: any failure on this chain (list preparation, ledger,
            // collapse helpers) degrades to the declared list — a catalog group must
            // never come back empty or failed, because the host filters empty groups
            // and caches the result per generation (2026-11-17 field report: after
            // one failed load the picker kept showing "select a model").
            try {
                // 先让模型插件把清单备好（它自己登录、自己问上游），再回答。
                await deps.ensureModels?.(presetId);
                const models = modelsFor(presetId);
                // Collapse same-base entries (one model published as base[low]…base[ultra])
                // into a single row carrying its efforts, so the picker shows the model
                // once and reasoning effort becomes a separate axis rather than N rows.
                // A preset that opts out (cursor, whose ids carry a config suffix rather
                // than an effort) gets one row per id, uncollapsed.
                const declaredEfforts = config.presets[presetId]?.efforts;
                if (config.presets[presetId]?.collapseEfforts === false) {
                    return models.map(model => collapsedToCatalog(provider, {
                        baseId: model.id,
                        displayName: model.name,
                        ...(model.description === undefined ? {} : { description: model.description }),
                        efforts: undefined,
                    }, declaredEfforts));
                }
                return collapseEffortModels(models).map(model => collapsedToCatalog(provider, model, declaredEfforts));
            }
            catch (error) {
                console.warn(`[catalog] ${presetId} listModels failed, falling back to the declared list:`, error instanceof Error ? error.message : error);
                return deps.modelsOf(presetId).map(model => ({ provider, id: model.id, name: model.name }));
            }
        },
        // The catalog resolves every advertised model once at build time, and the
        // runtime also resolves ids that never went through the catalog (a session
        // stamped with one before the list changed). An adapter that omits this
        // method takes its whole provider group out of the picker as a failure, so
        // undeclared ids get the runtime's own default answer — identity metadata —
        // rather than a throw.
        resolveModel: async (provider, model) => {
            const presetId = presetOfRoute(provider);
            const declared = presetId === undefined
                ? undefined
                : modelsFor(presetId).find(candidate => candidate.id === model);
            if (declared !== undefined) {
                return {
                    provider,
                    id: declared.id,
                    name: declared.name,
                    ...(declared.description === undefined ? {} : { description: declared.description }),
                    ...(declared.contextWindow === undefined ? {} : { context: { contextWindow: declared.contextWindow } }),
                };
            }
            // The id may be a base the catalog collapsed (the picker selects the base
            // and rides effort separately) or a bare id an older session carries.
            // Resolve it against the collapsed list so metadata and reasoning stay
            // aligned with what the picker advertised.
            const collapsed = presetId === undefined
                ? undefined
                : collapseEffortModels(modelsFor(presetId)).find(entry => entry.baseId === model);
            if (collapsed === undefined)
                return { provider, id: model, name: model };
            return collapsedToCatalog(provider, collapsed, config.presets[presetId ?? '']?.efforts);
        },
        // An async generator rather than a synchronous throw: the switch hook is
        // async, and the generator's rejection surfaces to the loop as the turn's
        // error — loud, and never a silently empty answer.
        // The zcode route carries a bounded retry policy: SERVER/TRANSPORT/TIMEOUT/
        // RATE_LIMIT failures retry on a 5s-start exponential backoff, 4 tries max
        // (~90s ceiling). The GLM 500 the field hit ("retry later") lands in this
        // window instead of ending the turn. Other routes keep the host default.
        providerRetryPolicy: (provider) => {
            const presetId = presetOfRoute(provider);
            if (config.presets[presetId ?? '']?.agent !== 'zcode')
                return undefined;
            return {
                mode: 'normal',
                maxRetries: 4,
                retryableCodes: ['SERVER', 'TRANSPORT', 'TIMEOUT', 'RATE_LIMIT'],
                initialDelayMs: 5_000,
                maxDelayMs: 60_000,
                jitterRatio: 0.1,
            };
        },
        stream: function stream(options) {
            return (async function* foreignModelRequest() {
                const presetId = presetOfRoute(options.provider);
                // A model plugin answers as the model. Background calls (a title, a
                // compaction) are ordinary requests for it, and tool chunks go back
                // to the loop that asked.
                if (presetId !== undefined && deps.modelStream !== undefined) {
                    const direct = deps.modelStream(presetId, options);
                    if (direct !== undefined) {
                        yield* direct;
                        return;
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
                    throw new Error(`acp catalog: ${options.provider}/${options.model} does not serve background ${options.purpose} requests — only a conversation turn may reach the external agent`);
                }
                if (presetId === undefined) {
                    throw new Error(`acp catalog: ${options.provider}/${options.model} never streams on its own — an external turn is either driven by the replaced step or answered in place through the gateway`);
                }
                if (typeof options.sessionId !== 'string' || presetId === undefined || deps.gateway === undefined) {
                    // Sessions our rows drive never reach a native model request — the
                    // takeover replaces the step — so a request arriving here without a
                    // session (or an answerer) has nowhere honest to go.
                    throw new Error(`acp catalog: ${options.provider}/${options.model} never streams on its own — an external turn is either driven by the replaced step or answered in place through the gateway`);
                }
                // The pick is answered in place: the conversation stays in this
                // session, and the external agent's words arrive as this model's own
                // chunk stream. Nothing moves.
                const queue = new GatewayChunkQueue();
                const messages = Array.isArray(options.messages) ? options.messages : [];
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
                }, { chunk: chunk => { queue.push(chunk); } });
                void answering.then(() => { queue.close(); }, error => { queue.close(error); });
                yield* queue.iterate();
            })();
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
        prepareCall: async (provider, model) => ({
            model: await adapter.resolveModel(provider, model),
            stream: (options) => adapter.stream(options),
        }),
        // The host asks every registered adapter for two more things, and it does
        // not check whether they exist: the image pricing of a route, while it
        // measures a session's tokens, and the image projection of a route, when a
        // request carries an image. A class-based adapter inherits the host's
        // defaults for those — no pricing declared, the normalized image kept as
        // it is — but the runtime packages cannot be imported here (see
        // `dispatch.ts` for why), so an object adapter has to state them itself.
        // Omitting either one does not cost that one route: the host measures
        // every route it knows, so the TypeError takes down all of them — a model
        // switch died exactly like that on 2026-11-06, before the switch chain
        // behind it could run at all.
        imageRequestPricing: () => undefined,
        imageRequestTarget: (_provider, _model, image) => ({
            width: image.width,
            height: image.height,
            maxBytes: image.bytes,
        }),
    };
    return adapter;
}
