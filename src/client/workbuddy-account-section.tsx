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
  ACCOUNT_ACTIONS_STYLE,
  ACCOUNT_BOX_STYLE,
  ACCOUNT_BUTTON_STYLE,
  ACCOUNT_COLUMN_STYLE,
} from './account-panel.tsx'
import {
  readModelChecklist,
  saveModelChecklist,
  modelChecklistView,
} from './model-checklist.tsx'
import type { ModelChecklistState } from './model-checklist.tsx'

/** 设置里的行 id。 */
export const WORKBUDDY_ACCOUNT_SECTION_ID = 'acp-agent-workbuddy-account'

/** 行在设置侧栏里的顺序。 */
export const WORKBUDDY_ACCOUNT_SECTION_ORDER = 120

/** 宿主路由路径（与宿主侧那几条一致）。 */
export const WORKBUDDY_SESSION_URL = '/acp-agent/workbuddy/session'
export const WORKBUDDY_LOGIN_URL = '/acp-agent/workbuddy/login'
export const WORKBUDDY_MODELS_URL = '/acp-agent/workbuddy/models'
export const WORKBUDDY_CHECKIN_URL = '/acp-agent/workbuddy/checkin'

/** 账号状态：只认「登了没」与「是谁」，没有令牌。 */
export type WorkBuddyAccountState = {
  readonly authenticated: boolean
  readonly account?: { readonly uid: string; readonly nickname?: string | undefined } | undefined
  readonly reason?: string | undefined
}

/** 签到状态：宿主给的那几件事。 */
export type WorkBuddyCheckinStatus = {
  readonly active: boolean
  readonly todayCheckedIn: boolean
  readonly streakDays: number
  readonly dailyCredit: number
  readonly todayCredit: number
  readonly isStreakDay: boolean
}

/** 浏览器这一侧看到的签到状态。 */
export type WorkBuddyCheckinState = {
  /** 今天签了没（连着多少天、每天多少积分）。 */
  readonly status?: WorkBuddyCheckinStatus | undefined
  /** 拿不到时的原因。 */
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

/** 整段的视图要什么：账号那部分 + 模型列表那部分。 */
export type WorkBuddySettingsViewProps = WorkBuddyAccountViewProps & {
  readonly models?: ModelChecklistState | undefined
  readonly query?: string | undefined
  readonly onQueryChange?: ((value: string) => void) | undefined
  readonly onToggle?: ((id: string, checked: boolean) => void) | undefined
  readonly onRestoreDefault?: (() => void) | undefined
  /** 签到状态与「立即签到」。 */
  readonly checkin?: WorkBuddyCheckinState | undefined
  readonly onCheckinClaim?: (() => void) | undefined
}

/** 签到那一段的视图要什么。 */
export type WorkBuddyCheckinViewProps = {
  readonly status?: WorkBuddyCheckinStatus | undefined
  readonly busy?: boolean | undefined
  readonly message?: string | undefined
  readonly onClaim?: (() => void) | undefined
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
 * 问宿主「今天签了没」。
 *
 * 宿主那边已经把没登录、拿不到这些都折成了 `ok:false` + 原因，这里照原样带回来。
 * @param options - fetch 实现（测试注入）。
 * @returns 签到状态。
 */
export async function readWorkBuddyCheckin(options: {
  readonly fetchImpl?: typeof fetch | undefined
}): Promise<WorkBuddyCheckinState> {
  const fetchImpl = options.fetchImpl ?? fetch
  const response = await fetchImpl(WORKBUDDY_CHECKIN_URL, { method: 'GET' })
  const body = await response.json().catch(() => ({})) as Record<string, unknown>
  if (body['ok'] !== true) {
    const reason = typeof body['reason'] === 'string' ? body['reason'] : '问不到宿主'
    return { reason }
  }
  const raw = body['status']
  if (typeof raw !== 'object' || raw === null) return {}
  const record = raw as Record<string, unknown>
  return {
    status: {
      active: record['active'] === true,
      todayCheckedIn: record['todayCheckedIn'] === true,
      streakDays: typeof record['streakDays'] === 'number' ? record['streakDays'] : 0,
      dailyCredit: typeof record['dailyCredit'] === 'number' ? record['dailyCredit'] : 0,
      todayCredit: typeof record['todayCredit'] === 'number' ? record['todayCredit'] : 0,
      isStreakDay: record['isStreakDay'] === true,
    },
  }
}

/**
 * 手动领一次当天积分。
 * @param options - fetch 实现（测试注入）。
 * @returns 宿主给的结果：领到了多少、还是今天已经领过了。
 */
export async function claimWorkBuddyCheckin(options: {
  readonly fetchImpl?: typeof fetch | undefined
}): Promise<{ claimed: boolean; alreadyClaimed: boolean; credit: number; streakDays: number; message?: string | undefined }> {
  const fetchImpl = options.fetchImpl ?? fetch
  const response = await fetchImpl(WORKBUDDY_CHECKIN_URL, { method: 'POST' })
  const body = await response.json().catch(() => ({})) as Record<string, unknown>
  if (body['ok'] !== true) {
    const reason = typeof body['reason'] === 'string' ? body['reason'] : '签到没成功'
    return { claimed: false, alreadyClaimed: false, credit: 0, streakDays: 0, message: reason }
  }
  const message = typeof body['message'] === 'string' ? body['message'] : undefined
  return {
    claimed: body['claimed'] === true,
    alreadyClaimed: body['alreadyClaimed'] === true,
    credit: typeof body['credit'] === 'number' ? body['credit'] : 0,
    streakDays: typeof body['streakDays'] === 'number' ? body['streakDays'] : 0,
    ...(message === undefined ? {} : { message }),
  }
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
      style={ACCOUNT_BOX_STYLE}
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
      style={ACCOUNT_ACTIONS_STYLE}
    >
      {/* 已登录时不摆登录按钮：杵在那儿的「重新登录」看着就是在催你登录。 */}
      {state.authenticated
        ? null
        : (
          <button
            type="button"
            data-workbuddy-login={true}
            style={ACCOUNT_BUTTON_STYLE}
            disabled={props.busy === true}
            onClick={() => { props.onLogin?.() }}
          >
            {t('workbuddy.account.login')}
          </button>
        )}
      <button
        type="button"
        data-workbuddy-refresh={true}
        style={ACCOUNT_BUTTON_STYLE}
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
      style={ACCOUNT_COLUMN_STYLE}
    >
      {children}
    </div>
  )
}

/**
 * 画签到那一段。
 *
 * 没登录就不画（`null`）：这一段只在登录之后才有意义。已签则按钮不再给点。
 * @param props - 签到状态、忙碌标记与「立即签到」的动作。
 * @returns 元素树；没状态时是 `null`。
 */
export function workBuddyCheckinView(props: WorkBuddyCheckinViewProps): ReactNode {
  const t = props.t ?? fallbackT
  const status = props.status
  if (status === undefined) return null
  const claimed = status.todayCheckedIn
  return (
    <div
      data-workbuddy-checkin="root"
      style={ACCOUNT_BOX_STYLE}
    >
      <span data-workbuddy-checkin-state={claimed ? 'claimed' : 'pending'}>
        {claimed
          ? t('workbuddy.checkin.claimed', { streakDays: status.streakDays, dailyCredit: status.dailyCredit })
          : t('workbuddy.checkin.pending', { dailyCredit: status.dailyCredit })}
      </span>
      {props.message !== undefined && props.message !== ''
        ? <span data-workbuddy-checkin-message="true">{props.message}</span>
        : null}
      <button
        type="button"
        data-workbuddy-checkin-claim={true}
        style={ACCOUNT_BUTTON_STYLE}
        // 今天已经领过了就别再给点——再点一次站点也只是回一句「已签到」。
        disabled={claimed || props.busy === true}
        onClick={() => { props.onClaim?.() }}
      >
        {t(claimed ? 'workbuddy.checkin.alreadyClaimed' : 'workbuddy.checkin.claim')}
      </button>
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
      {workBuddyCheckinView({
        ...(props.checkin?.status === undefined ? {} : { status: props.checkin.status }),
        ...(props.busy === undefined ? {} : { busy: props.busy }),
        ...(props.onCheckinClaim === undefined ? {} : { onClaim: props.onCheckinClaim }),
        ...(props.t === undefined ? {} : { t: props.t }),
      })}
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
export function WorkBuddyAccountSection(props: { readonly t?: WorkBuddyAccountT }): ReactNode {
  const [state, setState] = useState<WorkBuddyAccountState>({ authenticated: false })
  const [models, setModels] = useState<ModelChecklistState | undefined>(undefined)
  const [checkin, setCheckin] = useState<WorkBuddyCheckinState>({})
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

  const reloadCheckin = useCallback(async () => {
    try {
      setCheckin(await readWorkBuddyCheckin({}))
    } catch {
      // 签到状态拿不到就不显示这一段（不影响账号与模型列表）。
      setCheckin({})
    }
  }, [])

  const reloadModels = useCallback(async () => {
    try {
      setModels(await readModelChecklist(WORKBUDDY_MODELS_URL, {}))
    } catch {
      // 清单拿不到就只留账号那部分（模型列表空着，不挡着别的设置）。
      setModels(undefined)
    }
  }, [])

  useEffect(() => { void refresh(); void reloadModels(); void reloadCheckin() }, [refresh, reloadModels, reloadCheckin])

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

  const claimCheckin = useCallback(async () => {
    setBusy(true)
    try {
      const result = await claimWorkBuddyCheckin({})
      if (result.alreadyClaimed) {
        setCheckin(current => ({
          ...current,
          status: current.status === undefined
            ? undefined
            : { ...current.status, todayCheckedIn: true },
          reason: undefined,
        }))
        return
      }
      if (!result.claimed) {
        setCheckin(current => ({ ...current, reason: result.message }))
        return
      }
      // 领到了：状态立刻跟上，别让人还看见「今日未签」。
      setCheckin(current => ({
        ...current,
        status: current.status === undefined
          ? undefined
          : {
            ...current.status,
            todayCheckedIn: true,
            todayCredit: result.credit,
            streakDays: result.streakDays,
          },
        reason: undefined,
      }))
    } catch (error) {
      setCheckin(current => ({ ...current, reason: error instanceof Error ? error.message : String(error) }))
    } finally {
      setBusy(false)
    }
  }, [])

  const toggle = useCallback((id: string, checked: boolean) => {
    const current = models?.selected ?? []
    const next = checked
      ? [...current.filter(item => item !== id), id]
      : current.filter(item => item !== id)
    setModels(models === undefined ? undefined : { ...models, selected: next, custom: true })
    void saveModelChecklist(WORKBUDDY_MODELS_URL, next, {}).catch(() => undefined)
  }, [models])

  const restoreDefault = useCallback(() => {
    const defaults = models?.default ?? []
    void saveModelChecklist(WORKBUDDY_MODELS_URL, defaults, {}).catch(() => undefined)
  }, [models])

  return workBuddySettingsView({
    state,
    busy,
    ...(models === undefined ? {} : { models }),
    checkin,
    query,
    onQueryChange: (value: string) => { setQuery(value) },
    onToggle: (id, checked) => { toggle(id, checked) },
    onRestoreDefault: () => { restoreDefault() },
    onLogin: () => { void login() },
    onRefresh: () => { void refresh() },
    onCheckinClaim: () => { void claimCheckin() },
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
