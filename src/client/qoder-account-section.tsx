/**
 * 设置里的「Qoder 国际版账号」段。
 *
 * 这一段只做两件事：问宿主「登了没」，以及在没登录时给一个能点开的授权地址。
 * 令牌不出宿主，所以浏览器这一侧从头到尾没有令牌——视图不读、应答里也不该有。
 *
 * 视图是纯函数（可以直接断言形状），组件只负责取数与重画。
 */

import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { NAMESPACE, fallbackT } from './locales.ts'
import {
  ACCOUNT_ACTIONS_STYLE,
  ACCOUNT_BOX_STYLE,
  ACCOUNT_BUTTON_STYLE,
  ACCOUNT_COLUMN_STYLE,
} from './account-panel.tsx'
import {
  modelChecklistView,
  readModelChecklist,
  saveModelChecklist,
} from './model-checklist.tsx'
import type { ModelChecklistState } from './model-checklist.tsx'

/** 设置侧栏的插槽面。 */
export type AccountSlotHost = {
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

/** 设置里的行 id。 */
export const QODER_ACCOUNT_SECTION_ID = 'acp-agent-qoder-account'

/** 行在设置侧栏里的顺序。 */
export const QODER_ACCOUNT_SECTION_ORDER = 121

/** 宿主路由路径（与宿主侧那几条一致）。 */
export const QODER_SESSION_URL = '/acp-agent/qoder-global/session'
export const QODER_LOGIN_URL = '/acp-agent/qoder-global/login'
export const QODER_MODELS_URL = '/acp-agent/qoder-global/models'

/** 账号状态：只认「登了没」与「是谁」，没有令牌。 */
export type QoderAccountState = {
  readonly authenticated: boolean
  readonly account?: { readonly uid: string; readonly nickname?: string | undefined } | undefined
  readonly reason?: string | undefined
}

/** 文案座位。 */
export type QoderAccountT = (key: string, params?: Record<string, string | number>) => string

/** 视图要什么。 */
export type QoderAccountViewProps = {
  readonly state: QoderAccountState
  readonly busy?: boolean | undefined
  readonly onLogin?: (() => void) | undefined
  readonly onRefresh?: (() => void) | undefined
  readonly t?: QoderAccountT | undefined
}

/** 整段的视图要什么：账号那部分 + 模型列表那部分。 */
export type QoderSettingsViewProps = QoderAccountViewProps & {
  readonly models?: ModelChecklistState | undefined
  readonly query?: string | undefined
  readonly onQueryChange?: ((value: string) => void) | undefined
  readonly onToggle?: ((id: string, checked: boolean) => void) | undefined
  readonly onRestoreDefault?: (() => void) | undefined
}

/**
 * 问宿主「登了没」。
 * @param options - fetch 实现（测试注入）。
 * @returns 账号状态。
 */
export async function readQoderSession(options: {
  readonly fetchImpl?: typeof fetch | undefined
}): Promise<QoderAccountState> {
  const fetchImpl = options.fetchImpl ?? fetch
  const response = await fetchImpl(QODER_SESSION_URL, { method: 'GET' })
  const body = await response.json().catch(() => ({})) as Record<string, unknown>
  if (body['ok'] !== true) {
    const reason = typeof body['reason'] === 'string' ? body['reason'] : '问不到宿主'
    return { authenticated: false, reason }
  }
  if (body['authenticated'] !== true) {
    // 宿主说「登录没成」时把那句话带出来——只显示「未登录」会让人以为没试过。
    const reason = typeof body['reason'] === 'string' ? body['reason'] : undefined
    return { authenticated: false, ...(reason === undefined ? {} : { reason }) }
  }
  const account = body['account']
  const record = typeof account === 'object' && account !== null ? account as Record<string, unknown> : undefined
  const uid = typeof record?.['uid'] === 'string' ? record['uid'] : ''
  const nickname = typeof record?.['nickname'] === 'string' ? record['nickname'] : undefined
  return {
    authenticated: true,
    account: { uid, ...(nickname === undefined ? {} : { nickname }) },
  }
}

/**
 * 开始一次登录：问宿主要授权地址并交给开窗函数。
 * @param options - fetch 实现与开窗函数（测试注入）。
 * @returns 宿主给的结果。
 */
export async function beginQoderLogin(options: {
  readonly fetchImpl?: typeof fetch | undefined
  readonly openUrl?: ((url: string) => void) | undefined
}): Promise<{ ok: boolean; reason?: string }> {
  const fetchImpl = options.fetchImpl ?? fetch
  const open = options.openUrl ?? ((url: string) => { window.open(url, '_blank', 'noopener') })
  const response = await fetchImpl(QODER_LOGIN_URL, { method: 'POST' })
  const body = await response.json().catch(() => ({})) as Record<string, unknown>
  if (body['ok'] !== true) {
    const reason = typeof body['reason'] === 'string' ? body['reason'] : '登录没起来'
    return { ok: false, reason }
  }
  const url = typeof body['url'] === 'string' ? body['url'] : ''
  if (url === '') return { ok: false, reason: '宿主没给授权地址' }
  open(url)
  return { ok: true }
}

/**
 * 连着问几次「登了没」，登上就停。
 *
 * 用户在浏览器里授权要花时间（可能要输验证码），问一次就收手会看到「未登录」，
 * 让人以为没成。所以这里问若干次，每次之间停一下。
 * @param options - fetch 实现、问几次与等待。
 * @returns 最后的账号状态。
 */
export async function pollUntilQoderSignedIn(options: {
  readonly fetchImpl?: typeof fetch | undefined
  readonly attempts?: number | undefined
  readonly intervalMs?: number | undefined
  readonly sleepImpl?: ((ms: number) => Promise<void>) | undefined
}): Promise<QoderAccountState> {
  const attempts = options.attempts ?? 20
  const intervalMs = options.intervalMs ?? 3_000
  const sleep = options.sleepImpl ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  let state: QoderAccountState = { authenticated: false }
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    state = await readQoderSession({ ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }) })
    if (state.authenticated) return state
    await sleep(intervalMs)
  }
  return state
}

/**
 * 画这一段。
 *
 * 已登录就说清是谁；没登录就给一个「去登录」按钮（点了开授权页）。
 * @param props - 状态与两个动作。
 * @returns 元素树。
 */
export function qoderAccountView(props: QoderAccountViewProps): ReactNode {
  const t = props.t ?? fallbackT
  const state = props.state

  // 账号信息：自己一个框，独占一行。
  const box = state.authenticated
    ? (
      <>
        <span data-qoder-account="signed-in">{t('qoder.account.signedIn')}</span>
        {state.account?.nickname !== undefined && state.account.nickname !== ''
          ? <strong data-qoder-account-name="true">{state.account.nickname}</strong>
          : null}
        {state.account?.uid !== undefined && state.account.uid !== ''
          ? <code data-qoder-account-uid="true">{state.account.uid}</code>
          : null}
      </>
    )
    : (
      <>
        <span data-qoder-account="signed-out">{t('qoder.account.signedOut')}</span>
        {state.reason !== undefined && state.reason !== ''
          ? <span data-qoder-reason="true">{state.reason}</span>
          : null}
      </>
    )

  return (
    <div data-qoder-account="root" style={ACCOUNT_COLUMN_STYLE}>
      <div data-qoder-account-box={true} style={ACCOUNT_BOX_STYLE}>
        {box}
      </div>
      <div data-qoder-account-actions={true} style={ACCOUNT_ACTIONS_STYLE}>
        {/* 已登录时不摆登录按钮：杵在那儿的「重新登录」看着就是在催你登录。 */}
        {state.authenticated
          ? null
          : (
            <button
              type="button"
              data-qoder-login={true}
              style={ACCOUNT_BUTTON_STYLE}
              disabled={props.busy === true}
              onClick={() => { props.onLogin?.() }}
            >
              {t('qoder.account.login')}
            </button>
          )}
        <button
          type="button"
          data-qoder-refresh={true}
          style={ACCOUNT_BUTTON_STYLE}
          disabled={props.busy === true}
          onClick={() => { props.onRefresh?.() }}
        >
          {t('qoder.account.refresh')}
        </button>
      </div>
    </div>
  )
}

/**
 * 整段的视图：账号那部分在上，模型列表在下。
 * @param props - 账号状态、模型清单与各个动作。
 * @returns 元素树。
 */
export function qoderSettingsView(props: QoderSettingsViewProps): ReactNode {
  return (
    <div
      data-qoder-settings="root"
      style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}
    >
      {qoderAccountView(props)}
      {props.models === undefined
        ? null
        : modelChecklistView({
          list: props.models,
          ...(props.busy === undefined ? {} : { busy: props.busy }),
          ...(props.query === undefined ? {} : { query: props.query }),
          ...(props.onQueryChange === undefined ? {} : { onQueryChange: props.onQueryChange }),
          ...(props.onToggle === undefined ? {} : { onToggle: props.onToggle }),
          ...(props.onRestoreDefault === undefined ? {} : { onRestoreDefault: props.onRestoreDefault }),
          ...(props.t === undefined ? {} : { t: props.t }),
        })}
    </div>
  )
}

/** 组件：取一次状态，之后由两个动作驱动。 */
export function QoderAccountSection(props: { readonly t?: QoderAccountT }): ReactNode {
  const [state, setState] = useState<QoderAccountState>({ authenticated: false })
  const [models, setModels] = useState<ModelChecklistState | undefined>(undefined)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    setBusy(true)
    try {
      setState(await readQoderSession({}))
    } catch (error) {
      setState({ authenticated: false, reason: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }, [])

  const reloadModels = useCallback(async () => {
    try {
      setModels(await readModelChecklist(QODER_MODELS_URL, {}))
    } catch {
      // 清单拿不到就只留账号那部分（模型列表空着，不挡着别的设置）。
      setModels(undefined)
    }
  }, [])

  useEffect(() => { void refresh(); void reloadModels() }, [refresh, reloadModels])

  const login = useCallback(async () => {
    setBusy(true)
    try {
      const result = await beginQoderLogin({})
      if (!result.ok) {
        setState({ authenticated: false, reason: result.reason })
        return
      }
      // 授权在浏览器里完成，宿主那边还在轮询；这里连着问几次，登上了就停。
      void pollUntilQoderSignedIn({}).then(signedIn => {
        setState(signedIn)
        setBusy(false)
      })
    } finally {
      setBusy(false)
    }
  }, [refresh])

  const toggle = useCallback((id: string, checked: boolean) => {
    const current = models?.selected ?? []
    const next = checked
      ? [...current.filter(item => item !== id), id]
      : current.filter(item => item !== id)
    setModels(models === undefined ? undefined : { ...models, selected: next, custom: true })
    void saveModelChecklist(QODER_MODELS_URL, next, {}).catch(() => undefined)
  }, [models])

  const restoreDefault = useCallback(() => {
    const defaults = models?.default ?? []
    void saveModelChecklist(QODER_MODELS_URL, defaults, {}).catch(() => undefined)
  }, [models])

  return qoderSettingsView({
    state,
    busy,
    ...(models === undefined ? {} : { models }),
    query,
    onQueryChange: (value: string) => { setQuery(value) },
    onToggle: (id, checked) => { toggle(id, checked) },
    onRestoreDefault: () => { restoreDefault() },
    onLogin: () => { void login() },
    onRefresh: () => { void refresh() },
    ...(props.t === undefined ? {} : { t: props.t }),
  })
}

/**
 * 把这一段挂进设置对话框。
 * @param slots - 设置的插槽注册面。
 * @param label - 侧栏那一行的标题。
 * @param t - 文案座位。
 */
export function registerQoderAccountSection(
  slots: AccountSlotHost,
  label: () => string,
  t?: QoderAccountT,
): void {
  slots.inject('settings.section', () => slots.register(
    {
      name: 'settings.section',
      id: QODER_ACCOUNT_SECTION_ID,
      order: QODER_ACCOUNT_SECTION_ORDER,
      label,
      locale: NAMESPACE,
      inject: () => ({ t }),
    },
    QoderAccountSection,
  ))
}
