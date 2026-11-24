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
 * - **grok** reports its model list only on a live `session/new` (CLI 1.0.92
 *   keeps no local cache file). The refresh is a short probe: start one
 *   `agent serve` process, initialize, open a session, read the reply's list
 *   with the dialect, kill the process, record. Bounded by a deadline and a
 *   per-preset concurrency lock (the lock lives on the route).
 * - **zcode** is answered in our own loop, so it never opens a session to
 *   report anything: the refresh asks the coding-plan gateway's
 *   `GET {base}/v1/models` (see `zcode/models.ts`) and merges the answer into
 *   the declared list by id — case-only differences are the same model, and
 *   keep the declared spelling and window.
 * - **Everyone else** has no upstream fetch of their own yet; the honest
 *   answer is "the catalog was re-read" — the route's reply says so, and the
 *   browser re-reads the catalog either way. codex's upstream refresh belongs
 *   to the dsh-codex plugin; the reply carries a hint pointing there.
 *
 * An empty upstream list records nothing: the ledger's own protection keeps a
 * non-empty report from being overwritten by an empty one, and the outcome
 * distinguishes "fetched a list" from "fetched nothing" so the button never
 * reports a fake success.
 */

import { homedir } from 'node:os'
import { AcpClient } from './client.ts'
import type { ReportedModel } from './catalog-registration.ts'
import { grokDialect } from './dialects/grok.ts'
import type { AcpTransport } from './transport.ts'
import { GrokServeTransport } from './transport.ts'
import { fetchGlmModels } from './zcode/index.ts'
import type { GlmModelListItem } from './zcode/index.ts'

/** What one refresh answers with — the shape the route replies to the browser. */
export type ModelRefreshOutcome =
  | {
    readonly ok: true
    readonly kind: 'upstream'
    /** Which agent kind ran (`grok`, `zcode`, …). */
    readonly agent: string
    /** Models the preset's ledger now serves. */
    readonly total: number
    /** Ids that were not in the list before (case-insensitive compare). */
    readonly added: number
    /** New models whose window follows the declared family value (zcode). */
    readonly familyWindow: number
    /** Models without a verified context window. */
    readonly unverifiedWindow: number
  }
  | { readonly ok: true; readonly kind: 'reread'; readonly agent: string }
  | { readonly ok: false; readonly code?: 'busy'; readonly error: string }

/** The per-preset refresh entry the route dispatches to. */
export type ModelRefresher = () => Promise<ModelRefreshOutcome>

/**
 * The refreshers of the presets mounted in this process.
 *
 * Module-level because the route is its own loader row: rows share nothing
 * but the module graph, and the ledger a refresher closes over lives in the
 * preset row that created it. Re-mounting a preset row overwrites its entry.
 */
const refreshers = new Map<string, ModelRefresher>()

/** Register (or replace) one preset's refresher. Called from the preset row. */
export function registerModelRefresher(presetId: string, refresher: ModelRefresher): void {
  refreshers.set(presetId, refresher)
}

/** One preset's refresher, or `undefined` when no preset row mounted one. */
export function modelRefresherOf(presetId: string): ModelRefresher | undefined {
  return refreshers.get(presetId)
}

/** Forget every refresher (tests use this between cases). */
export function clearModelRefreshers(): void {
  refreshers.clear()
}

/**
 * Where the declared GLM-5 line begins: `glm-5`, `glm-5.4`, `glm-5-turbo`,
 * and the flash/flashx variants — but not `glm-4.6` or `glm-50`.
 * The gateway spells ids lowercase; the test is case-insensitive so a
 * capitalized upstream id still reads as the family.
 */
const GLM_5_FAMILY = /^glm-5(?=$|[.-])/iu

/** What merging an upstream list into the declared one produced. */
export type ZcodeMergeResult = {
  /** The list to record, in the gateway's order. */
  readonly models: readonly ReportedModel[]
  /** Ids that were not in the declared list before. */
  readonly added: number
  /** New models whose window follows the declared glm-5 family value. */
  readonly familyWindow: number
  /** New models with no window to inherit — unverified capacity. */
  readonly unverifiedWindow: number
}

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
export function mergeZcodeModels(
  declared: readonly ReportedModel[],
  upstream: readonly GlmModelListItem[],
): ZcodeMergeResult {
  const declaredByLower = new Map(declared.map(model => [model.id.toLowerCase(), model]))
  const familyWindow = declared.find(model => GLM_5_FAMILY.test(model.id) && model.contextWindow !== undefined)?.contextWindow
  const models: ReportedModel[] = []
  const seen = new Set<string>()
  let added = 0
  let familyWindowCount = 0
  let unverifiedWindow = 0
  for (const item of upstream) {
    const key = item.id.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const known = declaredByLower.get(key)
    if (known !== undefined) {
      // Same model, different spelling: the declared row wins whole.
      models.push({
        id: known.id,
        name: known.name,
        ...(known.description === undefined ? {} : { description: known.description }),
        ...(known.contextWindow === undefined ? {} : { contextWindow: known.contextWindow }),
      })
      continue
    }
    added += 1
    if (GLM_5_FAMILY.test(item.id) && familyWindow !== undefined) {
      familyWindowCount += 1
      models.push({ id: item.id, name: item.name, contextWindow: familyWindow })
      continue
    }
    unverifiedWindow += 1
    models.push({ id: item.id, name: item.name })
  }
  return { models, added, familyWindow: familyWindowCount, unverifiedWindow }
}

/** The grok probe's seams: command, neutral working directory, deadline. */
export type GrokProbeOptions = {
  /** The grok binary, as the preset declares it. */
  readonly command: string
  /** Spawn and `session/new` working directory; defaults to the home dir —
   *  a probe has no workspace of its own, and the directory must be one the
   *  process may write its session journal into. */
  readonly cwd?: string
  /** Whole-probe deadline; the serve process is killed when it fires. */
  readonly timeoutMs?: number
  /** Test seam: build the transport instead of spawning a real serve. */
  readonly createTransport?: (options: { command: string; cwd: string }) => Promise<AcpTransport>
}

/** The probe's default deadline: one open must not hold the button forever. */
export const GROK_PROBE_TIMEOUT_MS = 60_000

/**
 * One short grok probe: start a serve process, open one session, read the
 * model list off the reply, and make sure the process dies on every path.
 *
 * An empty list is an error rather than an empty answer — the caller must be
 * able to tell "the agent served nothing" from "the probe saw nothing", and
 * the ledger would refuse an empty report over a non-empty one anyway.
 * @param options - the command and seams.
 */
export async function probeGrokModels(options: GrokProbeOptions): Promise<readonly ReportedModel[]> {
  const cwd = options.cwd ?? homedir()
  const transport = await (options.createTransport !== undefined
    ? options.createTransport({ command: options.command, cwd })
    : GrokServeTransport.create({ command: options.command, cwd }))
  try {
    const ms = options.timeoutMs ?? GROK_PROBE_TIMEOUT_MS
    return await withDeadline(readModelsOver(transport, cwd), ms, () => `grok model probe did not answer within ${String(ms)}ms`)
  } finally {
    transport.close()
  }
}

/** The handshake-and-read half of the probe, over a ready transport. */
async function readModelsOver(transport: AcpTransport, cwd: string): Promise<readonly ReportedModel[]> {
  const client = new AcpClient(transport, grokDialect)
  await client.request('initialize', {
    protocolVersion: 1,
    // The picker probe reads one reply; the capabilities grok's real sessions
    // declare (subagent drafts, terminal output deltas) change nothing here.
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
  })
  client.notify('initialized', {})
  const reply = await client.request('session/new', { cwd, mcpServers: [] })
  const models = grokDialect.readModels(reply)
  if (models.length === 0) {
    throw new Error('the grok agent reported no models on session/new')
  }
  return models
}

/** Bound a promise; the loser's late rejection is silenced, not dropped. */
function withDeadline<T>(work: Promise<T>, ms: number, message: () => string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  // The race resolves on the deadline, but the work may still reject later
  // (the transport close below fails its in-flight requests). The host treats
  // an unhandled rejection as fatal, so the loser's rejection needs a taker —
  // the race above is the one that matters.
  work.catch(() => {})
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => { reject(new Error(message())) }, ms)
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

/** What one preset's refresh needs — everything comes from the mounting row. */
export type RefreshRequest = {
  readonly presetId: string
  /** The preset's agent kind (`grok`, `zcode`, …); anything else re-reads. */
  readonly agent?: string
  /** The preset's declared models, for merging and comparison. */
  readonly declared: readonly ReportedModel[]
  /** The ledger's current report, when one exists. */
  readonly previous: readonly ReportedModel[] | undefined
  /** Write the refreshed list into the preset's ledger. */
  readonly record: (models: readonly ReportedModel[]) => void
  /** The command the preset spawns (grok probe). */
  readonly command?: string
  /** Test seams: swap the probe and the fetch so nothing real runs. */
  readonly deps?: {
    readonly probeGrok?: typeof probeGrokModels
    readonly fetchZcode?: typeof fetchGlmModels
  }
}

/**
 * Run one preset's refresh, per its agent kind.
 *
 * This is the body every registered refresher shares: fetch per kind, record,
 * and fold the result into the outcome the route replies with. Failures
 * propagate — the route turns them into `ok:false` answers — and a fetch that
 * produced nothing records nothing.
 * @param request - the preset's identity, lists and record seam.
 */
export async function refreshPresetModels(request: RefreshRequest): Promise<ModelRefreshOutcome> {
  const agent = request.agent ?? ''
  if (agent === 'grok') {
    const probe = request.deps?.probeGrok ?? probeGrokModels
    const models = await probe({ command: request.command ?? 'grok' })
    request.record(models)
    // The ledger joins the declared windows by exact id at record time, so a
    // model the agent added after startup arrives without a window: say so,
    // instead of counting every row unverified.
    const declaredWindows = new Set(request.declared
      .filter(model => model.contextWindow !== undefined)
      .map(model => model.id))
    const unverifiedWindow = models.filter(model => !declaredWindows.has(model.id)).length
    const previousIds = new Set((request.previous ?? request.declared).map(model => model.id.toLowerCase()))
    const added = models.filter(model => !previousIds.has(model.id.toLowerCase())).length
    return { ok: true, kind: 'upstream', agent, total: models.length, added, familyWindow: 0, unverifiedWindow }
  }
  if (agent === 'zcode') {
    const fetchModels = request.deps?.fetchZcode ?? fetchGlmModels
    const upstream = await fetchModels({})
    const merged = mergeZcodeModels(request.declared, upstream)
    request.record(merged.models)
    return {
      ok: true,
      kind: 'upstream',
      agent,
      total: merged.models.length,
      added: merged.added,
      familyWindow: merged.familyWindow,
      unverifiedWindow: merged.unverifiedWindow,
    }
  }
  // No upstream fetch of its own: the catalog re-read happens browser-side
  // after any refresh, which is the whole truth for these rows.
  return { ok: true, kind: 'reread', agent }
}
