/**
 * The settings section where the user picks which models each ACP preset may
 * offer — a positive whitelist.
 *
 * It lists each built-in preset's RAW model list (the full set the agent can
 * serve, read straight from the host's `/acp-agent/selection` route), with one
 * checkbox per model. A checked model shows up in the picker; an unchecked one
 * never appears. Each preset's selection is stored independently under its own
 * scope (`${DSH_HOME}/acp-<preset>/selection.json`), so toggling Codex never
 * touches Claude.
 *
 * The official Settings → Models page stays untouched — the API keys live there
 * and are never part of this choice. The host already publishes the catalog
 * filtered by these selections, so the picker reads the host catalog directly;
 * this section only reads the RAW list (to draw the checkboxes) and POSTs the
 * chosen subset (so the host can re-publish).
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { refreshGlobalCatalogSnapshot } from './model-refresh.ts'
import { fallbackT } from './locales.ts'
import styles from './acp-selection.module.css'

/** Shared identity of the settings rail row and the body it mounts. */
export const ACP_SELECTION_PANEL_ID = 'acp-agent-acp-selection'
/** Below the hosts section (100), so it reads as a second setting. */
export const ACP_SELECTION_PANEL_ORDER = 110

/**
 * 宿主勾选读写路由的 exact 路径（与 selection-route.ts 的 SELECTION_ROUTE_PATH
 * 一致）。在这里重声明而不 import 宿主模块：浏览器半边不能拖进 `node:http`
 * 之类的宿主依赖——那是 selection-route.ts（宿主侧），客户端只认这条路径字符串。
 */
export const SELECTION_ROUTE_PATH = '/acp-agent/selection'

/** The `t` seat: either the framework-synthesized one or our fallback dictionary. */
export type AcpSelectionT = (key: string, params?: Record<string, string | number>) => string

/** One model row the section lists. */
export type AcpSelectionModel = {
  readonly id: string
  readonly name: string
}

/** One preset's whitelist state. */
export type AcpSelectionPreset = {
  /** preset id (`acp-codex`…); the host keys the scope on it. */
  readonly preset: string
  /** 落盘 scope (`acp-codex`…). */
  readonly scope: string
  readonly name: string
  readonly models: readonly AcpSelectionModel[]
  /** Checked model ids; `undefined` = the user never chose (default: all on). */
  readonly selected: readonly string[] | undefined
  readonly custom: boolean
}

/** The settings page's view of the whitelist. */
export type AcpSelectionSnapshot = {
  readonly status: 'idle' | 'loading' | 'ready' | 'error'
  readonly presets: readonly AcpSelectionPreset[]
  readonly error: string | null
}

/** The route's GET reply shape. */
type SelectionListReply = {
  ok: true
  presets: AcpSelectionPreset[]
}

/** What the section reads from the page wiring, without the framework shares. */
export type AcpSelectionBusinessProps = {
  /**
   * 读一次 `/acp-agent/selection`（GET）：列出各 preset 的 RAW 模型清单 + 用户勾了
   * 哪些。接线层提供（浏览器侧用 fetch），缺省（老接线/测试）则读不到清单。
   */
  readonly readSelections?: () => Promise<unknown>
  /** 保存某个 preset 的勾选（POST 到宿主路由）。 */
  readonly saveSelection?: (preset: string, ids: readonly string[] | undefined) => Promise<void>
  /**
   * 勾选落盘成功后让输入框的模型选择器失效重载（全局目录快照的 `refresh()`）。
   */
  readonly refreshGlobalCatalog?: (() => void) | undefined
}

/** The wiring's face plus the framework's `t` seat. */
export type AcpSelectionPanelProps = { t?: AcpSelectionT } & AcpSelectionBusinessProps

/**
 * The slot face this section registers through. `settings.section` is a list
 * kind slot declared by the shell; one more id in it is one more rail row.
 */
export type AcpSelectionSlotHost = {
  inject(key: string, callback: () => unknown): unknown
  register(options: {
    name: string
    id?: string
    order?: number
    label?: () => string
    locale?: string
    inject?: () => unknown
  }, component: unknown): unknown
}

const NOOP = (): void => {}

/**
 * Parse the route reply into a snapshot. A bad shape reads as an error rather
 * than a crash: the section stays on screen showing a retry line.
 */
function parseReply(raw: unknown): { presets?: readonly AcpSelectionPreset[]; error?: string } {
  if (typeof raw !== 'object' || raw === null) return { error: 'bad-reply' }
  const record = raw as { ok?: unknown; presets?: unknown }
  if (record['ok'] !== true) return { error: 'bad-reply' }
  if (!Array.isArray(record['presets'])) return { error: 'bad-reply' }
  const presets: AcpSelectionPreset[] = []
  for (const entry of record['presets']) {
    if (typeof entry !== 'object' || entry === null) continue
    const e = entry as {
      preset?: unknown; scope?: unknown; name?: unknown; models?: unknown; selected?: unknown; custom?: unknown
    }
    if (typeof e['preset'] !== 'string' || e['preset'] === '') continue
    const models: AcpSelectionModel[] = []
    if (Array.isArray(e['models'])) {
      for (const model of e['models']) {
        if (typeof model !== 'object' || model === null) continue
        const m = model as { id?: unknown; name?: unknown }
        if (typeof m['id'] !== 'string' || m['id'] === '') continue
        models.push({ id: m['id'], name: typeof m['name'] === 'string' && m['name'] !== '' ? m['name'] : m['id'] })
      }
    }
    const selected = Array.isArray(e['selected'])
      ? (e['selected'] as unknown[]).filter((id): id is string => typeof id === 'string' && id !== '')
      : undefined
    presets.push({
      preset: e['preset'],
      scope: typeof e['scope'] === 'string' ? e['scope'] : e['preset'],
      name: typeof e['name'] === 'string' && e['name'] !== '' ? e['name'] : e['preset'],
      models,
      selected,
      custom: e['custom'] === true,
    })
  }
  return { presets }
}

/**
 * Register the section into the settings dialog.
 * @param slots - the page's slot registry face.
 * @param face - what the section reads.
 * @param label - the rail row's label, re-read per render.
 */
export function registerAcpSelectionSection(
  slots: AcpSelectionSlotHost,
  face: AcpSelectionBusinessProps,
  label: () => string,
): void {
  slots.inject('settings.section', () => slots.register(
    {
      name: 'settings.section',
      id: ACP_SELECTION_PANEL_ID,
      order: ACP_SELECTION_PANEL_ORDER,
      label,
      locale: 'acpAgentClient',
      inject: () => face,
    },
    AcpSelectionPanel,
  ))
}

/**
 * Render the settings section.
 * @param props - injected face plus the locale seat.
 */
export function AcpSelectionPanel(
  { readSelections, saveSelection, refreshGlobalCatalog, t }: AcpSelectionPanelProps,
): ReactNode {
  const say = t ?? fallbackT
  const snapshot = useSyncExternalStore(
    useCallback((listener: () => void) => {
      const dispose = startSelections(readSelections, listener)
      return dispose
    }, [readSelections]),
    () => currentSelections(),
    () => currentSelections(),
  )
  const [busy, setBusy] = useState<string | null>(null)

  // Every mount asks the host again: presets can be added or removed between
  // two openings of the settings dialog. `startSelections` kicks the first read
  // on subscribe; the explicit reload here covers a reader that arrives late.
  useEffect(() => {
    void reloadSelections(readSelections)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readSelections])

  const checkedIdsOf = (preset: AcpSelectionPreset): Set<string> => {
    // No selection yet = everything is on (default). The checkbox reflects the
    // effective state, so an untouched model reads as checked.
    const source = preset.selected ?? preset.models.map(model => model.id)
    return new Set(source)
  }

  const toggle = (preset: AcpSelectionPreset, modelId: string, checked: boolean): void => {
    if (busy !== null) return
    setBusy(preset.preset)
    const current = [...checkedIdsOf(preset)]
    const next = checked
      ? current.includes(modelId) ? current : [...current, modelId]
      : current.filter(id => id !== modelId)
    // Last model may not be unchecked: a row with zero models drops the current
    // model out of the catalog, the composer's effort axis vanishes, and the host
    // refuses the selection and reports it (the same guard the model picker uses).
    // Restoring every model is the honest "back to default" — not an empty row.
    const finalIds = next.length === 0 ? preset.models.map(model => model.id) : next
    const payload = next.length === 0 || finalIds.length === preset.models.length
      ? undefined
      : finalIds
    void (saveSelection?.(preset.preset, payload) ?? Promise.resolve())
      .then(() => {
        refreshGlobalCatalog?.()
        return reloadSelections(readSelections)
      })
      .catch(() => undefined)
      .finally(() => setBusy(null))
  }

  return (
    <div className={styles.root}>
      <h2 className={styles.title}>{fallbackT('acpSelection.title')}</h2>
      <p className={styles.intro}>{fallbackT('acpSelection.intro')}</p>
      <div className={styles.toolbar}>
        <span className={styles.summary}>
          {fallbackT('acpSelection.summary', {
            presets: snapshot.presets.length,
            models: snapshot.presets.reduce((total, preset) => total + preset.models.length, 0),
          })}
        </span>
        <button
          type="button"
          className={styles.action}
          disabled={snapshot.status === 'loading'}
          onClick={() => { void reloadSelections(readSelections) }}
        >{fallbackT('acpSelection.reload')}</button>
      </div>
      {snapshot.status === 'error' && snapshot.error !== null && (
        <div className={styles.errorRow}>
          <p className={styles.stateBad} role="alert">{fallbackT('acpSelection.error')}</p>
          <button
            type="button"
            className={styles.action}
            onClick={() => { void reloadSelections(readSelections) }}
          >{fallbackT('acpSelection.retry')}</button>
        </div>
      )}
      {(snapshot.status === 'idle' || snapshot.status === 'loading') && (
        <p className={styles.stateLine} role="status">{fallbackT('acpSelection.loading')}</p>
      )}
      {snapshot.status === 'ready' && (
        snapshot.presets.length === 0
          ? <p className={styles.stateLine}>{fallbackT('acpSelection.empty')}</p>
          : <div className={styles.presets}>
              {snapshot.presets.map(preset => (
                <div className={styles.preset} key={preset.preset} data-preset={preset.preset}>
                  <div className={styles.presetHead}>
                    <span className={styles.presetName}>{preset.name}</span>
                    <code className={styles.route}>{preset.preset}</code>
                  </div>
                  {preset.models.length === 0
                    ? <p className={styles.note}>{fallbackT('acpSelection.noModels')}</p>
                    : (
                      <ul className={styles.models}>
                        {preset.models.map(model => (
                          <li key={model.id}>
                            <label>
                              <input
                                type="checkbox"
                                checked={checkedIdsOf(preset).has(model.id)}
                                disabled={busy === preset.preset}
                                aria-label={fallbackT('acpSelection.modelToggleNamed', { name: model.name, preset: preset.name })}
                                onChange={event => { toggle(preset, model.id, event.target.checked) }}
                              />
                              <span>{model.name}</span>
                              <code className={styles.modelId}>{model.id}</code>
                            </label>
                          </li>
                        ))}
                      </ul>
                    )}
                </div>
              ))}
            </div>
      )}
    </div>
  )
}

/**
 * A tiny external store so `useSyncExternalStore` re-renders on reload. The
 * section is the only subscriber, so the store lives at module scope for the
 * life of one mounted instance and is replaced on each reload.
 */
let liveSnapshot: AcpSelectionSnapshot = { status: 'idle', presets: [], error: null }
const liveListeners = new Set<() => void>()

function publish(next: AcpSelectionSnapshot): void {
  if (next.status === liveSnapshot.status
    && next.presets === liveSnapshot.presets
    && next.error === liveSnapshot.error) return
  liveSnapshot = next
  for (const listener of [...liveListeners]) listener()
}

function currentSelections(): AcpSelectionSnapshot {
  return liveSnapshot
}

/** Re-read the route and publish the result. */
async function reloadSelections(read: (() => Promise<unknown>) | undefined): Promise<void> {
  if (read === undefined) {
    publish({ status: 'error', presets: [], error: 'no-reader' })
    return
  }
  publish({ status: 'loading', presets: liveSnapshot.presets, error: null })
  try {
    const parsed = parseReply(await read())
    if (parsed.error !== undefined) {
      publish({ status: 'error', presets: [], error: parsed.error })
      return
    }
    publish({ status: 'ready', presets: parsed.presets ?? [], error: null })
  } catch {
    publish({ status: 'error', presets: [], error: 'read-failed' })
  }
}

/**
 * Subscribe to the live store and kick the first read on mount. Returns a
 * disposer that unsubscribes (the store is module-scoped, but the listener
 * set is per-mount so a hot swap leaves nothing dangling).
 */
function startSelections(read: (() => Promise<unknown>) | undefined, listener: () => void): () => void {
  liveListeners.add(listener)
  if (liveSnapshot.status === 'idle') void reloadSelections(read)
  return () => { liveListeners.delete(listener) }
}
