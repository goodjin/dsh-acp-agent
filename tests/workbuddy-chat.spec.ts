/**
 * 一次 WorkBuddy 模型请求。
 *
 * 这一层是「DSH 的循环」与「WorkBuddy 的模型」之间唯一的一跳，所以钉的是这跳的
 * 契约：打哪个地址、带哪些头、体是什么形状、以及失败时怎么说话。
 *
 * 失败路径各有各的脾气，混在一起就分不清是谁的问题：
 * - 401/403：令牌过期。续期一次再重试一次；再失败就是「真没登录」了。
 * - 429：额度或限流。重试没有意义，照实说。
 * - 5xx：上游抖了，有限重试。
 * - 连不上：不是「答错了」，是「这一轮丢了」，交给宿主重试这一轮。
 *
 * 还有一条贯穿所有路径的：**令牌不出现在任何一条错误消息里**。
 */

import { describe, expect, it } from 'vitest'
import { streamWorkBuddy } from '../src/workbuddy/chat.ts'
import type { WorkBuddyChatRequest } from '../src/workbuddy/chat.ts'
import type { WorkBuddyStreamChunk } from '../src/workbuddy/sse.ts'

const SSE = [
  'data: {"choices":[{"index":0,"delta":{"content":"在"}}]}',
  '',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
  '',
  'data: [DONE]',
  '',
].join('\n')

/** 一段 SSE 响应。 */
function sseResponse(body: string = SSE): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body))
      controller.close()
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/** 收齐一个流里的所有块。 */
async function collect(stream: AsyncIterable<WorkBuddyStreamChunk>): Promise<WorkBuddyStreamChunk[]> {
  const chunks: WorkBuddyStreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

/** 一次请求的默认形状（测试只改自己关心的那几项）。 */
function request(over: Partial<WorkBuddyChatRequest> = {}): WorkBuddyChatRequest {
  return {
    model: 'auto',
    messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
    accessToken: 'TOKEN-1',
    account: { uid: 'uid-1' },
    sleepImpl: async () => {},
    ...over,
  }
}

describe('请求的形状', () => {
  it('打到 chat 地址，带鉴权与账号头，body 是 OpenAI 形状', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const fetchImpl: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} })
      return sseResponse()
    }

    await collect(streamWorkBuddy(request({
      fetchImpl,
      conversationId: 'conv-1',
      requestId: 'req-1',
      messageId: 'msg-1',
      account: { uid: 'uid-1', enterpriseId: 'ent-9' },
    })))

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://www.workbuddy.cn/v2/chat/completions')
    expect(calls[0]?.init.method).toBe('POST')
    const headers = calls[0]?.init.headers as Record<string, string>
    expect(headers['authorization']).toBe('Bearer TOKEN-1')
    expect(headers['accept']).toBe('text/event-stream')
    expect(headers['content-type']).toBe('application/json')
    expect(headers['x-user-id']).toBe('uid-1')
    expect(headers['x-enterprise-id']).toBe('ent-9')
    expect(headers['x-conversation-id']).toBe('conv-1')
    expect(headers['x-request-id']).toBe('req-1')
    expect(headers['x-message-id']).toBe('msg-1')
    const body = JSON.parse(String(calls[0]?.init.body))
    expect(body.model).toBe('auto')
    expect(body.stream).toBe(true)
    expect(body.messages).toEqual([{ role: 'user', content: '你好' }])
  })

  it('没有企业 id 时不带那个头', async () => {
    const calls: { init: RequestInit }[] = []
    const fetchImpl: typeof fetch = async (_url, init) => {
      calls.push({ init: init ?? {} })
      return sseResponse()
    }
    await collect(streamWorkBuddy(request({ fetchImpl })))
    const headers = calls[0]?.init.headers as Record<string, string>
    expect(headers['x-user-id']).toBe('uid-1')
    expect(headers['x-enterprise-id']).toBeUndefined()
  })

  it('请求带客户端标识：站点按 UA 里的产品名认客户端，不带就是 400', async () => {
    const calls: { init: RequestInit }[] = []
    const fetchImpl: typeof fetch = async (_url, init) => {
      calls.push({ init: init ?? {} })
      return sseResponse()
    }
    await collect(streamWorkBuddy(request({ fetchImpl })))
    const headers = calls[0]?.init.headers as Record<string, string>
    expect(headers['user-agent']).toMatch(/^WorkBuddy\//)
  })

  it('站点给的端点可以用：清单与模型请求要打同一个地方', async () => {
    const calls: { url: string }[] = []
    const fetchImpl: typeof fetch = async (url) => {
      calls.push({ url: String(url) })
      return sseResponse()
    }
    await collect(streamWorkBuddy(request({ fetchImpl, baseUrl: 'https://wb.example.com' })))
    expect(calls[0]?.url).toBe('https://wb.example.com/v2/chat/completions')
  })

  it('响应里的内容翻译成块', async () => {
    const fetchImpl: typeof fetch = async () => sseResponse()
    const chunks = await collect(streamWorkBuddy(request({ fetchImpl })))
    expect(chunks[0]).toEqual({ type: 'block-start', index: 0, blockType: 'text' })
    expect(chunks[1]).toEqual({ type: 'text-delta', index: 0, text: '在' })
    expect(chunks[chunks.length - 1]?.type).toBe('finish')
  })
})

describe('失败路径', () => {
  it('401 时续期一次并重试一次；再失败就是没登录', async () => {
    let attempts = 0
    const fetchImpl: typeof fetch = async () => {
      attempts += 1
      return new Response('nope', { status: 401 })
    }
    let refreshed = 0
    const stream = streamWorkBuddy(request({
      fetchImpl,
      onUnauthorized: async () => {
        refreshed += 1
        return 'TOKEN-2'
      },
    }))

    await expect(collect(stream)).rejects.toThrow(/401/)
    expect(refreshed).toBe(1)
    expect(attempts).toBe(2)
  })

  it('续期后成功就接着跑', async () => {
    let attempts = 0
    const fetchImpl: typeof fetch = async (_url, init) => {
      attempts += 1
      if (attempts === 1) return new Response('nope', { status: 401 })
      const headers = (init?.headers ?? {}) as Record<string, string>
      expect(headers['authorization']).toBe('Bearer TOKEN-2')
      return sseResponse()
    }
    const chunks = await collect(streamWorkBuddy(request({
      fetchImpl,
      onUnauthorized: async () => 'TOKEN-2',
    })))
    expect(attempts).toBe(2)
    expect(chunks[1]).toEqual({ type: 'text-delta', index: 0, text: '在' })
  })

  it('429 不重试', async () => {
    let attempts = 0
    const fetchImpl: typeof fetch = async () => {
      attempts += 1
      return new Response('slow down', { status: 429 })
    }
    await expect(collect(streamWorkBuddy(request({ fetchImpl })))).rejects.toThrow(/429/)
    expect(attempts).toBe(1)
  })

  it('5xx 重试到第三次为止', async () => {
    let attempts = 0
    const fetchImpl: typeof fetch = async () => {
      attempts += 1
      return new Response('boom', { status: 500 })
    }
    await expect(collect(streamWorkBuddy(request({ fetchImpl })))).rejects.toThrow(/500/)
    expect(attempts).toBe(3)
  })

  it('连不上时给传输失败，宿主可以重试这一轮', async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error('fetch failed')
    }
    const chunks = await collect(streamWorkBuddy(request({ fetchImpl })))
    const finish = chunks[chunks.length - 1]
    expect(finish?.type === 'finish' ? finish.reason : undefined).toEqual({
      kind: 'error',
      failure: { message: expect.stringContaining('fetch failed'), code: 'TRANSPORT' },
    })
  })

  it('响应不是流时报出状态码与响应片段', async () => {
    const fetchImpl: typeof fetch = async () => new Response('{"error":"bad request"}', { status: 400 })
    await expect(collect(streamWorkBuddy(request({ fetchImpl })))).rejects.toThrow(/400/)
    await expect(collect(streamWorkBuddy(request({ fetchImpl })))).rejects.toThrow(/bad request/)
  })

  it('错误消息里没有令牌', async () => {
    const fetchImpl: typeof fetch = async () => new Response('bad token TOKEN-1 here', { status: 400 })
    let message = ''
    try {
      await collect(streamWorkBuddy(request({ fetchImpl })))
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).not.toContain('TOKEN-1')
    expect(message).toContain('[redacted]')
  })

  it('取消时把中止原样抛出', async () => {
    const controller = new AbortController()
    const fetchImpl: typeof fetch = async () => {
      controller.abort()
      throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    }
    await expect(collect(streamWorkBuddy(request({ fetchImpl, signal: controller.signal }))))
      .rejects.toThrow(/abort/i)
  })
})

describe('网关的渠道校验（11128）', () => {
  const BLOCKED = JSON.stringify({
    code: 11128,
    msg: 'Illegal API invocation from an unapproved channel',
    requestId: 'req-1',
  })

  it('被拦时用兜底力度再发一次，第二次过了就接着跑', async () => {
    const bodies: string[] = []
    let attempts = 0
    const fetchImpl: typeof fetch = async (_url, init) => {
      attempts += 1
      bodies.push(String(init?.body))
      if (attempts === 1) return new Response(BLOCKED, { status: 400 })
      return sseResponse()
    }

    const chunks = await collect(streamWorkBuddy(request({
      fetchImpl,
      system: '另有一段带 @ 的说明文字。',
    })))

    expect(attempts).toBe(2)
    expect(chunks[1]).toEqual({ type: 'text-delta', index: 0, text: '在' })
    // 第一发是常规改写，第二发是兜底：剩下的 @ 也换掉。
    expect(JSON.parse(bodies[0] ?? '{}').messages[0].content).toContain('@')
    expect(JSON.parse(bodies[1] ?? '{}').messages[0].content).not.toContain('@')
  })

  it('两次都被拦时，说清是渠道校验（不是含糊的 400）', async () => {
    let attempts = 0
    const fetchImpl: typeof fetch = async () => {
      attempts += 1
      return new Response(BLOCKED, { status: 400 })
    }
    await expect(collect(streamWorkBuddy(request({ fetchImpl })))).rejects.toThrow(/渠道校验/)
    expect(attempts).toBe(2)
  })

  it('不是渠道校验的 400 不重发', async () => {
    let attempts = 0
    const fetchImpl: typeof fetch = async () => {
      attempts += 1
      return new Response('{"code":11102,"msg":"model service info not found"}', { status: 400 })
    }
    await expect(collect(streamWorkBuddy(request({ fetchImpl })))).rejects.toThrow(/400/)
    expect(attempts).toBe(1)
  })
})
