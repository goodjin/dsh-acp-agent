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
import type { WorkBuddyAccountSlotHost } from './workbuddy-account-section.tsx'

/** 设置里的行 id。 */
export const QODER_ACCOUNT_SECTION_ID = 'acp-agent-qoder-account'

/** 行在设置侧栏里的顺序。 */
export const QODER_ACCOUNT_SECTION_ORDER = 121

/** 宿主路由路径（与宿主侧那两条一致）。 */
export const QODER_SESSION_URL = '/acp-agent/qoder-global/session'
export const QODER_LOGIN_URL = '/acp-agent/qoder-global/login'

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
  const children: ReactNode[] = []

  if (state.authenticated) {
    const nickname = state.account?.nickname
    const uid = state.account?.uid ?? ''
    children.push(
      <div key="who" data-qoder-account="signed-in">
        <span>{t('qoder.account.signedIn')}</span>
        {nickname !== undefined && nickname !== '' ? <strong>{nickname}</strong> : null}
        {uid !== '' ? <code>{uid}</code> : null}
      </div>,
    )
  } else {
    children.push(
      <div key="ask" data-qoder-account="signed-out">
        <span>{t('qoder.account.signedOut')}</span>
        {state.reason !== undefined && state.reason !== ''
          ? <span data-qoder-reason="true">{state.reason}</span>
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
            data-qoder-login={true}
            disabled={props.busy === true}
            onClick={() => { props.onLogin?.() }}
          >
            {t('qoder.account.login')}
          </button>
        )}
      <button
        key="refresh"
        type="button"
        data-qoder-refresh={true}
        disabled={props.busy === true}
        onClick={() => { props.onRefresh?.() }}
      >
        {t('qoder.account.refresh')}
      </button>
    </div>,
  )

  return <div data-qoder-account="root">{children}</div>
}

/** 组件：取一次状态，之后由两个动作驱动。 */
export function QoderAccountSection(props: { readonly t?: QoderAccountT }): ReactNode {
  const [state, setState] = useState<QoderAccountState>({ authenticated: false })
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

  useEffect(() => { void refresh() }, [refresh])

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

  return qoderAccountView({
    state,
    busy,
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
  slots: WorkBuddyAccountSlotHost,
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
