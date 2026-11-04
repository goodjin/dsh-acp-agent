/**
 * WorkBuddy 的模型请求体（OpenAI Chat Completions 形状）。
 *
 * WorkBuddy 的模型端点是 OpenAI 兼容的，所以请求体不用自造：把 DSH 的消息投影
 * 成 chat 消息、把 DSH 的工具投影成 function schema 就行。
 *
 * 三处投影是有讲究的：
 * - **推理块不重放**。DSH 的历史里 assistant 带 `reasoning` 块，那是给「需要推理
 *   签名」的服务端用的；OpenAI 侧不需要，原样回传反而可能被拒。
 * - **工具调用与工具结果分开**。调用进 assistant 消息的 `tool_calls`，结果进
 *   `role: "tool"` 的消息并带上 `tool_call_id`——两者的对应关系靠这个 id。
 * - **图片看模型能力**。模型支持视觉就带 `image_url`（内联 data URI），不支持就
 *   退化成占位文本，让模型至少知道「这里本来有张图」。
 */

export type WorkBuddyContentPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image_url'; readonly image_url: { readonly url: string } }

export type WorkBuddyToolCall = {
  readonly id: string
  readonly type: 'function'
  readonly function: { readonly name: string; readonly arguments: string }
}

export type WorkBuddyMessage = {
  readonly role: 'system' | 'user' | 'assistant' | 'tool'
  readonly content?: string | readonly WorkBuddyContentPart[]
  readonly tool_calls?: readonly WorkBuddyToolCall[]
  readonly tool_call_id?: string
}

export type WorkBuddyTool = {
  readonly type: 'function'
  readonly function: {
    readonly name: string
    readonly description: string
    readonly parameters: Record<string, unknown>
  }
}

export type WorkBuddyBody = {
  readonly model: string
  readonly messages: readonly WorkBuddyMessage[]
  readonly stream: true
  readonly tools?: readonly WorkBuddyTool[]
  readonly max_tokens?: number
  readonly reasoning_effort?: string
  readonly temperature?: number
}

export type ChatBodyInput = {
  readonly model: string
  readonly messages: readonly unknown[]
  readonly system?: string | undefined
  readonly tools?: readonly {
    readonly name: string
    readonly description?: string | undefined
    readonly parameters?: unknown
  }[] | undefined
  readonly reasoningEffort?: string | undefined
  readonly maxTokens?: number | undefined
  readonly supportedEfforts?: readonly string[] | undefined
  readonly temperature?: number | undefined
  readonly supportsImages?: boolean | undefined
}

/** 图片在模型看不见时留下的占位。 */
const IMAGE_PLACEHOLDER = '[image attached]'

/**
 * 投影成一次 chat completions 的请求体。
 * @param input - 模型、消息、工具与各项上限。
 * @returns 请求体。
 */
export function buildChatBody(input: ChatBodyInput): WorkBuddyBody {
  const systemParts: string[] = []
  if (input.system !== undefined && input.system.trim() !== '') systemParts.push(input.system)
  const turns = projectMessages(input.messages, systemParts, input.supportsImages === true)

  const tools = input.tools === undefined
    ? undefined
    : input.tools.map(tool => toolSchema(tool))
  const effort = resolveReasoningEffort(input.reasoningEffort, input.supportedEfforts)
  const maxTokens = typeof input.maxTokens === 'number' && input.maxTokens > 0
    ? Math.floor(input.maxTokens)
    : undefined

  return {
    model: input.model,
    messages: systemParts.length === 0
      ? turns
      : [{ role: 'system', content: systemParts.join('\n') }, ...turns],
    stream: true,
    ...(tools === undefined || tools.length === 0 ? {} : { tools }),
    ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
    ...(effort === undefined ? {} : { reasoning_effort: effort }),
    ...(typeof input.temperature === 'number' ? { temperature: input.temperature } : {}),
  }
}

/**
 * 把 DSH 的推理档位映射成模型接受的值。
 *
 * 档位不在模型支持的列表里就不下发——硬发一个服务端不认的值，失败原因会被
 * 埋在一句含糊的报错里。
 * @param effort - DSH 的档位。
 * @param supported - 模型支持的档位；`undefined` 表示未知，按原样下发。
 * @returns 要下发的档位，或 `undefined`（不发这个字段）。
 */
export function resolveReasoningEffort(
  effort: string | undefined,
  supported: readonly string[] | undefined,
): string | undefined {
  if (effort === undefined) return undefined
  const level = effort.trim().toLowerCase()
  if (level === '') return undefined
  if (level === 'none' || level === 'off' || level === 'disabled') return undefined
  if (supported !== undefined && !supported.includes(level)) return undefined
  return level
}

function toolSchema(tool: {
  readonly name: string
  readonly description?: string | undefined
  readonly parameters?: unknown
}): WorkBuddyTool {
  const parameters = isRecord(tool.parameters) ? { ...tool.parameters } : {}
  if (typeof parameters['type'] !== 'string') parameters['type'] = 'object'
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description ?? tool.name,
      parameters,
    },
  }
}

function projectMessages(
  messages: readonly unknown[],
  systemParts: string[],
  supportsImages: boolean,
): WorkBuddyMessage[] {
  const turns: WorkBuddyMessage[] = []
  const push = (message: WorkBuddyMessage): void => {
    const last = turns[turns.length - 1]
    // 只合并相邻的用户消息：assistant 消息带工具调用，合并会弄乱调用的对应关系。
    if (last !== undefined && last.role === 'user' && message.role === 'user') {
      turns[turns.length - 1] = mergeUser(last, message)
      return
    }
    turns.push(message)
  }

  for (const message of messages) {
    if (!isRecord(message)) continue
    const role = message['role']
    if (role === 'system' || role === 'developer') {
      const text = textOf(message['content']).join('\n')
      if (text !== '') systemParts.push(text)
      continue
    }
    if (role === 'user') {
      push({ role: 'user', content: userContent(message['content'], supportsImages) })
      continue
    }
    if (role === 'assistant') {
      push(assistantMessage(message))
      continue
    }
    if (role === 'tool') {
      push(toolResult(message))
    }
  }
  return turns
}

function mergeUser(left: WorkBuddyMessage, right: WorkBuddyMessage): WorkBuddyMessage {
  const leftParts = partsOf(left.content)
  const rightParts = partsOf(right.content)
  const merged = [...leftParts, ...rightParts]
  if (merged.every(part => part.type === 'text')) {
    return { role: 'user', content: merged.map(part => part.text).join('\n') }
  }
  return { role: 'user', content: merged }
}

function partsOf(content: string | readonly WorkBuddyContentPart[] | undefined): WorkBuddyContentPart[] {
  if (content === undefined) return []
  if (typeof content === 'string') return content === '' ? [] : [{ type: 'text', text: content }]
  return [...content]
}

function assistantMessage(message: Record<string, unknown>): WorkBuddyMessage {
  const blocks = Array.isArray(message['content']) ? message['content'] : []
  const texts: string[] = []
  const calls: WorkBuddyToolCall[] = []
  let index = 0
  for (const block of blocks) {
    if (!isRecord(block)) continue
    if (block['type'] === 'text' && typeof block['text'] === 'string' && block['text'] !== '') {
      texts.push(block['text'])
      continue
    }
    if (block['type'] === 'tool-call') {
      const id = typeof block['id'] === 'string' && block['id'] !== '' ? block['id'] : `call-${String(index)}`
      const name = typeof block['name'] === 'string' && block['name'] !== '' ? block['name'] : 'tool'
      calls.push({ id, type: 'function', function: { name, arguments: argumentsOf(block['arguments']) } })
    }
    index += 1
  }
  return {
    role: 'assistant',
    content: texts.join('\n'),
    ...(calls.length === 0 ? {} : { tool_calls: calls }),
  }
}

function toolResult(message: Record<string, unknown>): WorkBuddyMessage {
  const source = isRecord(message['source']) ? message['source'] : undefined
  const fromSource = source?.['callId']
  const id = typeof message['toolCallId'] === 'string' && message['toolCallId'] !== ''
    ? message['toolCallId']
    : typeof fromSource === 'string' && fromSource !== ''
      ? fromSource
      : 'call'
  return { role: 'tool', tool_call_id: id, content: textOf(message['content']).join('\n') }
}

function userContent(content: unknown, supportsImages: boolean): string | readonly WorkBuddyContentPart[] {
  const blocks = Array.isArray(content) ? content : typeof content === 'string' ? [{ type: 'text', text: content }] : []
  const parts: WorkBuddyContentPart[] = []
  for (const block of blocks) {
    if (!isRecord(block)) continue
    if (block['type'] === 'text' && typeof block['text'] === 'string' && block['text'] !== '') {
      parts.push({ type: 'text', text: block['text'] })
      continue
    }
    if (block['type'] === 'image') {
      const url = imageUrl(block)
      if (supportsImages && url !== undefined) {
        parts.push({ type: 'image_url', image_url: { url } })
        continue
      }
      parts.push({ type: 'text', text: IMAGE_PLACEHOLDER })
    }
  }
  if (parts.every(part => part.type === 'text')) {
    return parts.map(part => part.text).join('\n')
  }
  return parts
}

function imageUrl(block: Record<string, unknown>): string | undefined {
  const data = block['data']
  const mime = block['mimeType']
  if (typeof data !== 'string' || data === '') return undefined
  const type = typeof mime === 'string' && mime !== '' ? mime : 'image/png'
  return `data:${type};base64,${data}`
}

function argumentsOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return '{}'
  return JSON.stringify(value)
}

function textOf(content: unknown): string[] {
  if (typeof content === 'string') return content === '' ? [] : [content]
  if (!Array.isArray(content)) return []
  const texts: string[] = []
  for (const block of content) {
    if (isRecord(block) && block['type'] === 'text' && typeof block['text'] === 'string' && block['text'] !== '') {
      texts.push(block['text'])
    }
  }
  return texts
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
