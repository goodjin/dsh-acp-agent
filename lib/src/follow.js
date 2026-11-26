/**
 * The preset ↔ model linkage, as the takeover can actually perform it.
 *
 * DSH's own composition keeps a session's preset and its model independent:
 * the preset adds capabilities, the model chooses the route, and neither
 * constrains the other (verified against `reference/deepseek-harness` @
 * 5badb15009, `api/session-controller/src/agent.ts` — `composeAgent` applies
 * the preset, `installSelection` applies the model, and neither reads the
 * other). The takeover replaces the step, so no model request ever fires and
 * nothing in the host reacts to the picker. Left alone, the two picks would
 * collide: the preset's agent answers under a model name it does not serve.
 * The honest equivalent of the native independence is that the two picks
 * follow each other:
 *
 * - **preset → model.** When a preset takes a session (created on it, or
 *   selected onto it), any pending model it cannot serve is replaced by the
 *   preset's first model, so the composer's chip agrees with what will answer.
 *   A pending model the preset does serve is the user's own pick and stays.
 * - **model → preset.** When a blank session picks another preset's model,
 *   the session selects that preset in place. A started session cannot move:
 *   its preset is locked, and — verified in the reference source, correcting
 *   an earlier guess — a fork replays the lock too, because the copy's event
 *   prefix includes the source's turn boundaries and the lock check folds
 *   `turn/start` events. So nothing moves here; the pick is answered in place
 *   at the session's next turn by the gateway (`gateway.ts`), which borrows
 *   the agent as a model and streams its answer into the session's own turn.
 *
 * Both writes are events this row itself hears back; each rule treats its own
 * writes as no-ops, so the loop closes instead of feeding itself.
 */
import { presetOfState } from "./dispatch.js";
import { baseIdOf, pendingSelectionOf, selectionOf } from "./model-selection.js";
import { servicesOf, startedOf } from "./switch-mount.js";
/**
 * The pure half of preset → model: given what the picker has pending, what
 * should the freshly taken-over session's model chip say?
 */
export function decidePresetFollow(config, pending) {
    // Base-to-base, same as everywhere a pick meets a declared list: the
    // picker's collapsed base pick is the user's own choice of this preset's
    // model, not a pick to overwrite with the first suffixed id.
    if (pending !== undefined
        && pending.provider === `acp:${config.presetId}`
        && config.models.some(model => baseIdOf(model.id) === baseIdOf(pending.model))) {
        return { kind: 'keep' };
    }
    const first = config.models[0];
    if (first === undefined)
        return { kind: 'keep' };
    return { kind: 'write', modelId: first.id };
}
/**
 * The pure half of model → preset: this row heard a session pick a model;
 * what should move?
 *
 * `started` says the session has produced a turn. The host only lets a blank
 * session take a preset, and a fork of a started session replays the same
 * lock — the fork's copied prefix includes `turn/start` events, and the lock
 * check folds them (verified in the reference source, correcting an earlier
 * "the fork is fresh" assumption). Planning a fork here anyway would strand an
 * empty copy of the conversation beside a refused pick, so a started session
 * reports `locked` instead of moving.
 */
export function decideModelFollow(config, selection, currentPreset, started = false) {
    if (currentPreset !== config.presetId)
        return { kind: 'none' };
    if (selection.provider === `acp:${config.presetId}`)
        return { kind: 'none' };
    if (!selection.provider.startsWith('acp:'))
        return { kind: 'none' };
    const target = selection.provider.slice('acp:'.length);
    return started ? { kind: 'locked', target } : { kind: 'switch', target };
}
/**
 * Perform preset → model on a session this preset just took over.
 *
 * Called after a fresh install. Skips without writing when the host composes
 * no projections (the blank check cannot be made), when the session has
 * already started, or when the preset declares no models — every one of those
 * leaves the turn on the preset's configured default, which is the behaviour
 * the host default already produces.
 */
export async function followPresetSelection(services, presetId, models, sessionId, agent, report) {
    if (models.length === 0)
        return;
    const stateOf = services.projections;
    if (stateOf === undefined || agent.session === undefined)
        return;
    if (startedOf(stateOf(agent.session, 'turnBoundary')))
        return;
    const pending = pendingSelectionOf(stateOf(agent.session, 'modelSelection'));
    const decision = decidePresetFollow({ presetId, models }, pending);
    if (decision.kind !== 'write')
        return;
    const append = appendOf(agent);
    if (append === undefined) {
        report(`acp ${presetId}: session ${sessionId} has no session log to record a model selection on; leaving the picker as it is`);
        return;
    }
    append('model/selection', { provider: `acp:${presetId}`, model: decision.modelId });
    const because = pending === undefined ? 'nothing was pending' : `replaced ${pending.provider}/${pending.model}, which this preset does not serve`;
    report(`acp ${presetId}: session ${sessionId} selected ${decision.modelId} (${because}) — this preset's first model`);
}
/**
 * Perform model → preset on a session this row drives.
 *
 * The target preset's presence on this host is checked against the host's own
 * preset registry before anything moves — a preset that is not mounted here is
 * exactly the case the refusal exists for, and it must be said rather than
 * thrown away as a generic failure.
 */
export async function followModelSelection(services, presetId, selection, sessionId, agent, report) {
    const stateOf = services.projections;
    if (stateOf === undefined || agent.session === undefined) {
        report(`acp ${presetId}: session ${sessionId} picked ${selection.provider}/${selection.model} but this host exposes no session projections — the follow cannot tell whether the session is still on this preset`);
        return;
    }
    const currentPreset = presetOfState(stateOf(agent.session, 'agentPreset'));
    const started = startedOf(stateOf(agent.session, 'turnBoundary'));
    const decision = decideModelFollow({ presetId }, selection, currentPreset, started);
    if (decision.kind === 'none')
        return;
    if (decision.kind === 'locked') {
        report(`acp ${presetId}: session ${sessionId} picked ${selection.provider}/${selection.model} (preset ${decision.target}) but the session has started and its preset stays — the pick will be answered in place by that agent at the session's next turn`);
        return;
    }
    const target = decision.target;
    const missing = [
        ...(services.agents === undefined ? ['agents'] : []),
        ...(services.presets === undefined ? ['agentPresets'] : []),
    ];
    if (missing.length > 0) {
        report(`acp ${presetId}: session ${sessionId} picked ${selection.provider}/${selection.model} (preset ${target}) but this host does not expose: ${missing.join(', ')} — the follow did not happen`);
        return;
    }
    const presets = services.presets;
    const agents = services.agents;
    const mounted = await mountedPresetsOf(services.presetList);
    if (mounted !== undefined && !mounted.includes(target)) {
        report(`acp ${presetId}: session ${sessionId} picked ${selection.provider}/${selection.model}, but preset ${target} is not on this host — the pick stays refused at turn time`);
        return;
    }
    try {
        await presets(agents(sessionId), target);
    }
    catch (error) {
        report(`acp ${presetId}: session ${sessionId} could not follow ${selection.provider}/${selection.model} to preset ${target}: ${messageOf(error)}`);
        return;
    }
    report(`acp ${presetId}: session ${sessionId} followed the model pick ${selection.provider}/${selection.model} — preset switched to ${target} in place`);
}
/**
 * The preset ids this host has mounted, via the registry's own `list`.
 *
 * `undefined` means the registry offers no list — the follow then relies on
 * `select` failing loudly instead, which it does (`agent-preset/not-found`).
 */
async function mountedPresetsOf(presetList) {
    if (presetList === undefined)
        return undefined;
    try {
        const rows = await presetList();
        if (!Array.isArray(rows))
            return undefined;
        return rows
            .map(row => (typeof row === 'object' && row !== null ? row.id : undefined))
            .filter((id) => typeof id === 'string');
    }
    catch {
        return undefined;
    }
}
/** The session log's append, if this agent has one. */
function appendOf(agent) {
    const session = agent.session;
    if (typeof session?.append !== 'function')
        return undefined;
    return (type, data) => session.append.call(session, type, data);
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
/** Re-exported for the entry's wiring; kept next to its only consumers. */
export { pendingSelectionOf, selectionOf };
