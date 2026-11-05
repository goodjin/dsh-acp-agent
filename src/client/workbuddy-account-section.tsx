/**
 * 设置里的「WorkBuddy 账号」段——账号与模型列表都在这一段里。
 *
 * 这一段做三件事：问宿主「登了没」、在没登录时给一个能点开的授权地址、把整份模型
 * 清单列出来让人勾（勾上的才进模型选择器）。
 * 令牌不出宿主，所以浏览器这一侧从头到尾没有令牌——视图不读、应答里也不该有。
 *
 * 排版：账号信息自己一个框、独占一行；下面一行放两个按钮（同样大小、留出间距）；
 * 再往下是模型列表（搜索框 + 勾选清单）。
 *
 * 视图是纯函数（可以直接断言形状），组件只负责取数与重画。
 */

import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { NAMESPACE, fallbackT } from './locales.ts'
import {
  readWorkBuddyModels,
  saveWorkBuddySelection,
  workBuddyModelsView,
} from './workbuddy-models-section.tsx'
import type { WorkBuddyModelList } from './workbuddy-models-section.tsx'

/** 设置里的行 id。 */
export const WORKBUDDY_ACCOUNT_SECTION_ID = 'acp-agent-workbuddy-account'

/** 行在设置侧栏里的顺序。 */
export const WORKBUDDY_ACCOUNT_SECTION_ORDER = 120

/** 宿主路由路径（与宿主侧那两条一致）。 */
export const WORKBUDDY_SESSION_URL = '/acp-agent/workbuddy/session'
export const WORKBUDDY_LOGIN_URL = '/acp-agent/workbuddy/login'

/** 账号状态：只认「登了没」与「是谁」，没有令牌。 */
export type WorkBuddyAccountState = {
  readonly authenticated: boolean
  readonly account?: { readonly uid: string; readonly nickname?: string | undefined } | undefined
  readonly reason?: string | undefined
}

/** 文案座位。 */
export type WorkBuddyAccountT = (key: string, params?: Record<string, string | number>) => string

/** 两个按钮共用的样式：一样大、一样高，对齐着排。 */
const BUTTON_STYLE = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '6px',
  minHeight: '28px',
  padding: '3px 12px',
  borderRadius: '6px',
  fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
  lineHeight: '1.4',
  whiteSpace: 'nowrap',
} as const

/** 视图要什么。 */
export type WorkBuddyAccountViewProps = {
  readonly state: WorkBuddyAccountState
  readonly busy?: boolean | undefined
  readonly onLogin?: (() => void) | undefined
  readonly onRefresh?: (() => void) | undefined
  readonly t?: WorkBuddyAccountT | undefined
}

/** 整段的视图要什么：账号那部分 + 模型列表那部分。 */
export type WorkBuddySettingsViewProps = WorkBuddyAccountViewProps & {
  readonly models?: WorkBuddyModelList | undefined
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
export async function readWorkBuddySession(options: {
  readonly fetchImpl?: typeof fetch | undefined
}): Promise<WorkBuddyAccountState> {
  const fetchImpl = options.fetchImpl ?? fetch
  const response = await fetchImpl(WORKBUDDY_SESSION_URL, { method: 'GET' })
  const body = await response.json().catch(() => ({})) as Record<string, unknown>
  if (body['ok'] !== true) {
    const reason = typeof body['error'] === 'string' ? body['error'] : '问不到宿主'
    return { authenticated: false, reason }
  }
  if (body['authenticated'] !== true) return { authenticated: false }
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
export async function beginWorkBuddyLogin(options: {
  readonly fetchImpl?: typeof fetch | undefined
  readonly openUrl?: ((url: string) => void) | undefined
}): Promise<{ ok: boolean; reason?: string }> {
  const fetchImpl = options.fetchImpl ?? fetch
  const open = options.openUrl ?? ((url: string) => { window.open(url, '_blank', 'noopener') })
  const response = await fetchImpl(WORKBUDDY_LOGIN_URL, { method: 'POST' })
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
export async function pollUntilSignedIn(options: {
  readonly fetchImpl?: typeof fetch | undefined
  readonly attempts?: number | undefined
  readonly intervalMs?: number | undefined
  readonly sleepImpl?: ((ms: number) => Promise<void>) | undefined
}): Promise<WorkBuddyAccountState> {
  const attempts = options.attempts ?? 20
  const intervalMs = options.intervalMs ?? 3_000
  const sleep = options.sleepImpl ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  let state: WorkBuddyAccountState = { authenticated: false }
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    state = await readWorkBuddySession({ ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }) })
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
export function workBuddyAccountView(props: WorkBuddyAccountViewProps): ReactNode {
  const t = props.t ?? fallbackT
  const state = props.state
  const children: ReactNode[] = []

  // 账号信息：自己一个框，独占一行。
  children.push(
    <div
      key="box"
      data-workbuddy-account-box={true}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
        padding: '10px 12px',
        border: '1px solid var(--dsw-alias-border-default, rgba(0,0,0,0.12))',
        borderRadius: '8px',
      }}
    >
      {state.authenticated
        ? (
          <>
            <span data-workbuddy-account-state="signed-in">{t('workbuddy.account.signedIn')}</span>
            {state.account?.nickname !== undefined && state.account.nickname !== ''
              ? <strong data-workbuddy-account-name="true">{state.account.nickname}</strong>
              : null}
            {state.account?.uid !== undefined && state.account.uid !== ''
              ? <code data-workbuddy-account-uid="true">{state.account.uid}</code>
              : null}
          </>
        )
        : (
          <>
            <span data-workbuddy-account-state="signed-out">{t('workbuddy.account.signedOut')}</span>
            {state.reason !== undefined && state.reason !== ''
              ? <span data-workbuddy-account-reason="true">{state.reason}</span>
              : null}
          </>
        )}
    </div>,
  )

  // 按钮：登录与检查授权，一样大、留出间距、齐平。
  children.push(
    <div
      key="actions"
      data-workbuddy-account-actions={true}
      style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}
    >
      <button
        type="button"
        data-workbuddy-login={true}
        style={BUTTON_STYLE}
        // 已经登上了就把登录按钮灰掉——两个按钮并排才看得出是一组。
        disabled={props.busy === true || state.authenticated}
        onClick={() => { props.onLogin?.() }}
      >
        {t('workbuddy.account.login')}
      </button>
      <button
        type="button"
        data-workbuddy-refresh={true}
        style={BUTTON_STYLE}
        disabled={props.busy === true}
        onClick={() => { props.onRefresh?.() }}
      >
        {t('workbuddy.account.refresh')}
      </button>
    </div>,
  )

  // 竖着排，每件之间留出间距——挨在一起看着是一坨。
  return (
    <div
      data-workbuddy-account="root"
      style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}
    >
      {children}
    </div>
  )
}

/**
 * 整段的视图：账号那部分在上，模型列表在下。
 * @param props - 账号状态、模型清单与各个动作。
 * @returns 元素树。
 */
export function workBuddySettingsView(props: WorkBuddySettingsViewProps): ReactNode {
  return (
    <div
      data-workbuddy-settings="root"
      style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}
    >
      {workBuddyAccountView(props)}
      {props.models === undefined
        ? null
        : workBuddyModelsView({
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
export function WorkBuddyAccountSection(props: { readonly t?: WorkBuddyAccountT }): ReactNode {
  const [state, setState] = useState<WorkBuddyAccountState>({ authenticated: false })
  const [models, setModels] = useState<WorkBuddyModelList | undefined>(undefined)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    setBusy(true)
    try {
      setState(await readWorkBuddySession({}))
    } catch (error) {
      setState({ authenticated: false, reason: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }, [])

  const reloadModels = useCallback(async () => {
    try {
      setModels(await readWorkBuddyModels({}))
    } catch {
      // 清单拿不到就只留账号那部分（模型列表空着，不挡着别的设置）。
      setModels(undefined)
    }
  }, [])

  useEffect(() => { void refresh(); void reloadModels() }, [refresh, reloadModels])

  const login = useCallback(async () => {
    setBusy(true)
    try {
      const result = await beginWorkBuddyLogin({})
      if (!result.ok) {
        setState({ authenticated: false, reason: result.reason })
        return
      }
      // 授权在浏览器里完成，宿主那边还在轮询；这里连着问几次，登上了就停。
      void pollUntilSignedIn({}).then(signedIn => {
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
    void saveWorkBuddySelection(next).catch(() => undefined)
  }, [models])

  const restoreDefault = useCallback(() => {
    const defaults = models?.default ?? []
    void saveWorkBuddySelection(defaults).catch(() => undefined)
  }, [models])

  return workBuddySettingsView({
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

/** 设置侧栏的插槽面。 */
export type WorkBuddyAccountSlotHost = {
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
export function registerWorkBuddyAccountSection(
  slots: WorkBuddyAccountSlotHost,
  label: () => string,
  t?: WorkBuddyAccountT,
): void {
  slots.inject('settings.section', () => slots.register(
    {
      name: 'settings.section',
      id: WORKBUDDY_ACCOUNT_SECTION_ID,
      order: WORKBUDDY_ACCOUNT_SECTION_ORDER,
      label,
      locale: NAMESPACE,
      inject: () => ({ t }),
    },
    WorkBuddyAccountSection,
  ))
}
