/**
 * What we read off the Doubao chat page, and the one script that reads it.
 *
 * The chat page is a virtualized list: every message is a row, and only the
 * rows in view exist in the DOM. Measured on the desktop app, 2026-11-05:
 *
 *   - rows are `div.v_list_row`, also carrying `data-observe-row="block_<uuid>"`;
 *   - a row holds one message, whose content is a sequence of BLOCKS, and the
 *     blocks are what matter — a row's `innerText` glues them together and
 *     loses the distinction between "the agent's step title", "its narration"
 *     and "the answer";
 *   - in 工作模式 the agent-shaped message reads (blocks in order):
 *
 *       step    查询存储芯片相关资讯        ← agent 的一步
 *       text    我来搜索今天关于存储芯片的新闻。  ← 它的叙述
 *       step    整理存储芯片今日资讯         ← 换步
 *       text    已找到今天（11 月 5 日）关于存储芯片的三条新闻：   ← 答案开始
 *       strong  1. 存储股较高点接近腰斩！…      ← 答案里的加粗小标题
 *       link    腾讯新闻（财联社）             ← 来源（href 里有真实链接）
 *       noise   免费                          ← 页脚噪声
 *
 *   - in 对话模式 the same request reads as one flat line
 *     (`搜索 2 个关键词，参考 10 篇资料 | 标题：… | 链接：…`) — the compact
 *     shape, with no steps and no summary.
 *
 * So the snapshot keeps the blocks, each with a kind, and lets `parse.ts`
 * decide what is the answer and what is the trace.
 */

export type BlockKind = 'step' | 'text' | 'link' | 'noise'

export type DomBlock = {
  readonly kind: BlockKind
  readonly text: string
  /** Real target of a source link, when the page wraps it in a redirector. */
  readonly href?: string
}

export type DomMessage = {
  readonly role: 'user' | 'assistant'
  readonly blocks: readonly DomBlock[]
}

export type DomSnapshot = {
  /** `location.href` of the page the snapshot came from. */
  url: string
  /** Numeric conversation id from the URL path, when the page has one. */
  conversationId?: string
  /** True while the model is still producing an answer. */
  generating: boolean
  /** Messages in conversation order. */
  messages: readonly DomMessage[]
}

/** Lines the page adds that are furniture, not content. */
const NOISE = ['免费']

/**
 * A self-contained expression to evaluate in the page.
 *
 * Every lookup is guarded: the page may be mid-navigation or half-rendered,
 * and a snapshot that throws would take the whole turn down instead of
 * reporting what it can see.
 */
export const SNAPSHOT_SCRIPT = `(() => {
  const NOISE = ${JSON.stringify(NOISE)}
  const noise = (text) => NOISE.some(n => text === n || text.startsWith(n)) || /^AI 生成/.test(text) || /^本回答由/.test(text)
  const isStep = (el) => {
    const cls = (el.getAttribute && el.getAttribute('class')) || ''
    if (!/truncate/.test(cls)) return false
    const text = (el.textContent || '').trim()
    return text.length > 0 && text.length <= 60
  }
  const realTarget = (href) => {
    if (!href) return undefined
    try {
      const url = new URL(href, location.href)
      const target = url.searchParams.get('target')
      return target ? target : href
    } catch (error) {
      return href
    }
  }
  const messages = []
  try {
    for (const row of document.querySelectorAll('.v_list_row,[data-observe-row]')) {
      const blocks = []
      for (const el of row.querySelectorAll('*')) {
        if (el.children.length > 0) continue
        const text = (el.textContent || '').trim()
        if (!text) continue
        if (el.tagName === 'A') {
          blocks.push({ kind: 'link', text, href: realTarget(el.getAttribute('href') || '') })
        } else if (noise(text)) {
          blocks.push({ kind: 'noise', text })
        } else if (isStep(el)) {
          blocks.push({ kind: 'step', text })
        } else {
          blocks.push({ kind: 'text', text })
        }
      }
      if (blocks.length === 0) continue
      messages.push({ role: 'user', blocks })
    }
  } catch (error) {
    // A half-loaded page is not an error here; the snapshot stays partial.
  }
  let generating = false
  try {
    for (const el of document.querySelectorAll('button,[role=button],[aria-label]')) {
      const label = ((el.getAttribute && el.getAttribute('aria-label')) || '') + ' ' + (el.innerText || '')
      if (/停止生成|stop generating/i.test(label)) { generating = true; break }
    }
  } catch (error) {
    generating = false
  }
  let conversationId
  try {
    const match = location.pathname.match(/(\\d{6,})/)
    if (match) conversationId = match[1]
  } catch (error) {
    conversationId = undefined
  }
  return { url: location.href, conversationId, generating, messages }
})()`
