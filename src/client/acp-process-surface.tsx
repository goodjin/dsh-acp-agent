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
 * 注册 ACP 进程表面：包 chat 视图（注入 `acpProcessSegment`）+ 包 `assistant-step`
 * 渲染 ACP 段（独立运行时）+ 注册进程段渲染器到座位（chat-area 装在时复用）。
 *
 * 本函数**同时**做两件事：
 * 1. 包 `assistant-step`（priority -40），遇到 `acpProcessSegment` 渲染 `AcpProcessBlock`，
 *    非 ACP 段调原生——保证只装 acp-agent 时 ACP 段能完整渲染。
 * 2. 注册 `AcpProcessBlock` 到 `SEGMENT_RENDERER_SLOT` 座位——chat-area 装在时，它的
 *    wrap 会优先处理 ACP 段（priority -30），acp-agent 的注册作为兜底。
 */
export function registerAcpProcessSurface(ctx: Surface): void {
  const ui = ctx.get('uiConversation') as Registry | undefined
  const slots = ctx.slots as NodeSlots
  if (typeof ui?.views?.entries !== 'function' || typeof ui.views.subscribe !== 'function'
    || typeof ui.events?.register !== 'function' || typeof slots?.entries !== 'function'
    || typeof slots.subscribe !== 'function' || typeof slots.register !== 'function') return
  ctx.effect(() => {
    let active: ConversationViewDefinition | undefined
    let restore: (() => void) | undefined
    let removeDefinition: (() => void) | undefined
    const attachView = (): void => {
      const view = ui.views.entries().find(candidate => candidate.target === 'chat')
      if (view === undefined || view === active) return
      restore?.()
      active = view
      restore = wrapChatView(view)
      // Registration invalidates existing builders too, including already open tabs.
      removeDefinition?.()
      removeDefinition = ui.events.register(acpProcessDefinition as ConversationNodeDefinition)
    }
    const unsubscribeView = ui.views.subscribe(attachView)
    attachView()

    // 包 `assistant-step`：遇到 ACP 段渲染 `AcpProcessBlock`，非 ACP 段调原生。
    // priority -40 让 chat-area 的 wrap（priority -30）优先；chat-area 没装时这层生效。
    let removeWrap: (() => void) | undefined
    let originalComponent: unknown
    let installing = false
    let seatDeclared = false
    const attachWrap = (): void => {
      if (installing) return
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
          name: 'conversation.chat.node', key: 'assistant-step', priority: -40,
          ...(seatDeclared ? {} : { children: { [SEGMENT_RENDERER_SLOT]: { kind: 'list', scope: 'session' } } }),
          ...(entry.locale === undefined ? {} : { locale: entry.locale }),
          ...(entry.inject === undefined ? {} : { inject: entry.inject }),
        }, Renderer)
        seatDeclared = true
      } finally { installing = false }
    }
    const unsubscribeWrap = slots.subscribe('conversation.chat.node', attachWrap)
    attachWrap()

    // 把进程段渲染器注册进座位：chat-area 装在时它的 wrap 会优先处理 ACP 段，
    // acp-agent 的注册作为兜底（chat-area 的 wrap 遇到座位有渲染器就用，没有就退回原生，
    // 但原生已经被 acp-agent 的 wrap 包过了，所以实际不会走到原生）。
    const removeHook = slots.inject(SEGMENT_RENDERER_SLOT, () => slots.register(
      { id: 'threadharbor-acp-segment-renderer', order: 0 },
      AcpProcessBlock,
    ))

    return () => {
      unsubscribeView(); restore?.(); removeDefinition?.()
      unsubscribeWrap(); removeWrap?.()
      if (typeof removeHook === 'function') removeHook()
    }
  }, 'threadharbor ACP process segments')
}
