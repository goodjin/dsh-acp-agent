import { randomUUID } from 'node:crypto'
import { buildChatBody } from '../workbuddy/openai.ts'
import { chunksFromOpenAiEvents } from '../workbuddy/sse.ts'
import type { WorkBuddyStreamChunk } from '../workbuddy/sse.ts'
import type { CatalogTurnRequest } from '../catalog.ts'
import { MODEL_URL, record } from './auth.ts'
import type { Credential } from './auth.ts'

/** Qoder's OFn builder adds metadata to an otherwise OpenAI-shaped request. */
export function buildQoderBody(request: CatalogTurnRequest, requestId: string, sessionId: string) {
  return {
    ...buildChatBody({ model: request.model, messages: request.messages ?? [], system: typeof request.system === 'string' ? request.system : undefined,
      tools: request.tools, maxTokens: typeof request.maxTokens === 'number' ? request.maxTokens : undefined, reasoningEffort: typeof request.reasoningEffort === 'string' ? request.reasoningEffort : undefined, supportsImages: true }),
    ...(request.reasoningEffort === 'none' ? { reasoning_effort: 'none' } : {}),
    stream_options: { include_usage: true },
    metadata: { context: { request_id: requestId, request_set_id: requestId, session_id: sessionId, client_type: '5' } },
  }
}
/** Never turn an upstream error or truncated stream into a successful empty answer. */
export async function* checkedEvents(events: AsyncIterable<unknown>): AsyncGenerator<unknown> {
  let finished = false
  for await (const event of events) {
    const data = record(event)
    if (data.error || data.error_code) throw new Error('Qoder 返回模型错误，请检查账号与模型权限')
    const choices = Array.isArray(data.choices) ? data.choices : []
    if (choices.some(c => typeof record(c).finish_reason === 'string' && record(c).finish_reason !== '')) finished = true
    yield event
  }
  if (!finished) throw new Error('Qoder 响应中断：没有收到结束帧')
}
export async function* streamQoder(request: CatalogTurnRequest, deps: {
  credential: (rejectedToken?: string) => Promise<Credential>; fetchImpl?: typeof fetch
}): AsyncGenerator<WorkBuddyStreamChunk> {
  const requestId = randomUUID(), sessionId = typeof request.sessionId === 'string' && request.sessionId ? request.sessionId : randomUUID()
  const body = JSON.stringify(buildQoderBody(request, requestId, sessionId))
  const signal = AbortSignal.any([AbortSignal.timeout(300_000), ...(request.signal instanceof AbortSignal ? [request.signal] : [])])
  signal.throwIfAborted()
  let credential = await deps.credential()
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await (deps.fetchImpl ?? fetch)(MODEL_URL, {
      method: 'POST', body, signal, redirect: 'error',
      headers: { Authorization: `Bearer ${credential.accessToken}`, 'Content-Type': 'application/json',
        Accept: 'text/event-stream', 'X-Request-ID': requestId, 'X-Session-ID': sessionId },
    })
    if (response.status === 401 && attempt === 0) {
      await response.body?.cancel()
      credential = await deps.credential(credential.accessToken)
      continue
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`Qoder 模型请求失败（HTTP ${response.status}）${response.status === 401 ? '，请重新登录' : ''}`)
    }
    if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
      await response.body?.cancel()
      throw new Error('Qoder 模型响应不是 SSE 事件流')
    }
    // Sanitize transport/parser errors as well as HTTP errors; never reflect a token-bearing response.
    try { yield* chunksFromOpenAiEvents(checkedEvents(readQoderEvents(response.body))) }
    catch (error) {
      if (signal.aborted) throw signal.reason
      throw new Error(error instanceof Error && error.message.startsWith('Qoder ') ? error.message : 'Qoder 事件流读取失败')
    }
    return
  }
}

/** Preserve SSE event:error and reject malformed JSON instead of losing a frame silently. */
export async function* readQoderEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader(), decoder = new TextDecoder()
  let buffer = ''
  function parse(frame: string): unknown {
    const lines = frame.split('\n')
    if (lines.some(line => /^event:\s*error\s*$/.test(line))) throw new Error('Qoder 返回流式错误')
    const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n').trim()
    if (!data || data === '[DONE]') return undefined
    try { return JSON.parse(data) as unknown } catch { throw new Error('Qoder 返回无效的事件数据') }
  }
  try {
    while (true) {
      const next = await reader.read()
      buffer += next.done ? decoder.decode() : decoder.decode(next.value, { stream: true })
      // Normalize complete CRLFs only; an isolated CR may be half of a split delimiter.
      buffer = buffer.replace(/\r\n/g, '\n')
      let end: number
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const event = parse(buffer.slice(0, end)); buffer = buffer.slice(end + 2)
        if (event !== undefined) yield event
      }
      if (buffer.length > 4 * 1024 * 1024) throw new Error('Qoder 事件超过大小限制')
      if (next.done) { if (buffer.trim()) { const event = parse(buffer); if (event !== undefined) yield event }; return }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}
