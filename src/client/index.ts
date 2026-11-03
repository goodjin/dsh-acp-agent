/**
 * Browser-side plugin entry for the ACP agent framework.
 *
 * Registers the agent-related UI surfaces into DSH's client slots:
 * - Model label (composer)
 * - Quota pills (below composer)
 * - ACP visibility panel (settings section)
 * - Handover card (agent switch notification)
 * - Switch progress bar
 * - Interrupted turn recovery
 * - ACP process view (session area)
 * - Markdown turn readers (session area)
 * - Mermaid diagrams (session area)
 * - Lost input surface
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { PropsRuntime, SlotCore, SlotMap } from '@deepseek-ai/dsh-client-ui-slots'

import { registerModelLabel } from './model-label.tsx'
import { createQuotaPoller, registerQuotaDockPills, routeQuotaFetcher } from './quota-pill.ts'
import type { QuotaPillServices } from './quota-pill.ts'
import { registerInterruptedTurnRecovery } from './interrupted-turn-recovery.ts'
import { registerAcpVisibilitySection } from './acp-visibility-panel.tsx'
import { startAcpVisibility } from './acp-visibility.ts'
import type { AcpVisibilityStore } from './acp-visibility.ts'
import { createAcpCatalogStore } from './acp-visibility-catalog.ts'
import { installAcpVisibilityFilter } from './acp-visibility-filter.ts'
import { AgentSwitchHandoverCard, agentSwitchHandoverDefinition, registerAgentSwitchHandoverSurface } from './handover-card.ts'
import { registerLostInputSurface } from './lost-input.ts'
import { registerAcpProcessSurface } from './acp-process-surface.tsx'
import { createSwitchProgressStore, startSwitchProgressSurface } from './switch-progress.ts'
import { NAMESPACE, en, fallbackT, zh } from './locales.ts'
import type { RuntimeT } from './locales.ts'
import { createElement } from 'react'

export type ClientPanelContext = ClientContext & {
  readonly locale?: {
    readonly register?: (dictionaries: Record<string, unknown>) => void
  }
}

export const inject = ['slots', 'remote', 'remote.settings', 'remote.session', 'remote.workspaceFiles', 'uiConversation', 'uiWorkspace', 'sessions', 'locale']

type Log = (message: string) => void

function propertyOf(obj: unknown, name: string): unknown {
  return obj === null || obj === undefined ? undefined : (obj as unknown as Record<string, unknown>)[name]
}

function boundMethod(obj: unknown, name: string): Function | undefined {
  const fn = propertyOf(obj, name)
  return typeof fn === 'function' ? (fn as Function) : undefined
}

function readService(ctx: ClientContext, name: string): unknown {
  try {
    return ctx.get(name)
  } catch {
    return undefined
  }
}

function safeRegister(label: string, fn: () => void | (() => void), log: Log): void {
  try {
    fn()
  } catch (error) {
    log(`${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function apply(ctx: any, _config: unknown, log?: Log): () => void {
  const t: RuntimeT = (key, params) => fallbackT(key, params)
  // cordis 只把 (ctx, config) 交给插件，第三个参数从来没有人传。少了这个兜底，
  // 任何一处 safeRegister 报错都会在 catch 里再抛一个 TypeError——整条客户端
  // entry 变成 failed，而 boot 的 activation audit 会连带把整个页面判成失败。
  // 也就是说：一个本可以只丢一个表面的错误，会变成打不开界面。
  const say: Log = typeof log === 'function'
    ? log
    : (message: string) => { console.warn(`[threadharbor] ${message}`) }

  // 注册本插件的词典。
  //
  // 签名是 `register(namespace, { locale: dict })`：早先按 `register({ [NS]: {...} })`
  // 单参数调用，namespace 位置收到的是对象、第二参数是 undefined，内部
  // `Object.entries(undefined)` 直接抛 TypeError——被下面这层 try 吞掉，于是座位里
  // 的 `t` 永远解析不到词条，界面上看到的是 `quota.fiveHour.label` 这样的键名。
  // 词典本身带 disposer，挂到 ctx.effect 上，热替换时随插件一起撤。
  const registerLocale = propertyOf(ctx, 'locale')
  if (registerLocale !== undefined && typeof registerLocale === 'object') {
    const register = propertyOf(registerLocale, 'register')
    if (typeof register === 'function') {
      try {
        const dispose = (register as Function).call(registerLocale, NAMESPACE, { zh: { ...zh }, en: { ...en } })
        const effect = boundMethod(ctx, 'effect')
        if (typeof dispose === 'function' && effect !== undefined) {
          (effect as Function).call(ctx, () => dispose, 'threadharbor: locale dictionaries')
        }
      } catch (error) {
        // 重复注册（同一命名空间已有该语言）也会抛：说一声，别静默。
        say(`locale dictionaries: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  // Model label in composer
  safeRegister('model label', () => {
    const dispose = registerModelLabel(ctx.slots)
    return dispose
  }, say)

  // Quota pills below composer
  safeRegister('quota pills', () => {
    const fetchQuota = routeQuotaFetcher(fetch)
    const poller = createQuotaPoller({ fetchQuota })
    // 这两个服务由别的插件提供，apply 这一刻未必已经起来：快照下来会永久是
    // undefined，胶囊就判断不了当前模型而整枚不显示——而且只在装配顺序不利时
    // 复现（2026-11-03 的症状）。用 getter 让每次渲染读到当下的服务实例。
    const services: Partial<QuotaPillServices> = {
      get modelDirectories() {
        return ctx.get('modelDirectories') as QuotaPillServices['modelDirectories']
      },
      get sessions() {
        return ctx.get('sessions') as QuotaPillServices['sessions']
      },
    }
    const dispose = registerQuotaDockPills(ctx.slots, poller, services)
    return dispose
  }, say)

  // Interrupted turn recovery
  safeRegister('interrupted turn recovery', () => {
    return registerInterruptedTurnRecovery(ctx)
  }, say)

  // Handover card (agent switch notification)
  safeRegister('handover card', () => {
    const dispose = registerAgentSwitchHandoverSurface(ctx)
    return dispose
  }, say)

  // Lost input surface
  safeRegister('lost input', () => {
    return registerLostInputSurface(ctx)
  }, say)

  // ACP process view
  safeRegister('acp process surface', () => {
    return registerAcpProcessSurface(ctx)
  }, say)

  // Switch progress bar
  safeRegister('switch progress', () => {
    const store = createSwitchProgressStore()
    startSwitchProgressSurface({ ctx: ctx, store, slots: (ctx).slots })
    return () => {}
  }, say)

  // ACP visibility: store + catalog + filter + settings section
  safeRegister('acp visibility', () => {
    const storage = { getItem: (k: string) => localStorage.getItem(k), setItem: (k: string, v: string) => localStorage.setItem(k, v) }
    const visibility = startAcpVisibility(storage, (msg) => say(`acp visibility: ${msg}`))
    // 目录 store 要的是「读一次目录」的函数，不是 ctx：早先这里传了 ctx，于是
    // store 里 `read()` 调的是那个对象 → TypeError，设置页永远显示
    // 「读取模型目录失败：e is not a function」（2026-11-03 现场，压缩后的名字）。
    const catalog = createAcpCatalogStore(catalogReaderOf(ctx))
    const report: Log = (msg) => say(`acp visibility: ${msg}`)

    // Install picker filter
    mountAcpVisibilityFilter(ctx, visibility, report)

    // Register settings section
    const slots = (ctx as { slots: unknown }).slots
    const face: Record<string, unknown> = { visibility, catalog, t }
    const reader = catalogReaderOf(ctx)
    if (reader !== undefined) face.catalogReader = reader
    registerAcpVisibilitySection(slots as never, face as never, () => t('acpVisibility.label'))

    return () => {}
  }, say)

  return () => {}
}

function mountAcpVisibilityFilter(
  ctx: any,
  visibility: AcpVisibilityStore,
  report: Log,
): void {
  const attach = (service: unknown, effect: (dispose: () => void) => void): void => {
    const dispose = installAcpVisibilityFilter(service, visibility, report)
    if (dispose !== undefined) effect(dispose)
  }
  const injector = (ctx as any).inject
  if (typeof injector === 'function') {
    (injector as Function).call(ctx, ['modelDirectories'], (child: unknown) => {
      const childEffect = boundMethod(child, 'effect')
      attach(propertyOf(child, 'modelDirectories'), dispose => {
        if (childEffect !== undefined) childEffect(() => dispose)
        else (ctx as any).effect(() => dispose, 'threadharbor: acp visibility picker filter')
      })
    })
    return
  }
  let service: unknown
  try {
    service = ctx.get('modelDirectories')
  } catch {
    service = undefined
  }
  attach(service, dispose => {
    (ctx as any).effect(() => dispose, 'threadharbor: acp visibility picker filter')
  })
}

function catalogReaderOf(ctx: ClientPanelContext): (() => Promise<unknown>) | undefined {
  const direct = readService(ctx, 'remote.session')
  const session = direct ?? propertyOf(readService(ctx, 'remote'), 'session')
  const read = boundMethod(session, 'modelCatalog')
  return read === undefined ? undefined : async () => await read.call(session)
}
