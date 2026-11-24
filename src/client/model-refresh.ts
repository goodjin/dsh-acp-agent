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
  | {
    readonly ok: false
    /** `busy` — wait for the running refresh; `not-ours` — another plugin
     *  mounted this provider, and `hint` names where its refresh lives. */
    readonly code?: 'busy' | 'not-ours'
    readonly hint?: 'codex' | 'qoder'
    readonly error: string
  }

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
    const code = record['code'] === 'busy' || record['code'] === 'not-ours' ? record['code'] : undefined
    const hint = record['hint'] === 'codex' || record['hint'] === 'qoder' ? record['hint'] : undefined
    return { ok: false, ...(code === undefined ? {} : { code }), ...(hint === undefined ? {} : { hint }), error }
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
    if (reply.code === 'busy') return say('acpVisibility.refresh.busy')
    if (reply.code === 'not-ours') {
      if (reply.hint === 'codex') return say('acpVisibility.refresh.codexHint')
      if (reply.hint === 'qoder') return say('acpVisibility.refresh.qoderHint')
      return say('acpVisibility.refresh.anotherPlugin')
    }
    return say('acpVisibility.refresh.failed', { reason: reply.error })
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

/**
 * 让输入框的模型选择器也失效重载（刷新成功后的另一半个浏览器）。
 *
 * 输入框选择器与 /model 弹窗订阅的是宿主 `modelDirectories` 服务里的**全局目录
 * 快照**（共享 catalog 单例）：它的 `load()` 在快照 ready 且非空时直接回缓存，
 * 只有 `refresh()`（失效 + 重载）才真的重问宿主。刷新更新的是运行期账本——宿主
 * 下一次构建目录就是新的，但快照不失效就永远不重建；同一次浏览器连接里这份
 * 快照是共享单例，新开会话也读到旧值，所以必须失效重载快照本身。宿主产物的
 * `refresh()` 自带 `load().catch` 兜底，这里只管把调用安全地递进去。
 *
 * @param getModelDirectories - 现取 `modelDirectories` 服务的懒取器（服务由别的
 *   模块提供，apply 时未必已起；服务缺席或形状变化都要静默降级——老宿主里
 *   选择器至多重开一次页面后更新，刷新成功的提示不受影响）。
 */
export function refreshGlobalCatalogSnapshot(getModelDirectories: () => unknown): void {
  try {
    const service = getModelDirectories()
    if (typeof service !== 'object' || service === null) return
    // Cordis 每次读都给新的调用方代理；落到底层实例上找共享 catalog（与
    // acp-visibility-filter 同一套 unwrap）。
    const original = (service as Record<symbol, unknown>)[Symbol.for('cordis.original')]
    const instance = typeof original === 'object' && original !== null ? original : service
    const catalog = (instance as { catalog?: unknown }).catalog
    if (typeof catalog !== 'object' || catalog === null) return
    const refresh = (catalog as { refresh?: unknown }).refresh
    if (typeof refresh !== 'function') return
    ;(refresh as () => unknown).call(catalog)
  } catch {
    // 守卫降级：服务缺席 / inactive context / 形状变化都不抛错、不阻塞。
  }
}
