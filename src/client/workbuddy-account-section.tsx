/**
 * 设置里的「WorkBuddy 账号」段。
 *
 * 这一段只做两件事：问宿主「登了没」，以及在没登录时给一个能点开的授权地址。
 * 令牌不出宿主，所以浏览器这一侧从头到尾没有令牌——视图不读、应答里也不该有。
 *
 * 视图是纯函数（可以直接断言形状），组件只负责取数与重画。
 */

import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { NAMESPACE, fallbackT } from './locales.ts'

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

/** 视图要什么。 */
export type WorkBuddyAccountViewProps = {
  readonly state: WorkBuddyAccountState
  readonly busy?: boolean | undefined
  readonly onLogin?: (() => void) | undefined
  readonly onRefresh?: (() => void) | undefined
  readonly t?: WorkBuddyAccountT | undefined
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

  if (state.authenticated) {
    const nickname = state.account?.nickname
    const uid = state.account?.uid ?? ''
    children.push(
      <div key="who" data-workbuddy-account="signed-in">
        <span>{t('workbuddy.account.signedIn')}</span>
        {nickname !== undefined && nickname !== '' ? <strong>{nickname}</strong> : null}
        {uid !== '' ? <code>{uid}</code> : null}
      </div>,
    )
  } else {
    children.push(
      <div key="ask" data-workbuddy-account="signed-out">
        <span>{t('workbuddy.account.signedOut')}</span>
        {state.reason !== undefined && state.reason !== ''
          ? <span data-workbuddy-reason="true">{state.reason}</span>
          : null}
      </div>,
    )
  }

  children.push(
    <div key="actions">
      {state.authenticated
        ? null
        : (
          <button
            key="login"
            type="button"
            data-workbuddy-login={true}
            disabled={props.busy === true}
            onClick={() => { props.onLogin?.() }}
          >
            {t('workbuddy.account.login')}
          </button>
        )}
      <button
        key="refresh"
        type="button"
        data-workbuddy-refresh={true}
        disabled={props.busy === true}
        onClick={() => { props.onRefresh?.() }}
      >
        {t('workbuddy.account.refresh')}
      </button>
    </div>,
  )

  return <div data-workbuddy-account="root">{children}</div>
}

/** 组件：取一次状态，之后由两个动作驱动。 */
export function WorkBuddyAccountSection(props: { readonly t?: WorkBuddyAccountT }): ReactNode {
  const [state, setState] = useState<WorkBuddyAccountState>({ authenticated: false })
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

  useEffect(() => { void refresh() }, [refresh])

  const login = useCallback(async () => {
    setBusy(true)
    try {
      const result = await beginWorkBuddyLogin({})
      if (!result.ok) {
        setState({ authenticated: false, reason: result.reason })
        return
      }
      // 授权在浏览器里完成，宿主那边还在轮询；过一会儿再问一次状态。
      setTimeout(() => { void refresh() }, 3_000)
    } finally {
      setBusy(false)
    }
  }, [refresh])

  return workBuddyAccountView({
    state,
    busy,
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
