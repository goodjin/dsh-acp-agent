/**
 * Qoder 国际版的一次模型请求。
 *
 * 核对时间：2026-11-05。请求的形状来自本机 worker 里的 `OFn()`（请求体）与
 * `Wat.openResponse()`（请求头）：
 *
 *   POST {modelBase}/model/v1/chat/completions
 *   Authorization: Bearer <设备令牌>
 *   Accept: text/event-stream
 *   Content-Type: application/json
 *   X-Request-ID / X-Session-ID
 *   Cosy-Version / Cosy-ClientType / Cosy-MachineOS
 *
 * 体是 OpenAI 形状（`model`、`messages`、`stream`、`stream_options`、`tools`…）
 * **外加** `metadata.context`——Qoder 靠它认这次请求属于哪次会话。
 *
 * 三种失败要分清：上游报错、令牌过期、连接中断。**中断不能当成一次成功的空
 * 回答**——那会让用户看到「模型什么都没说」而不是一句错误。
 */

import { randomUUID } from 'node:crypto'
import { baseIdOf } from '../selection.ts'
import { buildChatBody } from '../workbuddy/openai.ts'
import { chunksFromOpenAiEvents, readSseEvents } from '../workbuddy/sse.ts'
import type { WorkBuddyStreamChunk } from '../workbuddy/sse.ts'
import type { CatalogTurnRequest } from '../catalog.ts'
import { qoderIdentityHeaders, resolveEndpoints } from './endpoints.ts'
import type { QoderEndpoints } from './endpoints.ts'
import type { QoderCredential } from './auth.ts'

/** 请求体里带的请求标识。 */
export type QoderBodyInput = {
  readonly model: string
  readonly messages?: readonly unknown[] | undefined
  readonly system?: string | undefined
  readonly tools?: readonly {
    readonly name: string
    readonly description?: string | undefined
    readonly parameters?: Record<string, unknown> | undefined
  }[] | undefined
  readonly maxTokens?: number | undefined
  readonly reasoningEffort?: string | undefined
}

/**
 * 投影成一次模型请求的体。
 *
 * 模型 id 上的 `[档位]` 后缀会被摘掉，档位改走 `reasoning_effort`——Qoder 的
 * 模型 id 里没有后缀，带过去服务端会当成「没有这个模型」。
 */
export function buildQoderBody(request: QoderBodyInput, requestId: string, sessionId: string): Record<string, unknown> {
  const model = baseIdOf(request.model)
  const effort = request.reasoningEffort ?? effortOf(request.model)
  const body = buildChatBody({
    model,
    messages: request.messages ?? [],
    ...(typeof request.system === 'string' ? { system: request.system } : {}),
    ...(request.tools === undefined ? {} : { tools: request.tools }),
    ...(typeof request.maxTokens === 'number' ? { maxTokens: request.maxTokens } : {}),
    ...(effort === undefined ? {} : { reasoningEffort: effort }),
    supportsImages: true,
  })
  return {
    ...body,
    stream_options: { include_usage: true },
    metadata: {
      context: {
        request_id: requestId,
        request_set_id: requestId,
        session_id: sessionId,
        client_type: '5',
      },
    },
  }
}

/** 模型 id 上 `[high]` 这种后缀里的档位。 */
function effortOf(model: string): string | undefined {
  const open = model.lastIndexOf('[')
  if (open === -1 || !model.endsWith(']')) return undefined
  const effort = model.slice(open + 1, -1)
  return effort === '' ? undefined : effort
}

/**
 * 发一次模型请求，读它的流。
 *
 * 令牌被上游拒绝时换一次再试；再被拒绝就结束这一轮（让人重新登录）。
 */
export async function* streamQoder(
  request: CatalogTurnRequest,
  deps: {
    readonly credential: (rejectedToken?: string) => Promise<QoderCredential>
    readonly fetchImpl?: typeof fetch | undefined
    readonly endpoints?: QoderEndpoints | undefined
  },
): AsyncGenerator<WorkBuddyStreamChunk> {
  const endpoints = deps.endpoints ?? resolveEndpoints()
  const requestId = randomUUID()
  const sessionId = typeof request.sessionId === 'string' && request.sessionId !== '' ? request.sessionId : randomUUID()
  const body = JSON.stringify(buildQoderBody({
    model: request.model,
    messages: Array.isArray(request.messages) ? request.messages : [],
    ...(typeof request.system === 'string' ? { system: request.system } : {}),
    ...(request.tools === undefined ? {} : { tools: request.tools }),
    ...(typeof request.maxTokens === 'number' ? { maxTokens: request.maxTokens } : {}),
    ...(typeof request.reasoningEffort === 'string' && request.reasoningEffort !== ''
      ? { reasoningEffort: request.reasoningEffort }
      : {}),
  }, requestId, sessionId))
  const signal = AbortSignal.any([
    AbortSignal.timeout(300_000),
    ...(request.signal instanceof AbortSignal ? [request.signal] : []),
  ])
  signal.throwIfAborted()
  const fetchImpl = deps.fetchImpl ?? fetch
  let credential = await deps.credential()
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetchImpl(endpoints.chatUrl, {
      method: 'POST',
      body,
      signal,
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${credential.accessToken}`,
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
        'X-Request-ID': requestId,
        'X-Session-ID': sessionId,
        ...qoderIdentityHeaders(),
      },
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
    try {
      yield* chunksFromOpenAiEvents(checkedEvents(readSseEvents(response.body)))
    } catch (error) {
      if (signal.aborted) throw signal.reason
      // 传输/解析错误也要收拾干净：不能把带令牌的原文反射出去。
      throw new Error(error instanceof Error && error.message.startsWith('Qoder ') ? error.message : 'Qoder 事件流读取失败')
    }
    return
  }
}

/**
 * 盯着事件流：上游报错就抛错；流结束时没有结束帧就是中断。
 *
 * 「没有结束帧」不是一次成功的空回答——那会让用户以为模型不想说话。
 */
async function* checkedEvents(events: AsyncIterable<unknown>): AsyncGenerator<unknown> {
  let finished = false
  for await (const event of events) {
    const data = record(event)
    if (data['error'] !== undefined || data['error_code'] !== undefined) {
      throw new Error('Qoder 返回模型错误，请检查账号与模型权限')
    }
    const choices = Array.isArray(data['choices']) ? data['choices'] : []
    for (const choice of choices) {
      const reason = record(choice)['finish_reason']
      if (typeof reason === 'string' && reason !== '') finished = true
    }
    yield event
  }
  if (!finished) throw new Error('Qoder 响应中断：没有收到结束帧')
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
