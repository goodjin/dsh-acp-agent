/**
 * The Doubao browser agent's dialect.
 *
 * The agent behind this dialect is our own process (see `src/doubao/`): it
 * drives the Doubao desktop app and reports what the page showed. Its frames
 * are the draft's own, so this dialect is thin — but two facts are worth
 * writing down:
 *
 *   - 豆包's tool activity carries no tool NAME: the page only shows a human
 *     line such as `搜索 1 个关键词，参考 5 篇资料` (measured 2026-11-05). The
 *     dialect therefore latches that line as the call's title and leaves the
 *     name empty, so DSH renders the line the user actually saw instead of an
 *     invented function name.
 *   - 豆包 runs its own tools server-side (web search, images), so those
 *     calls carry no arguments and no output we can read beyond the line.
 *     DSH's own tools do not take part in the model's decisions in this
 *     shape yet.
 */

import { randomUUID } from 'node:crypto'
import type { AcpDialect, ToolCall } from './types.ts'

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function textOf(content: unknown): string {
  return typeof record(content)['text'] === 'string' ? (record(content)['text'] as string) : ''
}

/** Unwrap ACP's nested content list (`[{ type: 'content', content: { text } }]`). */
function nestedText(content: unknown): string {
  if (!Array.isArray(content)) return textOf(content)
  const parts: string[] = []
  for (const item of content) {
    const entry = record(item)
    const inner = entry['content'] === undefined ? entry : record(entry['content'])
    const text = textOf(inner)
    if (text.length > 0) parts.push(text)
  }
  return parts.join('')
}

const CHATTER = new Set([
  'available_commands_update',
  'usage_update',
  'session_info_update',
  'current_mode_update',
  'config_option_update',
])

export const doubaoDialect: AcpDialect = {
  id: 'doubao',

  capabilities: {
    // The browser session can be stopped by clicking the page's own stop
    // control, so a cancelled turn really does stop.
    cancelsTurns: true,
    // The page's editor takes text only.
    acceptsImageContent: false,
    // One completed frame per tool activity; there is no in-progress frame.
    toolFrameShape: 'two_frame',
    commandVia: 'tool_frame',
    // 豆包's tool activities have no function name to translate.
    toolNameMap: {},
  },

  foldTool(carried, update) {
    const toolCallId = typeof update['toolCallId'] === 'string' ? update['toolCallId'] : randomUUID()
    const title = typeof update['title'] === 'string' ? update['title'] : carried?.title
    const output = nestedText(update['content'])
    return {
      callId: toolCallId,
      name: carried?.name ?? title ?? 'tool',
      arguments: update['rawInput'] ?? carried?.arguments ?? {},
      title,
      status: typeof update['status'] === 'string' ? update['status'] : carried?.status,
      output: output.length > 0 ? output : (carried?.output ?? ''),
    } satisfies ToolCall
  },

  toolOutput(update) {
    return nestedText(update['content'])
  },

  readModels(reply) {
    const models = record(record(reply)['models'])['availableModels']
    if (!Array.isArray(models)) return []
    return models.map(record).flatMap(model => {
      const id = model['id']
      if (typeof id !== 'string') return []
      const name = typeof model['name'] === 'string' ? model['name'] : id
      const description = typeof model['description'] === 'string' ? model['description'] : undefined
      return [{ id, name, ...(description === undefined ? {} : { description }) }]
    })
  },

  // 豆包's page reports no token usage; inventing one would be a fabricated fact.
  readReplyUsage() {
    return undefined
  },

  isContent(update) {
    return typeof update['sessionUpdate'] === 'string' && !CHATTER.has(update['sessionUpdate'] as string)
  },
}
