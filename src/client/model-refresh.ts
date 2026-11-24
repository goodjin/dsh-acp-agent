/**
 * The refresh button's browser half: call the host route, fold the answer
 * into one line of UI text.
 *
 * Every host answer is HTTP 200 + JSON (see `model-refresh-route.ts`), so
 * the fetch never needs status-code branching — but a network failure or a
 * non-JSON answer must still become an `ok:false` line, never a thrown error
 * the panel would have to defend against. All diagnostics go through
 * `console.warn`/`console.error` (the renderer has no `process.stderr`).
 */

import type { RuntimeT } from './locales.ts'

/** The exact route the refresh buttons POST to (mirrors the host row). */
export const MODEL_REFRESH_ROUTE_PATH = '/acp-agent/models/refresh'

/** What the host answers with (the wire form of ModelRefreshOutcome). */
export type ModelRefreshReply =
  | {
    readonly ok: true
    readonly kind: 'upstream'
    readonly total: number
    readonly added: number
    readonly familyWindow: number
    readonly unverifiedWindow: number
  }
  | { readonly ok: true; readonly kind: 'reread'; readonly hint?: 'codex' }
  | { readonly ok: false; readonly code?: 'busy'; readonly error: string }

/**
 * Ask the host to refresh one provider's model list.
 *
 * Never rejects: every failure — network, non-JSON, unexpected shape — lands
 * in an `ok:false` reply the caller renders as a failure line.
 * @param fetchImpl - the page's fetch (injected for tests).
 * @param presetId - the ACP preset behind the pressed row (`acp:grok` → `grok`).
 */
export async function requestModelRefresh(fetchImpl: typeof fetch, presetId: string): Promise<ModelRefreshReply> {
  let response: Response
  try {
    response = await fetchImpl(MODEL_REFRESH_ROUTE_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ preset: presetId }),
    })
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    return { ok: false, error: `HTTP ${String(response.status)} — the host answered no JSON` }
  }
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: `HTTP ${String(response.status)} — unrecognised answer` }
  }
  const record = body as Record<string, unknown>
  if (record['ok'] === true && record['kind'] === 'upstream') {
    return {
      ok: true,
      kind: 'upstream',
      total: countOf(record['total']),
      added: countOf(record['added']),
      familyWindow: countOf(record['familyWindow']),
      unverifiedWindow: countOf(record['unverifiedWindow']),
    }
  }
  if (record['ok'] === true && record['kind'] === 'reread') {
    return record['hint'] === 'codex' ? { ok: true, kind: 'reread', hint: 'codex' } : { ok: true, kind: 'reread' }
  }
  if (record['ok'] === false) {
    const error = typeof record['error'] === 'string' && record['error'] !== ''
      ? record['error']
      : `HTTP ${String(response.status)}`
    return record['code'] === 'busy' ? { ok: false, code: 'busy', error } : { ok: false, error }
  }
  return { ok: false, error: `HTTP ${String(response.status)} — unrecognised answer` }
}

/**
 * Fold one reply into the line the panel shows under the provider row.
 * @param reply - the host's answer (or a local failure folded into one).
 * @param say - the dictionary; the same seat the rest of the section reads.
 */
export function refreshMessage(reply: ModelRefreshReply, say: RuntimeT): string {
  if (!reply.ok) {
    return reply.code === 'busy'
      ? say('acpVisibility.refresh.busy')
      : say('acpVisibility.refresh.failed', { reason: reply.error })
  }
  if (reply.kind === 'reread') {
    const line = say('acpVisibility.refresh.reread')
    return reply.hint === 'codex' ? `${line} ${say('acpVisibility.refresh.codexHint')}` : line
  }
  const line = say('acpVisibility.refresh.upstream', { total: reply.total, added: reply.added })
  const notes: string[] = []
  if (reply.familyWindow > 0) {
    notes.push(say('acpVisibility.refresh.familyWindow', { count: reply.familyWindow }))
  }
  if (reply.unverifiedWindow > 0) {
    notes.push(say('acpVisibility.refresh.unverified', { count: reply.unverifiedWindow }))
  }
  return notes.length === 0 ? line : `${line} ${notes.join(' ')}`
}

function countOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}
