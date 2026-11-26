/**
 * The refresh behind the settings section's "刷新模型列表" buttons.
 *
 * The runtime model ledger (`catalog-registration.ts`) is what the picker and
 * this plugin's settings section both read; a refresh means fetching an
 * upstream list for one preset and recording it there. Each preset row
 * registers its own refresher (`registerModelRefresher`) when it mounts — the
 * ledger is per row, so the route can only reach it through this registry.
 *
 * Per provider, honestly:
 * - **The ACP agents** (grok, qoder, claude, codex, cursor) publish their
 *   model list only on a live `session/new` — none of them keeps a readable
 *   catalogue file. The refresh is a short read-only probe: start the agent
 *   the way a session starts it, initialize, open one session, read the
 *   reply's list with the dialect, reclaim the process, record. Bounded by a
 *   deadline and a per-preset concurrency lock (the lock lives on the route).
 *   A probe that cannot answer says why — not logged in, empty list, timeout
 *   — instead of reporting a fake success.
 * - **zcode** is answered in our own loop, so it never opens a session to
 *   report anything: the refresh asks the coding-plan gateway's
 *   `GET {base}/v1/models` (see `zcode/models.ts`) and merges the answer into
 *   the declared list by id — case-only differences are the same model, and
 *   keep the declared spelling and window.
 * - **Everyone else** (the model plugin rows: minimax, and our own browser
 *   agent) has no upstream fetch of their own; the honest answer is "the
 *   catalog was re-read" — the route's reply says so, and the browser re-reads
 *   the catalog either way.
 *
 * An empty upstream list records nothing: the ledger's own protection keeps a
 * non-empty report from being overwritten by an empty one, and the outcome
 * distinguishes "fetched a list" from "fetched nothing" so the button never
 * reports a fake success.
 */
import { ACP_PROBE_TIMEOUT_MS, AcpProbeError, probeAcpModels } from "./model-probe.js";
import { fetchGlmModels } from "./zcode/index.js";
/**
 * The refreshers of the presets mounted in this process.
 *
 * Module-level because the route is its own loader row: rows share nothing
 * but the module graph, and the ledger a refresher closes over lives in the
 * preset row that created it. Re-mounting a preset row overwrites its entry.
 */
const refreshers = new Map();
/** Register (or replace) one preset's refresher. Called from the preset row. */
export function registerModelRefresher(presetId, refresher) {
    refreshers.set(presetId, refresher);
}
/** One preset's refresher, or `undefined` when no preset row mounted one. */
export function modelRefresherOf(presetId) {
    return refreshers.get(presetId);
}
/** Forget every refresher (tests use this between cases). */
export function clearModelRefreshers() {
    refreshers.clear();
}
/**
 * Where the declared GLM-5 line begins: `glm-5`, `glm-5.4`, `glm-5-turbo`,
 * and the flash/flashx variants — but not `glm-4.6` or `glm-50`.
 * The gateway spells ids lowercase; the test is case-insensitive so a
 * capitalized upstream id still reads as the family.
 */
const GLM_5_FAMILY = /^glm-5(?=$|[.-])/iu;
/**
 * Merge the gateway's list into the declared zcode models.
 *
 * The merged list is what the gateway serves today, spelled the way the
 * declared list spells it:
 * - an upstream id differing from a declared id in case only **is that
 *   declared model** — the declared id, name, description and window stay
 *   (the picker's rows and the compaction capacity keep their stability);
 * - a brand-new glm-5-family model inherits the window another declared
 *   family member carries (they share the capacity the docs state);
 * - any other new model carries no window: nothing verified it, and an
 *   invented number would lie to compaction. The outcome says so.
 * @param declared - the preset's declared models.
 * @param upstream - the gateway's answer.
 */
export function mergeZcodeModels(declared, upstream) {
    const declaredByLower = new Map(declared.map(model => [model.id.toLowerCase(), model]));
    const familyWindow = declared.find(model => GLM_5_FAMILY.test(model.id) && model.contextWindow !== undefined)?.contextWindow;
    const models = [];
    const seen = new Set();
    let added = 0;
    let familyWindowCount = 0;
    let unverifiedWindow = 0;
    for (const item of upstream) {
        const key = item.id.toLowerCase();
        if (seen.has(key))
            continue;
        seen.add(key);
        const known = declaredByLower.get(key);
        if (known !== undefined) {
            // Same model, different spelling: the declared row wins whole.
            models.push({
                id: known.id,
                name: known.name,
                ...(known.description === undefined ? {} : { description: known.description }),
                ...(known.contextWindow === undefined ? {} : { contextWindow: known.contextWindow }),
            });
            continue;
        }
        added += 1;
        if (GLM_5_FAMILY.test(item.id) && familyWindow !== undefined) {
            familyWindowCount += 1;
            models.push({ id: item.id, name: item.name, contextWindow: familyWindow });
            continue;
        }
        unverifiedWindow += 1;
        models.push({ id: item.id, name: item.name });
    }
    return { models, added, familyWindow: familyWindowCount, unverifiedWindow };
}
/** The probe's default deadline: one open must not hold the button forever. */
export const GROK_PROBE_TIMEOUT_MS = ACP_PROBE_TIMEOUT_MS;
/**
 * One short grok probe: start a serve process, open one session, read the
 * model list off the reply, and make sure the process dies on every path.
 *
 * An empty list is an error rather than an empty answer — the caller must be
 * able to tell "the agent served nothing" from "the probe saw nothing", and
 * the ledger would refuse an empty report over a non-empty one anyway.
 *
 * The probe itself is the general one (`model-probe.ts`); grok is the agent
 * that is reached over a WebSocket server it owns.
 * @param options - the command and seams.
 */
export async function probeGrokModels(options) {
    const create = options.createTransport;
    return await probeAcpModels({
        agent: 'grok',
        command: options.command,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(create === undefined ? {} : {
            createTransport: async ({ command, cwd }) => await create({ command, cwd }),
        }),
    });
}
/**
 * The agents whose model list can be read by asking the agent itself.
 *
 * grok is not in here: it has its own probe entry (a WebSocket server the
 * probe owns). (The old doubao browser agent was removed; nothing here reads
 * a one-item list by opening a browser window.)
 */
const PROBED_AGENTS = new Set(['qoder', 'claude', 'codex', 'cursor']);
/**
 * Run one preset's refresh, per its agent kind.
 *
 * This is the body every registered refresher shares: fetch per kind, record,
 * and fold the result into the outcome the route replies with. Failures
 * propagate — the route turns them into `ok:false` answers — and a fetch that
 * produced nothing records nothing.
 * @param request - the preset's identity, lists and record seam.
 */
export async function refreshPresetModels(request) {
    const agent = request.agent ?? '';
    if (agent === 'grok') {
        const probe = request.deps?.probeGrok ?? probeGrokModels;
        const models = await probe({ command: request.command ?? 'grok' });
        return recordUpstream(request, agent, models);
    }
    if (agent === 'zcode') {
        const fetchModels = request.deps?.fetchZcode ?? fetchGlmModels;
        const upstream = await fetchModels({});
        const merged = mergeZcodeModels(request.declared, upstream);
        request.record(merged.models);
        return {
            ok: true,
            kind: 'upstream',
            agent,
            total: merged.models.length,
            added: merged.added,
            familyWindow: merged.familyWindow,
            unverifiedWindow: merged.unverifiedWindow,
        };
    }
    if (PROBED_AGENTS.has(agent) && request.command !== undefined) {
        const probe = request.deps?.probeAcp ?? probeAcpModels;
        let models;
        try {
            models = await probe({
                agent,
                command: request.command,
                ...(request.args === undefined ? {} : { args: request.args }),
            });
        }
        catch (error) {
            // A probe failure that knows why is told why: the reason code and the
            // login command travel with the answer, so the browser can say "run
            // qoderclicn login" instead of "it did not work". Everything else keeps
            // travelling up as an error.
            if (!(error instanceof AcpProbeError))
                throw error;
            return {
                ok: false,
                reason: error.reason,
                ...(error.login === undefined ? {} : { login: error.login }),
                error: error.message,
            };
        }
        return recordUpstream(request, agent, models);
    }
    // No upstream fetch of its own: the catalog re-read happens browser-side
    // after any refresh, which is the whole truth for these rows.
    return { ok: true, kind: 'reread', agent };
}
/**
 * Record a list the agent published, and say what changed.
 *
 * The ledger joins the declared windows by exact id at record time, so a model
 * the agent added after startup arrives without a window: say so, instead of
 * counting every row unverified.
 * @param request - the preset's declared list and the record seam.
 * @param agent - the agent kind, for the outcome.
 * @param models - the list the agent published.
 */
function recordUpstream(request, agent, models) {
    request.record(models);
    const declaredWindows = new Set(request.declared
        .filter(model => model.contextWindow !== undefined)
        .map(model => model.id));
    const unverifiedWindow = models.filter(model => !declaredWindows.has(model.id)).length;
    const previousIds = new Set((request.previous ?? request.declared).map(model => model.id.toLowerCase()));
    const added = models.filter(model => !previousIds.has(model.id.toLowerCase())).length;
    return { ok: true, kind: 'upstream', agent, total: models.length, added, familyWindow: 0, unverifiedWindow };
}
