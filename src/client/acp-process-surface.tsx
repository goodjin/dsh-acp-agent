import { createElement, useCallback, useEffect, useState, type ComponentType } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConversationNodeDefinition, ConversationViewDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import { acpProcessDefinition } from './acp-process-segments.ts'
import { wrapChatView } from './acp-process-view.ts'
import type { ProcessSegment } from './acp-process-segments.ts'
import { defaultLinkOpenMode, httpLinkHref, openInBrowser } from './link-open.ts'
import styles from './acp-process.module.css'

/**
 * ACP 进程段的宿主半边。
 *
 * 这里只做一件 ACP 专属的事：把 chat 视图的 builder 包一层（`wrapChatView`），
 * 把带 ACP 段的助手步投影成带 `acpProcessSegment` 的节点；并注册
 * `acpProcessDefinition` 折叠 ACP 事件。
 *
 * `assistant-step` 的遮蔽 wrap（本包 -40 兜底 + chat-power 的 -50 分派层）已全部
 * 拆除（2026-11-13）：原生 AssistantNodeView 声明了子座位（reasoning.body /
 * message.images），宿主对 renderSlot 逐 key 校验「本条目 children 表」——遮蔽
 * wrap 没声明的座位，原生一调用就抛 SlotOwnershipError、错误边界卸掉整棵会话流；
 * 转发原生 children 又在 register 时抛 already declared。两条路都死。ACP 段数据
 * 注入保留，渲染方待走合法座位重接。
 */

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

/**
 * 注册 ACP 进程表面：包 chat 视图（注入 `acpProcessSegment`）+ 注册
 * `acpProcessDefinition` 折叠 ACP 事件。
 *
 * `assistant-step` 不再接管（2026-11-13）：原生 AssistantNodeView 声明了子座位
 * （reasoning.body / message.images），宿主对 renderSlot 逐 key 校验「本条目
 * children 表」——遮蔽 wrap 没声明的座位，原生一调用就抛 SlotOwnershipError、
 * 错误边界卸掉整棵会话流；转发原生 children 又在 register 时抛 already declared
 * （子座位单一存活 owner）。两条路都死，本包的 -40 兜底 wrap 与跨包座位挂钩
 * （`SEGMENT_RENDERER_SLOT`，声明方 chat-power 也已拆除）一并移除。
 *
 * 错误边界：本包交给宿主的回调（视图 subscribe 等）在**别人的调用栈**里执行；
 * 抛出去会打断对方的注册流程，2026-11-05 就是这样把同时声明座位的 chat-area
 * 判成 failed、整页起不来。因此这些回调与返回的卸载函数一律就地吞错、只记
 * 一条日志，本包的故障不外溢。
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

    // assistant-step 不接管（2026-11-13）：原生 AssistantNodeView 声明了子座位
    // （reasoning.body / message.images），遮蔽 wrap 两条路都死
    // （SlotOwnershipError / already declared，见文件头说明）。本包此前的 -40
    // 兜底 wrap 与跨包座位挂钩（SEGMENT_RENDERER_SLOT，声明方 chat-power 已拆）
    // 一并移除；ACP 段数据注入（上面的视图 wrap）保留，渲染方待走合法座位重接。

    const attempt = (label: string, fn: () => void): void => {
      try { fn() } catch (error) {
        say(`${label}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return () => {
      attempt('acp process view dispose', () => { unsubscribeView(); restore?.(); removeDefinition?.() })
    }
  }, 'acp-agent ACP process segments')
}
