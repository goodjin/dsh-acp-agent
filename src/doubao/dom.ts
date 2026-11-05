/**
 * What we read off the Doubao chat page, and the one script that reads it.
 *
 * The chat page is a virtualized list: every message is a row, and only the
 * rows in view exist in the DOM. The rows carry no role marker of their own —
 * a user message and an assistant message look alike from the outside — so the
 * snapshot stays dumb (rows in order, their text) and the decision about
 * which rows belong to this turn is made by `parse.ts`, where it can be
 * tested without a browser.
 *
 * Measured on the desktop app, 2026-11-05:
 *   - rows are `div.v_list_row`, also carrying `data-observe-row="block_<uuid>"`;
 *   - an assistant row ends with the noise line `免费` (and may carry the
 *     banner `AI 生成可能有误 注意核实`);
 *   - 豆包's own tool activity shows up as a line inside the assistant row,
 *     e.g. `搜索 1 个关键词，参考 5 篇资料`;
 *   - while the model is still generating, a stop control exists whose label
 *     contains `停止生成` (English build: `stop generating`);
 *   - the conversation id is the last numeric segment of the path:
 *     `chrome://doubao-chat/chat/38451600002457090`.
 */

export type DomSnapshot = {
  /** `location.href` of the page the snapshot came from. */
  url: string
  /** Numeric conversation id from the URL path, when the page has one. */
  conversationId?: string
  /** True while the model is still producing an answer. */
  generating: boolean
  /** Conversation rows, in DOM order. */
  rows: { text: string }[]
}

/**
 * A self-contained expression to evaluate in the page.
 *
 * Every lookup is guarded: the page may be mid-navigation or half-rendered,
 * and a snapshot that throws would take the whole turn down instead of
 * reporting what it can see.
 */
export const SNAPSHOT_SCRIPT = `(() => {
  const rows = []
  try {
    for (const node of document.querySelectorAll('.v_list_row,[data-observe-row]')) {
      const text = typeof node.innerText === 'string' ? node.innerText.trim() : ''
      if (text.length > 0) rows.push({ text })
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
  return { url: location.href, conversationId, generating, rows }
})()`
