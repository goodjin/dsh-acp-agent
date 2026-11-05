import { createElement, useCallback, useEffect, useState, type ComponentType } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConversationNodeDefinition, ConversationViewDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import { acpProcessDefinition } from './acp-process-segments.ts'
import { wrapChatView } from './acp-process-view.ts'
import type { SegmentChatData } from './acp-process-view.ts'
import type { ProcessSegment } from './acp-process-segments.ts'
import { defaultLinkOpenMode, httpLinkHref, openInBrowser } from './link-open.ts'
import styles from './acp-process.module.css'

/**
 * ACP 进程段的宿主半边。
 *
 * 这里只做两件 ACP 专属的事：
 * 1. 把 chat 视图的 builder 包一层（`wrapChatView`），把带 ACP 段的助手步投影成
 *    带 `acpProcessSegment` 的节点；并注册 `acpProcessDefinition` 折叠 ACP 事件。
 * 2. 把进程段渲染器 `AcpProcessComponent` 注册进座位
 *    {@link SEGMENT_RENDERER_SLOT}，由 `@goodjin2/dsh-chat-area` 的
 *    `assistant-step` 包装在渲染时取用（见 conversation-surfaces.tsx 的说明）。
 *
 * 通用的答案卡片与会话尾部文件卡片 2026-11 迁去了 chat-area；本包不再包
 * `assistant-step`、也不再管答案步。
 */

/**
 * ACP 进程段渲染器的座位名。必须与 chat-area 的 `conversation-surfaces.tsx` 里的
 * `SEGMENT_RENDERER_SLOT` 字面一致（跨包不能共享常量）。
 */
export const SEGMENT_RENDERER_SLOT = 'conversation.chat.node.acp-segment-renderer'

/**
 * 文本块渲染结果：http(s) 链接 hover 时浮出「右侧打开 / 浏览器打开」两个按钮，
 * 单击链接走默认打开方式（存 localStorage，见 link-open.ts）。
 *
 * 编译包 `MarkdownText` 把 http(s) 渲染成普通 `<a target="_blank">`，无法注入 React，
 * 所以这里给容器叠 DOM 层：`mouseover` 识别指针下的链接并在其旁浮出工具条，`mouseout`
 * 离开后隐藏；`onClick` 在默认=浏览器时拦截并 `window.open`，默认=右侧时不拦截、让宿主
 * 右侧预览面板接管。
 */
function LinkTextBlock({ text, labels }: { readonly text: string; readonly labels: MarkdownLabels }) {
  const [hovered, setHovered] = useState<{ url: string; top: number; left: number } | null>(null)

  const hideTools = useCallback(() => setHovered(null), [])

  const onOver = useCallback((event: React.MouseEvent) => {
    const target = event.target as Element | null
    const anchor = target === null ? null : target.closest('a')
    if (anchor === null) return
    const url = httpLinkHref(anchor.getAttribute('href'))
    if (url === null) return
    const rect = anchor.getBoundingClientRect()
    setHovered({ url, top: rect.bottom + 4, left: rect.left })
  }, [])

  const onOut = useCallback((event: React.MouseEvent) => {
    // 指针移到工具条自身时不隐藏（工具条是容器兄弟，在容器外）。
    if ((event.relatedTarget as Element | null)?.closest?.('[data-link-tools]') !== null) return
    const from = event.target as Element | null
    const fromAnchor = from === null ? null : from.closest('a')
    const toAnchor = (event.relatedTarget as Element | null)?.closest('a') ?? null
    if (fromAnchor !== null && fromAnchor === toAnchor) return
    hideTools()
  }, [hideTools])

  const onClick = useCallback((event: React.MouseEvent) => {
    const target = event.target as Element | null
    const anchor = target === null ? null : target.closest('a')
    if (anchor === null) return
    const url = httpLinkHref(anchor.getAttribute('href'))
    if (url === null) return
    if (defaultLinkOpenMode() !== 'browser') return
    event.preventDefault()
    openInBrowser(url)
    hideTools()
  }, [hideTools])

  useEffect(() => {
    if (hovered === null) return
    const onScrollOrResize = () => hideTools()
    window.addEventListener('scroll', onScrollOrResize, true)
    window.addEventListener('resize', onScrollOrResize)
    return () => {
      window.removeEventListener('scroll', onScrollOrResize, true)
      window.removeEventListener('resize', onScrollOrResize)
    }
  }, [hovered, hideTools])

  return (
    <div
      data-link-text-block=""
      onMouseOver={onOver}
      onMouseOut={onOut}
      onClick={onClick}
    >
      <MarkdownText text={text} streaming={false} labels={labels} />
      {hovered !== null && (
        <div className={styles.linkTools} data-link-tools={hovered.url} style={{ top: hovered.top, left: hovered.left }}>
          <button
            type="button"
            className={styles.linkTool}
            data-link-action="right"
            onClick={(event) => { event.preventDefault(); event.stopPropagation(); hideTools() }}
          >
            右侧打开
          </button>
          <button
            type="button"
            className={styles.linkTool}
            data-link-action="browser"
            onClick={(event) => { event.preventDefault(); event.stopPropagation(); openInBrowser(hovered.url); hideTools() }}
          >
            浏览器打开
          </button>
        </div>
      )}
    </div>
  )
}

/** The segment is one presentation unit; individual deltas never create separate rows. */
export function AcpProcessBlock({ segment, t }: { readonly segment: ProcessSegment; readonly t: ChatNodeViewProps<'assistant-step'>['t'] }) {
  // The running host adds these shared Chat labels after the pinned 0.2.0 types.
  const translate = t as (key: string) => string
  const labels = {
    code: { copyLabel: translate('copy'), copiedLabel: translate('copied'), toolbarLabels: { codeLabel: translate('codeBlock.title'), wrapLabel: translate('codeBlock.wrap'), unwrapLabel: translate('codeBlock.unwrap') } },
    footnotes: translate('markdown.footnotes'),
  }
  return <div className={styles.segment} data-acp-process-segment={segment.callId}>
    {segment.blocks.map((block, index) => <div key={index} className={block.kind === 'reasoning' ? styles.reasoning : undefined}>
      {block.kind === 'text'
        ? <LinkTextBlock text={block.text ?? ''} labels={labels} />
        : <MarkdownText text={block.text} streaming={false} labels={labels} />}
    </div>)}
  </div>
}

type Surface = {
  readonly slots: unknown
  get(name: string): unknown
  effect(callback: () => (() => void), name?: string): unknown
}
type Registry = {
  views: { entries(): readonly ConversationViewDefinition[]; subscribe(fn: () => void): () => void }
  events: { register(definition: ConversationNodeDefinition): () => void }
}
type NodeSlotEntry = {
  options: Record<string, unknown>
  component: unknown
  locale?: string
  inject?: unknown
  key?: string
  priority?: number
}
type NodeSlots = {
  entries(key: string): readonly NodeSlotEntry[]
  subscribe(key: string, fn: () => void): () => void
  register(options: Record<string, unknown>, component: unknown): () => void
  inject(key: string, callback: () => unknown): unknown
}
type AssistantStepProps = Record<string, any>

/**
 * 本包兜底 wrap 的优先级。跨包只能靠字面量对齐：chat-area 用 -50 并恒在外层，
 * 本包用 -40（数值更低=更外层，插槽取「大闸里最低优先级的渲染」）。
 * 改这里就得改 chat-area 的 `ACP_AGENT_FALLBACK_PRIORITY`，两边各有测试钉住。
 */
export const ASSISTANT_STEP_FALLBACK_PRIORITY = -40

/**
 * 注册 ACP 进程表面：包 chat 视图（注入 `acpProcessSegment`）+ 包 `assistant-step`
 * 渲染 ACP 段（独立运行时）+ 把 ACP 段渲染器挂到跨包座位。
 *
 * 本函数做两件事，且**只有 chat-area 声明座位**：
 * 1. 包 `assistant-step`（priority -40），遇到 `acpProcessSegment` 渲染
 *    `AcpProcessBlock`，非 ACP 段调原生——保证只装 acp-agent 时 ACP 段完整渲染。
 * 2. 把 `AcpProcessBlock` 注册进 `SEGMENT_RENDERER_SLOT`；座位由
 *    `@goodjin2/dsh-chat-area` 声明（它包 `assistant-step` 用 -50，恒在本层之外），
 *    它渲染 ACP 段时就从这里取组件。注册必须带座位名：座位是父行 `children`
 *    表里声明的子槽，只给 id/order 会以 `name: undefined` 去查表并被拒。
 *
 * 错误边界：本包交给宿主的回调（座位 inject、插槽 subscribe、视图 subscribe）
 * 都在**别人的调用栈**里执行；抛出去会打断对方的注册流程，2026-11-05 就是这样
 * 把同时声明座位的 chat-area 判成 failed、整页起不来。因此这些回调与返回的
 * 卸载函数一律就地吞错、只记一条日志，本包的故障不外溢。
 *
 * 为什么本包**不**声明座位：一个插槽只能有一个声明者，后声明的会抛
 * 「already-declared child key」。两边都声明时结果取决于装配顺序——一种顺序答案
 * 卡片正常，另一种顺序它整块消失、还抛一条被 try/catch 吞掉的错误。座位是
 * chat-area 的插槽契约，声明权归它。
 *
 * 优先级约定（跨包，只能靠字面量与测试对表）：chat-area -50 < 本包 -40，
 * 「数值最低的渲染」，所以 chat-area 在外层；只装本包时座位没人声明，本层生效。
 */
export function registerAcpProcessSurface(ctx: Surface, report?: (message: string) => void): void {
  const say = (message: string): void => {
    if (report !== undefined) report(message)
    else if (typeof console !== 'undefined') console.warn(`[acp-agent] ${message}`)
  }
  const ui = ctx.get('uiConversation') as Registry | undefined
  const slots = ctx.slots as NodeSlots
  if (typeof ui?.views?.entries !== 'function' || typeof ui.views.subscribe !== 'function'
    || typeof ui.events?.register !== 'function' || typeof slots?.entries !== 'function'
    || typeof slots.subscribe !== 'function' || typeof slots.register !== 'function') return
  ctx.effect(() => {
    let active: ConversationViewDefinition | undefined
    let restore: (() => void) | undefined
    let removeDefinition: (() => void) | undefined
    // 下面几个回调都是交给宿主、在**别人的调用栈**里执行的：抛出去会打断调用方的
    // 注册流程（2026-11-05 现场：本包的座位回调抛错，把同时声明座位的 chat-area
    // 判成 failed，整页启动失败）。所以一律就地吞掉，只留一条日志。
    const attachView = (): void => {
      try {
        const view = ui.views.entries().find(candidate => candidate.target === 'chat')
        if (view === undefined || view === active) return
        restore?.()
        active = view
        restore = wrapChatView(view)
        // Registration invalidates existing builders too, including already open tabs.
        removeDefinition?.()
        removeDefinition = ui.events.register(acpProcessDefinition as ConversationNodeDefinition)
      } catch (error) {
        say(`acp process view: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const unsubscribeView = ui.views.subscribe(attachView)
    attachView()

    // 包 `assistant-step`：遇到 ACP 段渲染 `AcpProcessBlock`，非 ACP 段调原生。
    // priority -40：chat-area 用 -50（更低=更外层）先分派，本层只在它缺席时生效。
    let removeWrap: (() => void) | undefined
    let originalComponent: unknown
    let installing = false
    const attachWrap = (): void => {
      if (installing) return
      try {
        const entry = slots.entries('conversation.chat.node').find(
          candidate => candidate.options.key === 'assistant-step' && (candidate.options.priority as number | undefined ?? 0) >= 0,
        )
        if (entry === undefined || entry.component === originalComponent) return
        installing = true
        try {
          removeWrap?.()
          originalComponent = entry.component
          const Native = entry.component as ComponentType<AssistantStepProps>
          const Renderer = (props: AssistantStepProps) => {
            const segment = (props.node?.data as SegmentChatData | undefined)?.acpProcessSegment
            if (segment !== undefined) return createElement(AcpProcessBlock, { segment, t: props.t })
            return createElement(Native, props)
          }
          removeWrap = slots.register({
            name: 'conversation.chat.node', key: 'assistant-step', priority: ASSISTANT_STEP_FALLBACK_PRIORITY,
            ...(entry.locale === undefined ? {} : { locale: entry.locale }),
            ...(entry.inject === undefined ? {} : { inject: entry.inject }),
          }, Renderer)
        } finally { installing = false }
      } catch (error) {
        say(`acp process wrap: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const unsubscribeWrap = slots.subscribe('conversation.chat.node', attachWrap)
    attachWrap()

    // 把 ACP 段渲染器挂到座位：座位由 chat-area 声明，它在外层渲染时从这里取组件。
    // 只装本包时座位永远没人声明，这个 inject 就一直不触发——无害，本包的 wrap 兜底。
    // 注册必须带座位名（`name`）：座位是 chat-area 声明的**子槽**，只给 id/order 时
    // 槽位服务拿到的是 `name: undefined`，会抛「slot "undefined" is not declared」。
    const removeHook = slots.inject(SEGMENT_RENDERER_SLOT, () => {
      try {
        return slots.register(
          { name: SEGMENT_RENDERER_SLOT, id: 'acp-agent-acp-segment-renderer', order: 0 },
          AcpProcessBlock,
        )
      } catch (error) {
        say(`acp process seat: ${error instanceof Error ? error.message : String(error)}`)
        return undefined
      }
    })

    const attempt = (label: string, fn: () => void): void => {
      try { fn() } catch (error) {
        say(`${label}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return () => {
      attempt('acp process view dispose', () => { unsubscribeView(); restore?.(); removeDefinition?.() })
      attempt('acp process wrap dispose', () => { unsubscribeWrap(); removeWrap?.() })
      attempt('acp process seat dispose', () => { if (typeof removeHook === 'function') removeHook() })
    }
  }, 'acp-agent ACP process segments')
}
