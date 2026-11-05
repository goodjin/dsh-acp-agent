/**
 * OpenAI 的 SSE 读取与增量翻译。
 *
 * 帧是 OpenAI 形状：每帧 `data:` 一个 JSON，增量在 `choices[0].delta` 里。翻译成
 * DSH 循环认得的块词汇（开块 → 增量 → 收块 → 用量 → 结束），块序号按首次出现
 * 顺序分配——循环靠它把内容摆回原位，序号乱了内容就错位。
 *
 * 工具调用是这里最容易错的一处：名字与 id 在第一帧，参数跨帧到达，每个工具调用
 * 靠自己的 `index` 归并。归并错了就是半截 JSON，工具执行直接失败。
 */

export type OpenAiBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'reasoning'; readonly text: string }
  | { readonly type: 'tool-call'; readonly id: string; readonly name: string; readonly arguments: string }

export type OpenAiUsage = {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens?: number
}

export type OpenAiFinish =
  | { readonly kind: 'stop' }
  | { readonly kind: 'tool-calls' }
  | { readonly kind: 'max-tokens' }
  | { readonly kind: 'error'; readonly failure: { readonly message: string; readonly code: string } }

export type OpenAiStreamChunk =
  | { readonly type: 'block-start'; readonly index: number; readonly blockType: 'text' | 'reasoning' | 'tool-call' }
  | { readonly type: 'text-delta'; readonly index: number; readonly text: string }
  | { readonly type: 'reasoning-delta'; readonly index: number; readonly text: string }
  | { readonly type: 'tool-call-delta'; readonly index: number; readonly id: string; readonly name?: string; readonly argumentsDelta: string }
  | { readonly type: 'block-end'; readonly index: number; readonly block: OpenAiBlock }
  | { readonly type: 'usage'; readonly usage: OpenAiUsage }
  | {
    readonly type: 'finish'
    readonly reason: OpenAiFinish
    readonly replayState?: { readonly response: { readonly stopReason: string }; readonly blocks: readonly Record<string, never>[] }
  }

/** 一个正在累积的块。 */
type OpenBlock = {
  index: number
  kind: 'text' | 'reasoning' | 'tool-call'
  text: string
  id: string
  name: string
  args: string
  named: boolean
}

/** 把一串 SSE 字节读成一帧一个 JSON 对象。畸形帧跳过，不炸整轮。 */
export async function* readSseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const read = await reader.read()
      if (read.done) {
        buffer += decoder.decode()
        break
      }
      buffer += decoder.decode(read.value, { stream: true })
      buffer = buffer.replace(/\r\n/gu, '\n')
      let split = buffer.indexOf('\n\n')
      while (split !== -1) {
        const frame = buffer.slice(0, split)
        buffer = buffer.slice(split + 2)
        const event = parseFrame(frame)
        if (event !== undefined) yield event
        split = buffer.indexOf('\n\n')
      }
    }
    if (buffer.trim() !== '') {
      const event = parseFrame(buffer)
      if (event !== undefined) yield event
    }
  } finally {
    reader.releaseLock()
  }
}

function parseFrame(frame: string): unknown {
  const data = frame
    .split('\n')
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice('data:'.length).trimStart())
    .join('\n')
  if (data === '' || data === '[DONE]') return undefined
  try {
    return JSON.parse(data) as unknown
  } catch {
    return undefined
  }
}

/**
 * 把 OpenAI 形状的事件流翻译成 DSH 的块词汇。
 *
 * 块序号按首次出现顺序分配；工具调用按帧里的 `index` 归并，参数逐帧拼接。
 * @param events - 逐帧的事件对象。
 * @returns DSH 的块序列。
 */
export async function* chunksFromOpenAiEvents(events: AsyncIterable<unknown>): AsyncGenerator<OpenAiStreamChunk> {
  const open = new Map<string, OpenBlock>()
  const replay: Record<string, never>[] = []
  let nextIndex = 0
  let stopReason = ''
  let sawTool = false
  let usage: OpenAiUsage | undefined

  const close = function* close(key: string): Generator<OpenAiStreamChunk> {
    const block = open.get(key)
    if (block === undefined) return
    open.delete(key)
    if (block.kind === 'text') {
      yield { type: 'block-end', index: block.index, block: { type: 'text', text: block.text } }
      replay[block.index] = {}
      return
    }
    if (block.kind === 'reasoning') {
      yield { type: 'block-end', index: block.index, block: { type: 'reasoning', text: block.text } }
      replay[block.index] = {}
      return
    }
    const args = block.args.trim() === '' ? '{}' : block.args
    yield {
      type: 'block-end',
      index: block.index,
      block: { type: 'tool-call', id: block.id, name: block.name, arguments: args },
    }
    replay[block.index] = {}
  }

  const start = function* start(key: string, kind: OpenBlock['kind'], seed: Partial<OpenBlock>): Generator<OpenAiStreamChunk> {
    const block: OpenBlock = {
      index: nextIndex,
      kind,
      text: '',
      id: '',
      name: '',
      args: '',
      named: false,
      ...seed,
    }
    nextIndex += 1
    open.set(key, block)
    replay[block.index] = {}
    yield { type: 'block-start', index: block.index, blockType: kind }
  }

  for await (const event of events) {
    if (!isRecord(event)) continue
    const usageSeen = readUsage(event['usage'])
    if (usageSeen !== undefined) usage = usageSeen

    const choices = Array.isArray(event['choices']) ? event['choices'] : []
    for (const choice of choices) {
      if (!isRecord(choice)) continue
      const reason = choice['finish_reason']
      if (typeof reason === 'string' && reason !== '') stopReason = reason
      const choiceUsage = readUsage(choice['usage'])
      if (choiceUsage !== undefined) usage = choiceUsage

      const delta = choice['delta']
      if (!isRecord(delta)) continue

      const content = delta['content']
      if (typeof content === 'string' && content !== '') {
        if (!open.has('text')) yield* start('text', 'text', {})
        const block = open.get('text')
        if (block !== undefined) {
          block.text += content
          yield { type: 'text-delta', index: block.index, text: content }
        }
      }

      const reasoning = reasoningOf(delta)
      if (reasoning !== undefined && reasoning !== '') {
        if (!open.has('reasoning')) yield* start('reasoning', 'reasoning', {})
        const block = open.get('reasoning')
        if (block !== undefined) {
          block.text += reasoning
          yield { type: 'reasoning-delta', index: block.index, text: reasoning }
        }
      }

      const calls = delta['tool_calls']
      if (!Array.isArray(calls)) continue
      for (const call of calls) {
        if (!isRecord(call)) continue
        const sourceIndex = typeof call['index'] === 'number' ? call['index'] : 0
        const key = `tool:${String(sourceIndex)}`
        const fn = isRecord(call['function']) ? call['function'] : {}
        const id = typeof call['id'] === 'string' && call['id'] !== '' ? call['id'] : ''
        const name = typeof fn['name'] === 'string' && fn['name'] !== '' ? fn['name'] : ''
        const args = typeof fn['arguments'] === 'string' ? fn['arguments'] : ''

        if (!open.has(key)) {
          yield* start(key, 'tool-call', { id: id === '' ? `call-${String(sourceIndex)}` : id, name })
          sawTool = true
        }
        const block = open.get(key)
        if (block === undefined) continue
        if (id !== '') block.id = id
        if (name !== '') block.name = name
        if (args !== '') {
          block.args += args
          yield {
            type: 'tool-call-delta',
            index: block.index,
            id: block.id,
            ...(block.named ? {} : { name: block.name }),
            argumentsDelta: args,
          }
          block.named = true
        }
      }
    }
  }

  for (const key of [...open.keys()]) yield* close(key)
  if (usage !== undefined) yield { type: 'usage', usage }
  yield {
    type: 'finish',
    reason: finishOf(stopReason, sawTool),
    replayState: { response: { stopReason: stopReason === '' ? 'stop' : stopReason }, blocks: replay },
  }
}

/** 推理增量在不同模型上键名不一样，两个都认。 */
function reasoningOf(delta: Record<string, unknown>): string | undefined {
  const value = delta['reasoning_content'] ?? delta['reasoning']
  return typeof value === 'string' ? value : undefined
}

function readUsage(value: unknown): OpenAiUsage | undefined {
  if (!isRecord(value)) return undefined
  const input = typeof value['prompt_tokens'] === 'number' ? value['prompt_tokens'] : undefined
  const output = typeof value['completion_tokens'] === 'number' ? value['completion_tokens'] : undefined
  if (input === undefined && output === undefined) return undefined
  const total = typeof value['total_tokens'] === 'number' ? value['total_tokens'] : undefined
  const inputTokens = input ?? 0
  const outputTokens = output ?? 0
  return {
    inputTokens,
    outputTokens,
    ...(total === undefined ? {} : { totalTokens: total }),
  }
}

function finishOf(stopReason: string, sawTool: boolean): OpenAiFinish {
  if (stopReason === 'length') return { kind: 'max-tokens' }
  if (stopReason === 'tool_calls' || (stopReason === '' && sawTool)) return { kind: 'tool-calls' }
  return { kind: 'stop' }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
