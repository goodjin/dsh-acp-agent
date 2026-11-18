/**
 * Routing a session's turns to an external ACP agent.
 *
 * The seam is the loop's own `step`. The native loop appends `step/start`
 * before calling it and `step/end` in a finally, with `turn/end` when the turn
 * unwinds, and it decides whether a turn continues from the inbox rather than
 * from what `step` returned. So a replacement step contributes only the
 * model-visible content, and the native loop keeps owning the turn.
 *
 * Why structural types at this boundary: the published `@deepseek-ai/dsh-*`
 * packages are well behind the runtime they load into (0.1.0-rc.6 published vs
 * 0.2.0-rc.2 running), and `ReactLoopAgent` is not importable at all — it is not
 * re-exported from its barrel and the package exposes no `./agent` subpath.
 * Typing against the published declarations would describe a different API than
 * the one actually running, and the class reference does not exist to obtain.
 * So this module states the minimum it reads, and the caller adapts.
 */
/**
 * Whether a session's turns belong to an external agent.
 *
 * An absent preset, or one this plugin does not own, must leave the native
 * agent completely untouched — that is the whole of the "no behaviour change"
 * requirement, and it is why this reads before it writes anything.
 */
export function resolvePreset(agent, presets, presetOf) {
    // Same question, same answer as `presetIdOf`. Two spellings of "which preset is
    // this session on" that can disagree is how a row matches a session and then
    // declines to take it over.
    const id = presetIdOf(agent, presetOf);
    if (id === undefined)
        return undefined;
    return presets.get(id);
}
/**
 * Which preset a session is on, as an id.
 *
 * Split out from `resolvePreset` so a caller that needs to know *which* preset
 * matched — rather than what it can do — asks the same question the same way.
 */
export function presetIdOf(agent, presetOf) {
    // Projection first, header second — and the header is not the stale fallback
    // it looks like. The projection is written when a preset is selected, which
    // happens *after* `agent/created` fires for the sessions it recomposes. At that
    // moment the header is the current answer, not a stale one: the session is
    // being mounted precisely because this preset was selected for it. A resolver
    // alone would therefore claim nothing on a real host and fail silently.
    const fromProjection = presetOf?.(agent);
    const id = fromProjection === undefined || fromProjection === '' ? readHeader(agent) : fromProjection;
    return id === '' ? undefined : id;
}
/**
 * Read the preset out of a projection state value.
 *
 * Verified against `reference/deepseek-harness` @ 5badb15009
 * (`agent-preset-registry/src/session.ts:34-44`): the `agentPreset` projection's
 * state **is** the preset string itself (`string | null`), not an object
 * wrapping it. A reader that only unwraps `state.agentPreset` therefore answers
 * "nothing" on every real host while looking correct in isolation. Both shapes
 * are accepted here so the one question — which preset is this session on —
 * keeps one answer wherever it is asked.
 */
export function presetOfState(state) {
    if (typeof state === 'string')
        return state === '' ? undefined : state;
    const wrapped = (typeof state === 'object' && state !== null ? state : {});
    const nested = wrapped['agentPreset'];
    return typeof nested === 'string' && nested !== '' ? nested : undefined;
}
/**
 * Flat on the header. Reading `header.meta.agentPreset` — as the design document
 * originally had it — yields undefined forever, so dispatch silently falls back
 * to the native agent with no error anywhere.
 *
 * Tolerates an agent whose shape this does not recognise: "not ours" is the
 * safe reading, and throwing would take down a session we were only meant to
 * leave alone.
 */
function readHeader(agent) {
    return agent.session?.header?.agentPreset;
}
/**
 * 判定一个 agent 是否是受委派产生的子会话。
 *
 * 委派落到 DSH 侧后，宿主标准通道起的孩子继承父会话的预设组合，会话头里
 * 记着父会话的预设名——接管判定照样匹配得上。但这样的孩子必须留在 DSH 里跑：
 * 被 ACP 行接管等于把刚起好的孩子再交回外部 agent 驱动，工具又变回外部
 * agent 的，委派就白做了。所以接管路径在 install 之前先问这里。
 *
 * 判据用 delegationDepth，不用 origin。**注意这两条对影子子会话是等价的**：
 * 本行自己造的影子子会话（`entry.ts` 的 openChild）既写 `origin:'subagent'`，也写
 * `delegationDepth = 父+1`，所以「origin 会误伤影子会话」并不是选 delegationDepth 的
 * 理由。影子会话真正被豁免的地方在更早一步：它的会话头没有 agentPreset，
 * `presetIdOf` 直接返回 undefined，本行匹配不上它，根本走不到这里。
 *
 * 选 delegationDepth 是因为它点的正是要排除的那个事实——「这是某个会话的孩子」，
 * 与宿主自己的深度记账（含深度上限）用同一个字段；origin 是粗粒度的来源标签，
 * 回答的是「谁造的」而不是「在血缘的哪一层」。读取按结构逐层守卫，任何一层缺失、
 * 字段缺失或非数都读作「不是」——守卫只负责排除，不抛错：形状不认识的 agent 仍
 * 走原有接管判定。
 */
export function isDelegatedChild(agent) {
    if (typeof agent !== 'object' || agent === null)
        return false;
    const session = agent.session;
    if (typeof session !== 'object' || session === null)
        return false;
    const header = session.header;
    if (typeof header !== 'object' || header === null)
        return false;
    const depth = header.delegationDepth;
    return typeof depth === 'number' && depth > 0;
}
/** Read a `step` implementation off an instance or its prototype chain. */
function readStep(agent) {
    const own = agent.step;
    if (typeof own === 'function')
        return own;
    const inherited = Object.getPrototypeOf(agent)?.step;
    if (typeof inherited === 'function') {
        return inherited;
    }
    return undefined;
}
/** Install `step` as an own property, shadowing the prototype's for this agent alone. */
function writeStep(agent, step) {
    Object.defineProperty(agent, 'step', { value: step, writable: true, configurable: true, enumerable: false });
}
/** Which agent is held by which binding, for the re-announce check and the caller's log silence. */
const held = new WeakMap();
/** Which agent's current turn carries which stop signal, for the runner to listen on. */
const turnAbortSignals = new WeakMap();
/**
 * The loop turn each agent has an external turn open in, when one is in flight.
 *
 * The takeover path iterates one external turn across several replaced-step
 * calls — a segment returning null makes the loop call again — and only the
 * first call of a turn owns the turn-level duties (the model decision, the
 * user's messages on the log). Keyed by turn number rather than a bare
 * "in progress" flag so a turn that never reaches its end cannot leak the
 * state into the next one: a different number reads as a fresh turn, and the
 * duties run again instead of the next turn being mistaken for a continuation
 * and losing its question.
 */
const openSegmentTurnOf = new WeakMap();
/**
 * Record the live turn's stop signal, if this agent's loop has one.
 *
 * `phase` is TypeScript-private on the loop agent and a plain property at
 * runtime (verified against `reference/deepseek-harness` @ 5badb15009,
 * `agent-loop/src/agent.ts:100,391`): the running phase owns a fresh
 * controller per turn, and its signal exists before this step is called — so
 * reading it here is what lets the runner listen *before* the user stops. A
 * capture only at cancel time would always be too late for the very turn
 * being stopped. Anything unreadable records nothing: the runner then simply
 * gets no signal, and behaves as before.
 */
function captureTurnAbort(agent) {
    const signal = agent.phase?.abort?.signal;
    if (signal instanceof AbortSignal)
        turnAbortSignals.set(agent, signal);
}
/** Read a `cancel` implementation off an instance or its prototype chain. */
function readCancel(agent) {
    const own = agent.cancel;
    if (typeof own === 'function')
        return own;
    const inherited = Object.getPrototypeOf(agent)?.cancel;
    if (typeof inherited === 'function') {
        return inherited;
    }
    return undefined;
}
/** Install `cancel` as an own property, shadowing the prototype's for this agent alone. */
function writeCancel(agent, cancel) {
    Object.defineProperty(agent, 'cancel', { value: cancel, writable: true, configurable: true, enumerable: false });
}
/**
 * Install `step` as an own property, shadowing the prototype's for this agent alone.
 *
 * Patches the **instance**, not the prototype: the class is shared by every
 * session, so a prototype patch would change native sessions too. The original
 * is kept and called for anything this plugin does not claim.
 *
 * A preset can also be chosen *after* the agent exists — the interface's preset
 * selector on a blank session rebinds the agent without firing `agent/created`
 * again — so the installed step re-reads the preset on every turn and hands the
 * turn back to the native step once the session no longer names this row.
 *
 * @returns whether the agent was taken over by this binding; `false` also when
 * this exact binding already holds the agent (a preset selected twice
 * re-announces itself — re-wrapping would stack a second takeover).
 */
export function installAcpDispatch(agent, presets, options) {
    const binding = resolvePreset(agent, presets, options.presetOf);
    if (binding === undefined)
        return false;
    if (holdsAcpDispatch(agent, binding))
        return false;
    const original = readStep(agent);
    if (original === undefined) {
        // Loud, because the alternative is a session that silently never answers.
        throw new Error('acp dispatch: this agent has no step to replace');
    }
    // The stop: wrap the instance's `cancel` so every stop records the signal of
    // the turn it stops. An agent without `cancel` gets no abort wiring at all —
    // the runner then runs without the capability, exactly as before.
    const originalCancel = readCancel(agent);
    if (originalCancel !== undefined) {
        writeCancel(agent, function acpCancel(...args) {
            // Recorded before the original runs: the original aborts the signal, and
            // the runner listening on it must already hold it.
            captureTurnAbort(this);
            return originalCancel.apply(this, args);
        });
    }
    const active = new WeakSet();
    writeStep(agent, async function acpStep(decision) {
        // Guard against re-entry: another plugin patching the loop must not be able
        // to make this call itself.
        if (active.has(this))
            return original.call(this, decision);
        // Re-read the preset per turn (see the install comment): the registry's
        // rebind fires no event this module could observe, so a binding captured at
        // install time would keep driving a session that has since left — or, on a
        // host without a projection, hold the stale answer forever.
        const current = resolvePreset(this, presets, options.presetOf);
        if (current === undefined)
            return original.call(this, decision);
        // The loop states where it numbers this step on `agent/pre-step`, before it
        // appends the boundaries. Content written under any other numbers is
        // grouped under a step the view never saw start, and dropped — so without a
        // position the turn refuses rather than writes content nothing will show.
        const position = options.positionOf(this);
        if (position === undefined) {
            throw new Error('acp dispatch: the loop reported no position for this step; refusing to write content the view could not place');
        }
        active.add(this);
        try {
            // The turn's signal exists before this step runs (the loop's running
            // phase owns a fresh controller per turn), so recording it here is what
            // lets the runner listen from the turn's first moment. The cancel
            // wrapper records the same signal again at stop time; both writes are
            // idempotent. Only an agent with a `cancel` to stop through gets the
            // wiring — the same gate the abort option below rides on.
            if (originalCancel !== undefined)
                captureTurnAbort(this);
            // The turn-level duties belong to the turn's first call. The segmented
            // path (a binding with `runSteps`) iterates one external turn across
            // several step calls, and a continuation must not redo them — rewriting
            // the user's messages would put one question on the record twice, and
            // re-asking the model could answer differently mid-turn. A binding
            // without `runSteps` (a test stub, a preset not yet segmented) keeps the
            // single-step behaviour: every call is a whole turn, duties included.
            const steps = current.runSteps;
            const first = steps === undefined || openSegmentTurnOf.get(this) !== position.turn;
            let model = { kind: 'none' };
            if (first) {
                // Decided before anything is written. A refusal still leaves the
                // question on this session's record; a switch must not record it here —
                // the question is asked, with the whole conversation, in the session the
                // switch created, and writing it here too would put one question in two
                // conversations' hands.
                model = (await options.turnModel?.(this, decision)) ?? { kind: 'none' };
                if (model.kind === 'refuse') {
                    // The user's claimed messages go on the log before the turn refuses,
                    // the way the native step commits them — a refusal must still leave
                    // the question on the record.
                    options.write(userEvents(decision));
                    throw new Error(model.reason);
                }
                if (model.kind === 'redirected') {
                    // The switch succeeded, so the turn ends by naming where the
                    // conversation went — a neutral ending, not a thrown error. Throwing
                    // here is what made the client render this turn as a failure even
                    // though the switch had worked; the loop appends whatever ending the
                    // step returns as the turn's `turn/end` reason verbatim.
                    return {
                        kind: 'agent-switch/handover',
                        target: model.target,
                        sessionId: model.sessionId,
                        note: model.note,
                    };
                }
                // The user's claimed messages go on the log before the turn runs, the
                // way the native step commits them — they are the turn's input.
                options.write(userEvents(decision));
            }
            // Built fresh per call: the position is this call's (the loop appends new
            // boundaries before every continuation), the produce closure carries it,
            // and the stream is opened per segment — one external turn spans several
            // step positions and several stream attempts.
            const turn = {
                sessionId: sessionIdOf(this) ?? '',
                position,
                produce: result => options.produce(result, position),
                write: options.write,
                ...(model.kind === 'own'
                    ? { modelId: model.modelId, ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort }) }
                    : {}),
                ...(options.openStream === undefined ? {} : { openStream: options.openStream(this, position) }),
                ...(originalCancel === undefined ? {} : { abort: () => turnAbortSignals.get(this) }),
            };
            if (steps !== undefined) {
                if (first)
                    openSegmentTurnOf.set(this, position.turn);
                try {
                    // Run after the input is committed: the content events describe what
                    // the turn produced, so producing them beforehand would write the
                    // previous turn's remainder. Null means the external turn goes on —
                    // the loop appends the next step's boundaries and calls again; a real
                    // end reason is the turn's last segment.
                    const end = await steps(decision, turn, { first });
                    if (end !== null)
                        openSegmentTurnOf.delete(this);
                    return end;
                }
                catch (error) {
                    // A thrown segment unwinds the turn with it — there is no later
                    // segment to close the state — so clear it the same way an end
                    // reason does, or the next turn would be taken for a continuation.
                    openSegmentTurnOf.delete(this);
                    throw error;
                }
            }
            // The turn owns its own writing, including the stream's closing frame:
            // that frame has to follow the durable append, and the append belongs to
            // this session while the stream belongs to the turn. Splitting them
            // across two places is what left streaming unwired for so long.
            const result = await current.run(decision, turn);
            return result.end;
        }
        finally {
            active.delete(this);
        }
    });
    held.set(agent, binding);
    return true;
}
function messageRecord(message) {
    return typeof message === 'object' && message !== null ? message : {};
}
/** The source a claimed message carries, or nothing for a host message without one. */
function messageSourceKind(message) {
    const source = messageRecord(message)['source'];
    return typeof source === 'object' && source !== null ? source : undefined;
}
/** The claimed messages, as the log's user-message events. */
function userEvents(decision) {
    return decision.messages.map(message => {
        const source = messageSourceKind(message);
        // The host validates the durable message shape when it admits the append,
        // and its readers use `source.kind === 'user'` to tell the human's words
        // from injected context. Normalizing a missing source here would make a
        // compaction checkpoint or runtime note look like a request the user made.
        return {
            type: 'user/message',
            payload: {
                ...messageRecord(message),
                ...(source === undefined ? {} : { source }),
            },
        };
    });
}
/**
 * Whether this exact binding already replaced the agent's step.
 *
 * The scope rebind that moves a blank session between presets fires no
 * `agent/created`, so the only way the same binding sees the same agent twice
 * is a preset selected twice — and each of those repeats the takeover log and
 * stacks a wrapper unless the holder is checked first.
 */
export function holdsAcpDispatch(agent, binding) {
    return held.get(agent) === binding;
}
/** This agent's session id, which the external conversation is keyed by. */
function sessionIdOf(agent) {
    if (typeof agent.id === 'string')
        return agent.id;
    const session = agent.session;
    return typeof session?.id === 'string' ? session.id : undefined;
}
