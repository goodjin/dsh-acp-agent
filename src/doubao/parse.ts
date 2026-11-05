/**
 * Turning a page snapshot into "what did 豆包 answer, and what did it do".
 *
 * The chat page does not mark which rows are the user's and which are the
 * assistant's, so this file decides that from the one thing the caller
 * knows: the prompt it just sent. The messages after that one are this
 * turn's output.
 *
 * The bigger decision is inside the assistant's message. In 工作模式 it is a
 * sequence of blocks: the agent's step titles, its narration between the
 * steps, and finally the answer (measured 2026-11-05):
 *
 *     step  查询存储芯片相关资讯
 *     text  我来搜索今天关于存储芯片的新闻。
 *     step  整理存储芯片今日资讯
 *     text  已找到今天（11 月 5 日）关于存储芯片的三条新闻：
 *     text  1. 存储股较高点接近腰斩！…
 *     link  腾讯新闻（财联社）
 *
 * The answer is what comes after the LAST step title; everything before it
 * is the trace of how the agent got there, and the trace is worth showing
 * (it is the closest thing 豆包 has to a tool call) but must not be mistaken
 * for prose.
 *
 * Everything here is a pure function of the snapshot, so the rules are unit
 * tested instead of being discovered in a live browser.
 */

import type { DomBlock, DomSnapshot } from './dom.ts'

export type TurnParse = {
  /** The assistant's answer for this turn, cleaned of page furniture. */
  answer: string
  /** What the agent did on its way to the answer: step titles and narration. */
  trace: string[]
  /** Sources the answer cites, with their real targets when the page has them. */
  links: { text: string; href?: string }[]
  /** True once the assistant has produced something for this turn. */
  started: boolean
  /**
   * True once the assistant's message is complete.
   *
   * The page marks a finished message with its footer (`免费`, the free-tier
   * badge under the answer). While the model is still writing, that footer is
   * absent — measured 2026-11-05 across a whole turn, the footer appeared
   * only at the end, while the blocks before it kept changing.
   */
  complete: boolean
}

/**
 * 豆包's own tool activity, in the compact shape (对话模式).
 *
 * In 工作模式 the same activity arrives as step titles; this rule catches the
 * other shape so the line is reported as trace rather than as prose.
 */
const TOOL_ACTIVITY = /搜索\s*\d+\s*个关键词|参考\s*\d+\s*篇资料|正在搜索|搜索中|找到\s*\d+\s*篇资料/

/**
 * Lines the page adds around the answer: the disclaimer banner and the
 * "this answer is AI-generated" line. The in-page script already marks them
 * as noise, and this is the second line of defence — a banner that arrives as
 * plain text must not end up in the answer.
 */
const NOISE_LINE = /^AI 生成|^本回答由/

/** Whitespace-free form of a line. */
function normalize(text: string): string {
  return text.replace(/\s+/g, '')
}

/**
 * The index of the message that holds the prompt we sent.
 *
 * The page marks no role on its rows, so the prompt message is found by its
 * text. The LAST match wins: the same prompt may appear earlier in the
 * conversation.
 */
function promptMessageIndex(messages: readonly { blocks: readonly DomBlock[] }[], prompt: string): number {
  const needle = normalize(prompt)
  if (needle.length === 0) return -1
  let found = -1
  for (let index = 0; index < messages.length; index += 1) {
    const text = normalize(messages[index]!.blocks.map(block => block.text).join(' '))
    if (text.includes(needle)) found = index
  }
  return found
}

/**
 * Read one turn out of a snapshot.
 *
 * `started` means the assistant has something to show; `done` means the page
 * is no longer generating and an answer exists.
 */
export function parseTurn(snapshot: DomSnapshot, prompt: string): TurnParse {
  const index = promptMessageIndex(snapshot.messages, prompt)
  if (index < 0) {
    return { answer: '', trace: [], links: [], started: false, complete: false }
  }
  const messages = snapshot.messages.slice(index + 1)
  const blocks: DomBlock[] = []
  for (const message of messages) {
    blocks.push(...message.blocks)
  }
  if (blocks.length === 0) {
    return { answer: '', trace: [], links: [], started: false, complete: false }
  }
  // The footer belongs to the last message of the turn.
  const lastMessage = messages[messages.length - 1]
  const complete = lastMessage !== undefined
    && lastMessage.blocks.some(block => block.kind === 'noise')

  // The answer starts after the last step title; before it is the trace.
  //
  // A turn with several steps puts its narration BETWEEN them (measured:
  // step → 我来搜索… → step → 搜索结果已返回… → step → the answer), so the
  // narration lands in the trace. A turn with a single step cannot be split
  // that way — its one narration line is read as part of the answer, which is
  // a sentence too many rather than a wrong answer.
  let lastStep = -1
  for (let position = 0; position < blocks.length; position += 1) {
    if (blocks[position]!.kind === 'step') lastStep = position
  }
  const answerBlocks = blocks.slice(lastStep + 1)
  const traceBlocks = blocks.slice(0, lastStep + 1)

  const answerLines: string[] = []
  const trace: string[] = []
  const links: { text: string; href?: string }[] = []
  for (const block of answerBlocks) {
    if (block.kind === 'noise') continue
    if (block.kind === 'link') {
      links.push(block.href === undefined ? { text: block.text } : { text: block.text, href: block.href })
      answerLines.push(block.text)
      continue
    }
    if (block.kind === 'text' && TOOL_ACTIVITY.test(block.text)) {
      trace.push(block.text)
      continue
    }
    if (block.kind === 'text' && NOISE_LINE.test(block.text)) continue
    answerLines.push(block.text)
  }
  for (const block of traceBlocks) {
    if (block.kind === 'noise' || block.kind === 'link') continue
    if (block.text.length === 0) continue
    trace.push(block.text)
  }

  return {
    answer: answerLines.join('\n'),
    trace,
    links,
    started: true,
    complete,
  }
}

/**
 * The text appended since `previous`.
 *
 * A growing answer yields its new tail; an answer that was rewritten (the
 * page re-rendered it) yields the whole text again, so the caller can replace
 * rather than append; an unchanged answer yields nothing.
 */
export function answerDelta(previous: string, current: string): string {
  if (current === previous) return ''
  if (previous.length > 0 && current.startsWith(previous)) return current.slice(previous.length)
  return current
}
