/**
 * Turning a page snapshot into "what did 豆包 answer, and what did it do".
 *
 * The chat page does not mark which rows are the user's and which are the
 * assistant's, so this file decides that from the one thing the caller
 * knows: the prompt it just sent. The rows after the prompt row are this
 * turn's assistant output.
 *
 * The cleaning rules are measured, not guessed (desktop app, 2026-11-05):
 *   - the assistant row ends with `免费` — a footer, not content;
 *   - a turn may carry the banner `AI 生成可能有误 注意核实` — also not content;
 *   - 豆包's own tool activity is a line inside the answer, e.g.
 *     `搜索 1 个关键词，参考 5 篇资料` — reported as a tool action rather than
 *     as prose.
 *
 * Everything here is a pure function of the snapshot, so the rules are unit
 * tested instead of being discovered in a live browser.
 */

import type { DomSnapshot } from './dom.ts'

export type TurnParse = {
  /** The assistant's answer for this turn, cleaned of page furniture. */
  answer: string
  /** 豆包's own tool-activity lines seen in this turn. */
  toolActions: string[]
  /** True once the assistant has produced at least one row for this turn. */
  started: boolean
  /** True once the assistant's answer looks finished. */
  done: boolean
}

const NOISE_EXACT = new Set(['免费'])
const NOISE_PREFIX = ['AI 生成可能有误']
// 豆包's search shows up as several lines while it runs — the status line
// (`正在搜索`), the count it found (`找到 6 篇资料`) and the card's own line
// (`搜索 1 个关键词，参考 5 篇资料`). They are the tool's activity, not prose.
const TOOL_ACTION = /正在搜索|搜索中|找到\s*\d+\s*篇资料|参考\s*\d+\s*篇资料|搜索\s*\d+\s*个关键词/

function isNoise(line: string): boolean {
  if (NOISE_EXACT.has(line)) return true
  return NOISE_PREFIX.some(prefix => line.startsWith(prefix))
}

/**
 * Whitespace-free form of a line.
 *
 * 豆包 rewrites the prompt it shows: `2026年11月5日` comes back as
 * `2026 年 11 月 5 日` (measured 2026-11-05, a search prompt). Matching the
 * raw text would miss our own row, so both sides are compared without
 * whitespace.
 */
function normalize(text: string): string {
  return text.replace(/\s+/g, '')
}

/**
 * The index of the row that holds the prompt we sent.
 *
 * The page marks no role on its rows, so the prompt row is found by its text.
 * The order matters: an exact match is the user's own row, while a row that
 * merely starts with the prompt may well be the ANSWER quoting it back
 * (`你好` against an answer that begins `你好呀…`). Only when neither exists
 * do we fall back to a row that contains the prompt somewhere.
 *
 * The LAST match wins: the same prompt may appear earlier in the conversation.
 */
function promptRowIndex(rows: readonly { text: string }[], prompt: string): number {
  const needle = normalize(prompt.trim())
  if (needle.length === 0) return -1
  const texts = rows.map(row => normalize(row.text.trim()))
  let exact = -1
  for (let index = 0; index < texts.length; index += 1) {
    if (texts[index] === needle) exact = index
  }
  if (exact >= 0) return exact
  let found = -1
  for (let index = 0; index < texts.length; index += 1) {
    if (texts[index]!.startsWith(needle)) found = index
  }
  if (found >= 0) return found
  for (let index = 0; index < texts.length; index += 1) {
    if (texts[index]!.includes(needle)) found = index
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
  const rows = snapshot.rows
  const index = promptRowIndex(rows, prompt)
  if (index < 0) {
    return { answer: '', toolActions: [], started: false, done: false }
  }
  const answerLines: string[] = []
  const toolActions: string[] = []
  for (const row of rows.slice(index + 1)) {
    for (const line of row.text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      if (isNoise(trimmed)) continue
      if (TOOL_ACTION.test(trimmed)) {
        toolActions.push(trimmed)
        continue
      }
      answerLines.push(trimmed)
    }
  }
  const started = rows.length > index + 1
  return {
    answer: answerLines.join('\n'),
    toolActions,
    started,
    done: started && snapshot.generating === false,
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
