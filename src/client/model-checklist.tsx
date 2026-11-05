/**
 * 模型勾选清单（通用的那一份）。
 *
 * 上游的模型一直在变（新的、老的、实验版）。光在选择器里看，勾掉的那些就再也找
 * 不回来了——所以把**整份清单**列出来，勾上的进选择器，勾掉的不出现。站点上新
 * 了模型，这里能看见，勾一下就能用。
 *
 * 这一份不认得哪家上游：路由地址由外面给，形状两家一样。
 */

import type { ReactNode } from 'react'
import { fallbackT } from './locales.ts'

/** 清单里的一个模型。 */
export type ListedModel = {
  readonly id: string
  readonly name: string
  readonly description?: string | undefined
  /** 官方积分倍率（如 `x0.29`）；没有这一项就不显示胶囊。 */
  readonly credits?: string | undefined
  /** 能不能用工具调用：不能的模型只能聊天。 */
  readonly supportsToolCall?: boolean | undefined
}

/** 宿主给的那份应答。 */
export type ModelChecklistState = {
  readonly models: readonly ListedModel[]
  readonly selected: readonly string[]
  /** 用户自己勾过没有（没勾过就是用默认那一份）。 */
  readonly custom: boolean
  /** 默认那一份（挂载行里声明的）：「恢复默认」按它存。 */
  readonly default?: readonly string[] | undefined
}

/** 文案座位。 */
export type ModelChecklistT = (key: string, params?: Record<string, string | number>) => string

/**
 * 按搜索词过滤清单。
 *
 * 名字、id、倍率、描述都算——用户记得住的是「Hy4」「GLM」「x0.29」里的任意一个。
 * @param models - 整份清单。
 * @param query - 搜索词；空或只有空白等于不过滤。
 * @returns 匹配的那些。
 */
export function filterModels(
  models: readonly ListedModel[],
  query: string,
): ListedModel[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return [...models]
  return models.filter(model => (
    model.name.toLowerCase().includes(needle)
    || model.id.toLowerCase().includes(needle)
    || (model.credits ?? '').toLowerCase().includes(needle)
    || (model.description ?? '').toLowerCase().includes(needle)
  ))
}

/**
 * 问宿主要清单与当前勾选。
 * @param url - 宿主那条路由的地址。
 * @param options - fetch 实现（测试注入）。
 * @returns 清单与勾选状态。
 */
export async function readModelChecklist(
  url: string,
  options: { readonly fetchImpl?: typeof fetch | undefined } = {},
): Promise<ModelChecklistState> {
  const fetchImpl = options.fetchImpl ?? fetch
  const response = await fetchImpl(url, { method: 'GET' })
  const body = await response.json().catch(() => ({})) as Record<string, unknown>
  if (body['ok'] !== true) throw new Error('问不到模型清单')
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
    ...(Array.isArray(body['default'])
      ? { default: body['default'].filter((id): id is string => typeof id === 'string') }
      : {}),
  }
}

/**
 * 把勾选结果存回去。
 * @param url - 宿主那条路由的地址。
 * @param ids - 勾了的模型 id。
 * @param options - fetch 实现（测试注入）。
 */
export async function saveModelChecklist(
  url: string,
  ids: readonly string[],
  options: { readonly fetchImpl?: typeof fetch | undefined } = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids: [...ids] }),
  })
  const body = await response.json().catch(() => ({})) as Record<string, unknown>
  if (body['ok'] !== true) throw new Error('勾选没存上')
}

/** 视图要什么。 */
export type ModelChecklistViewProps = {
  readonly list: ModelChecklistState
  readonly busy?: boolean | undefined
  /** 搜索词。 */
  readonly query?: string | undefined
  readonly onQueryChange?: ((value: string) => void) | undefined
  readonly onToggle?: ((id: string, checked: boolean) => void) | undefined
  readonly onRestoreDefault?: (() => void) | undefined
  readonly t?: ModelChecklistT | undefined
}

/**
 * 画这份清单：标题、搜索框、说明、每行一个勾选框。
 * @param props - 清单与几个动作。
 * @returns 元素树。
 */
export function modelChecklistView(props: ModelChecklistViewProps): ReactNode {
  const t = props.t ?? fallbackT
  const selected = new Set(props.list.selected)
  const query = props.query ?? ''
  const visible = filterModels(props.list.models, query)
  const rows = visible.map(model => {
    const checked = selected.has(model.id)
    return (
      <label key={model.id} data-model-row={model.id} style={{ display: 'flex', gap: '8px', alignItems: 'baseline' }}>
        <input
          type="checkbox"
          data-model-check={model.id}
          checked={checked}
          disabled={props.busy === true}
          onChange={(event: { target: { checked: boolean } }) => { props.onToggle?.(model.id, event.target.checked) }}
        />
        <span data-model-name="true">{model.name}</span>
        <code data-model-id="true">{model.id}</code>
        {model.supportsToolCall === false
          ? <span data-model-notool={true}>{t('modelChecklist.noTool')}</span>
          : null}
      </label>
    )
  })

  return (
    <div
      data-model-checklist="root"
      style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}
    >
      <h4 data-model-title={true}>{t('modelChecklist.title')}</h4>
      <input
        type="search"
        data-model-search={true}
        value={query}
        placeholder={t('modelChecklist.search')}
        disabled={props.busy === true}
        onChange={(event: { target: { value: string } }) => { props.onQueryChange?.(event.target.value) }}
      />
      <p data-model-summary={true}>
        {t('modelChecklist.summary', {
          total: props.list.models.length,
          selected: props.list.selected.length,
        })}
      </p>
      {props.list.custom
        ? <span data-model-custom={true}>{t('modelChecklist.custom')}</span>
        : <span data-model-default={true}>{t('modelChecklist.defaultHint')}</span>}
      <div
        data-model-list={true}
        style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}
      >
        {rows.length === 0
          ? <p data-model-empty={true}>{t('modelChecklist.empty')}</p>
          : rows}
      </div>
      <button
        type="button"
        data-model-restore={true}
        disabled={props.busy === true}
        onClick={() => { props.onRestoreDefault?.() }}
      >
        {t('modelChecklist.restore')}
      </button>
    </div>
  )
}
