/**
 * 设置里的「WorkBuddy 模型」：勾哪些模型，选择器里就只出现哪些。
 *
 * 站点那边模型一直在变（新的、老的、实验版）。光在选择器里看，勾掉的那些就再也
 * 找不回来了；所以这里把**整份清单**列出来，勾上的进选择器，勾掉的不出现——
 * 以后站点上新了模型，这里能看见，勾一下就能用。
 *
 * 令牌不出宿主，所以这一侧拿到的只有模型的名字、倍率与 id。
 */

import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { NAMESPACE, fallbackT } from './locales.ts'

/** 设置里的行 id。 */
export const WORKBUDDY_MODELS_SECTION_ID = 'acp-agent-workbuddy-models'

/** 行在设置侧栏里的顺序（跟在账号那段后面）。 */
export const WORKBUDDY_MODELS_SECTION_ORDER = 122

/** 宿主路由路径（与宿主侧那一条一致）。 */
export const WORKBUDDY_MODELS_URL = '/acp-agent/workbuddy/models'

/** 清单里的一个模型。 */
export type WorkBuddyListedModel = {
  readonly id: string
  readonly name: string
  readonly description?: string | undefined
  /** 官方积分倍率（如 `x0.29`）。 */
  readonly credits?: string | undefined
  /** 能不能用工具调用：不能的模型只能聊天，选它时 DSH 不带工具。 */
  readonly supportsToolCall?: boolean | undefined
}

/** 宿主给的那份应答。 */
export type WorkBuddyModelList = {
  readonly models: readonly WorkBuddyListedModel[]
  readonly selected: readonly string[]
  /** 用户自己勾过没有（没勾过就是用默认那一份）。 */
  readonly custom: boolean
}

/** 文案座位。 */
export type WorkBuddyModelsT = (key: string, params?: Record<string, string | number>) => string

/**
 * 问宿主要清单与当前勾选。
 * @param options - fetch 实现（测试注入）。
 * @returns 清单与勾选状态。
 */
export async function readWorkBuddyModels(options: {
  readonly fetchImpl?: typeof fetch | undefined
}): Promise<WorkBuddyModelList> {
  const fetchImpl = options.fetchImpl ?? fetch
  const response = await fetchImpl(WORKBUDDY_MODELS_URL, { method: 'GET' })
  const body = await response.json().catch(() => ({})) as Record<string, unknown>
  if (body['ok'] !== true) throw new Error('问不到 WorkBuddy 的模型清单')
  const models = Array.isArray(body['models']) ? body['models'] : []
  const selected = Array.isArray(body['selected']) ? body['selected'] : []
  return {
    models: models.flatMap(entry => {
      if (typeof entry !== 'object' || entry === null) return []
      const record = entry as Record<string, unknown>
      const id = typeof record['id'] === 'string' ? record['id'] : ''
      if (id === '') return []
      const name = typeof record['name'] === 'string' ? record['name'] : id
      const description = typeof record['description'] === 'string' ? record['description'] : undefined
      const credits = typeof record['credits'] === 'string' ? record['credits'] : undefined
      const supportsToolCall = typeof record['supportsToolCall'] === 'boolean' ? record['supportsToolCall'] : undefined
      return [{
        id,
        name,
        ...(description === undefined ? {} : { description }),
        ...(credits === undefined ? {} : { credits }),
        ...(supportsToolCall === undefined ? {} : { supportsToolCall }),
      }]
    }),
    selected: selected.filter((id): id is string => typeof id === 'string'),
    custom: body['custom'] === true,
  }
}

/**
 * 把勾选结果存回去。
 * @param ids - 勾了的模型 id。
 * @param options - fetch 实现（测试注入）。
 */
export async function saveWorkBuddySelection(
  ids: readonly string[],
  options: { readonly fetchImpl?: typeof fetch | undefined } = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch
  const response = await fetchImpl(WORKBUDDY_MODELS_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids: [...ids] }),
  })
  const body = await response.json().catch(() => ({})) as Record<string, unknown>
  if (body['ok'] !== true) throw new Error('WorkBuddy 的勾选没存上')
}

/** 视图要什么。 */
export type WorkBuddyModelsViewProps = {
  readonly list: WorkBuddyModelList
  readonly busy?: boolean | undefined
  readonly onToggle?: ((id: string, checked: boolean) => void) | undefined
  readonly onRestoreDefault?: (() => void) | undefined
  readonly t?: WorkBuddyModelsT | undefined
}

/**
 * 画这一段：整份清单，每个模型一个勾选框。
 * @param props - 清单与两个动作。
 * @returns 元素树。
 */
export function workBuddyModelsView(props: WorkBuddyModelsViewProps): ReactNode {
  const t = props.t ?? fallbackT
  const selected = new Set(props.list.selected)
  const rows = props.list.models.map(model => {
    const checked = selected.has(model.id)
    return (
      <label key={model.id} data-workbuddy-model-row={model.id} style={{ display: 'flex', gap: '8px', alignItems: 'baseline' }}>
        <input
          type="checkbox"
          data-workbuddy-model={model.id}
          checked={checked}
          disabled={props.busy === true}
          onChange={(event: { target: { checked: boolean } }) => { props.onToggle?.(model.id, event.target.checked) }}
        />
        <span data-workbuddy-model-name="true">{model.name}</span>
        <code data-workbuddy-model-id="true">{model.id}</code>
        {model.credits === undefined
          ? null
          : <span data-workbuddy-model-credits={true}>积分 {model.credits}</span>}
        {model.supportsToolCall === false
          ? <span data-workbuddy-model-notool={true}>{t('workbuddy.models.noTool')}</span>
          : null}
      </label>
    )
  })

  return (
    <div data-workbuddy-models="root">
      <p data-workbuddy-models-summary={true}>
        {t('workbuddy.models.summary', {
          total: props.list.models.length,
          selected: props.list.selected.length,
        })}
      </p>
      {props.list.custom
        ? <span data-workbuddy-models-custom={true}>{t('workbuddy.models.custom')}</span>
        : <span data-workbuddy-models-default={true}>{t('workbuddy.models.defaultHint')}</span>}
      <div data-workbuddy-models-list={true}>{rows}</div>
      <button
        type="button"
        data-workbuddy-models-restore={true}
        disabled={props.busy === true}
        onClick={() => { props.onRestoreDefault?.() }}
      >
        {t('workbuddy.models.restore')}
      </button>
    </div>
  )
}

/** 组件：取一次清单，勾一下存一次。 */
export function WorkBuddyModelsSection(props: { readonly t?: WorkBuddyModelsT }): ReactNode {
  const [list, setList] = useState<WorkBuddyModelList>({ models: [], selected: [], custom: false })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  const reload = useCallback(async () => {
    setBusy(true)
    try {
      setList(await readWorkBuddyModels({}))
      setError(undefined)
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem))
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  const toggle = useCallback((id: string, checked: boolean) => {
    setBusy(true)
    const next = checked
      ? [...list.selected.filter(item => item !== id), id]
      : list.selected.filter(item => item !== id)
    setList({ ...list, selected: next, custom: true })
    void saveWorkBuddySelection(next)
      .then(() => reload())
      .catch((problem: unknown) => {
        setError(problem instanceof Error ? problem.message : String(problem))
        setBusy(false)
      })
  }, [list, reload])

  const restoreDefault = useCallback(() => {
    setBusy(true)
    const defaults = list.models.map(model => model.id)
    void saveWorkBuddySelection(defaults)
      .then(() => reload())
      .catch((problem: unknown) => {
        setError(problem instanceof Error ? problem.message : String(problem))
        setBusy(false)
      })
  }, [list.models, reload])

  return (
    <div>
      {error === undefined
        ? null
        : <p data-workbuddy-models-error="true">{error}</p>}
      {workBuddyModelsView({
        list,
        busy,
        onToggle: (id, checked) => { toggle(id, checked) },
        onRestoreDefault: () => { restoreDefault() },
        ...(props.t === undefined ? {} : { t: props.t }),
      })}
    </div>
  )
}

/** 设置侧栏的插槽面。 */
export type WorkBuddyModelsSlotHost = {
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

/**
 * 把这一段挂进设置对话框。
 * @param slots - 设置的插槽注册面。
 * @param label - 侧栏那一行的标题。
 * @param t - 文案座位。
 */
export function registerWorkBuddyModelsSection(
  slots: WorkBuddyModelsSlotHost,
  label: () => string,
  t?: WorkBuddyModelsT,
): void {
  slots.inject('settings.section', () => slots.register(
    {
      name: 'settings.section',
      id: WORKBUDDY_MODELS_SECTION_ID,
      order: WORKBUDDY_MODELS_SECTION_ORDER,
      label,
      locale: NAMESPACE,
      inject: () => ({ t }),
    },
    WorkBuddyModelsSection,
  ))
}
