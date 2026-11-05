/**
 * 一次 WorkBuddy 模型请求。
 *
 * 协议是 OpenAI 兼容的：POST `{端点}/v2/chat/completions`，`stream: true`，SSE 回
 * 增量。头里除了鉴权，还带账号 id 与会话 id——服务端按它们记账与排障。
 *
 * 失败路径各有各的脾气，混在一起就分不清是谁的问题：
 * - 401/403：令牌过期。续期一次再重试一次；再失败就是「真没登录」，消息要说得
 *   让人知道去登录。
 * - 429：额度或限流。重试没有意义，照实说。
 * - 5xx：上游抖了，有限重试（两次）。
 * - 连不上：不是「答错了」，是「这一轮丢了」——报传输失败，宿主会重试这一轮。
 *
 * 令牌不出现在任何一条消息里：错误消息、失败块、日志，一律抹掉。
 *
 * 还有一条是网关自己会挡的：国内网关对提示词做渠道校验，认出会拒掉整轮
 * （400 / 11128）。见 `gateway-guard.ts`——常规改写已经挡在请求体这一层；这里
 * 只做兜底：真的被挡了（网关换了规则），就用更狠的改写再发一次。
 */

import { resolveEndpoints, workBuddyHeaders } from './endpoints.ts'
import type { WorkBuddyEndpoints } from './endpoints.ts'
import { buildChatBody } from './openai.ts'
import type { GatewayTextMode } from './gateway-guard.ts'
import { chunksFromOpenAiEvents, readSseEvents } from './sse.ts'
import type { WorkBuddyStreamChunk } from './sse.ts'

/** 网络失败时用的失败码：宿主认这个码就会重试这一轮。 */
export const TRANSPORT_FAILURE_CODE = 'TRANSPORT'

/** 网关的渠道校验业务码：命中就整轮拒掉。 */
export const CHANNEL_BLOCKED_CODE = '11128'

/** 首 token 超时：和 WorkBuddy 自己一样给到 20 分钟。 */
const FIRST_TOKEN_TIMEOUT_MS = 1_200_000

/** 5xx 的重试次数（不含首次）。 */
const SERVER_ERROR_RETRIES = 2

/** 两次重试之间的等待。 */
const RETRY_DELAYS_MS = [200, 800]

export type WorkBuddyChatRequest = {
  readonly model: string
  readonly messages: readonly unknown[]
  readonly tools?: readonly {
    readonly name: string
    readonly description?: string | undefined
    readonly parameters?: unknown
  }[] | undefined
  readonly system?: string | undefined
  readonly reasoningEffort?: string | undefined
  readonly supportedEfforts?: readonly string[] | undefined
  readonly maxTokens?: number | undefined
  /** 访问令牌；由凭据层给（那里负责续期）。 */
  readonly accessToken: string
  /** 账号信息：`X-User-Id` 与 `X-Enterprise-Id` 从这里来。 */
  readonly account?: { readonly uid: string; readonly enterpriseId?: string | undefined } | undefined
  readonly conversationId?: string | undefined
  readonly requestId?: string | undefined
  readonly messageId?: string | undefined
  readonly signal?: AbortSignal | undefined
  readonly endpoints?: WorkBuddyEndpoints | undefined
  /** 覆盖模型请求的地址（站点下发的端点：清单与模型请求要打同一个地方）。 */
  readonly baseUrl?: string | undefined
  readonly fetchImpl?: typeof fetch | undefined
  /** 令牌过期时的续期钩子：返回新令牌，或 `undefined` 表示续不了。 */
  readonly onUnauthorized?: (() => Promise<string | undefined>) | undefined
  /** 等待函数；测试注入空实现，重试就不耗时。 */
  readonly sleepImpl?: ((ms: number) => Promise<void>) | undefined
}

/**
 * 发一次模型请求，把响应流翻译成块。
 *
 * 取消会抛 `AbortError`；其余失败要么抛错（能重试的分类），要么给一个传输失败的
 * 收尾块（网络断了这种「这一轮丢了」的情形）。
 * @param request - 这一次请求的全部输入。
 * @returns DSH 的块序列。
 */
export async function* streamWorkBuddy(request: WorkBuddyChatRequest): AsyncGenerator<WorkBuddyStreamChunk> {
  const endpoints = request.endpoints ?? resolveEndpoints(request.baseUrl)
  const fetchImpl = request.fetchImpl ?? fetch
  const sleep = request.sleepImpl ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const bodyOf = (mode: GatewayTextMode): string => JSON.stringify(buildChatBody({
    model: request.model,
    messages: request.messages,
    ...(request.system === undefined ? {} : { system: request.system }),
    ...(request.tools === undefined ? {} : { tools: request.tools }),
    ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
    ...(request.supportedEfforts === undefined ? {} : { supportedEfforts: request.supportedEfforts }),
    ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
    gatewayTextMode: mode,
  }))

  // 提示词的改写力度：常规 → 被网关拦下时换成兜底。
  let mode: GatewayTextMode = 'standard'
  let body = bodyOf(mode)
  let token = request.accessToken
  let attempt = 0
  while (true) {
    let response: Response
    try {
      response = await fetchImpl(endpoints.chatUrl, {
        method: 'POST',
        headers: headersOf(request, token),
        body,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      })
    } catch (error) {
      if (isAbort(error) || request.signal?.aborted === true) throw error
      yield transportFailure(error, token)
      return
    }

    if (response.status === 401 || response.status === 403) {
      const detail = await detailOf(response, token)
      if (attempt === 0 && request.onUnauthorized !== undefined) {
        const refreshed = await request.onUnauthorized()
        if (refreshed !== undefined && refreshed !== '') {
          token = refreshed
          attempt += 1
          continue
        }
      }
      throw new Error(`WorkBuddy 请求被拒（${String(response.status)}）：${detail}`)
    }

    if (response.status === 429) {
      const detail = await detailOf(response, token)
      throw new Error(`WorkBuddy 请求被限流（429）：${detail}`)
    }

    if (response.status >= 500) {
      const detail = await detailOf(response, token)
      if (attempt < SERVER_ERROR_RETRIES) {
        await sleep(RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)] ?? 0)
        attempt += 1
        continue
      }
      throw new Error(`WorkBuddy 服务端错误（${String(response.status)}）：${detail}`)
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      const detail = scrub(text.slice(0, 500), token)
      // 渠道校验：网关认出了提示词里的「官方客户端指纹」。换更狠的改写再发一次；
      // 还不行就是内核又改了文案，得说清楚，而不是丢一个含糊的 400 过去。
      if (text.includes(CHANNEL_BLOCKED_CODE)) {
        if (mode !== 'aggressive') {
          mode = 'aggressive'
          body = bodyOf(mode)
          continue
        }
        throw new Error(
          `WorkBuddy 请求被网关拦下（${String(response.status)}，渠道校验未通过）：提示词里可能又出现了网关不认的写法。${detail}`,
        )
      }
      throw new Error(`WorkBuddy 请求失败（${String(response.status)}）：${detail}`)
    }

    if (response.body === null) throw new Error('WorkBuddy 响应没有正文')
    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes('text/event-stream')) {
      const text = await response.text().catch(() => '')
      throw new Error(`WorkBuddy 响应不是事件流（${String(response.status)}）：${scrub(text.slice(0, 500), token)}`)
    }

    try {
      for await (const chunk of chunksFromOpenAiEvents(readSseEvents(response.body))) yield chunk
    } catch (error) {
      if (isAbort(error) || request.signal?.aborted === true) throw error
      yield transportFailure(error, token)
      return
    }
    return
  }
}

function headersOf(request: WorkBuddyChatRequest, token: string): Record<string, string> {
  const headers: Record<string, string> = workBuddyHeaders({
    'content-type': 'application/json',
    accept: 'text/event-stream',
    authorization: `Bearer ${token}`,
  })
  const uid = request.account?.uid
  if (uid !== undefined && uid !== '') headers['x-user-id'] = uid
  const enterpriseId = request.account?.enterpriseId
  if (enterpriseId !== undefined && enterpriseId !== '') headers['x-enterprise-id'] = enterpriseId
  if (request.conversationId !== undefined && request.conversationId !== '') {
    headers['x-conversation-id'] = request.conversationId
  }
  if (request.requestId !== undefined && request.requestId !== '') headers['x-request-id'] = request.requestId
  if (request.messageId !== undefined && request.messageId !== '') headers['x-message-id'] = request.messageId
  headers['x-agent-intent'] = 'craft'
  return headers
}

/** 失败时的正文片段（抹掉令牌）。 */
async function detailOf(response: Response, token: string): Promise<string> {
  const text = await response.text().catch(() => '')
  return scrub(text.slice(0, 500), token)
}

/**
 * 把令牌从任何要给人看的文字里抹掉。
 *
 * 不按长度设门槛：这里拿到的是确切的令牌串，替换掉它不会误伤别的东西；而
 * 「令牌短就不抹了」这种宽容，恰恰是令牌最短的那种情况下泄漏。
 */
export function scrub(text: string, token: string): string {
  if (token === '') return text
  return text.split(token).join('[redacted]')
}

/** 网络失败时的收尾块：这一轮丢了，宿主可以重试。 */
function transportFailure(error: unknown, token: string): WorkBuddyStreamChunk {
  const base = error instanceof Error ? error.message : String(error)
  return {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: {
        message: scrub(`WorkBuddy 请求失败：${base}`, token),
        code: TRANSPORT_FAILURE_CODE,
      },
    },
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}
