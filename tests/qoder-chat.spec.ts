import { describe, expect, it, vi } from 'vitest'
import { buildQoderBody, streamQoder } from '../src/qoder/chat.ts'
import type { QoderCredential } from '../src/qoder/auth.ts'

const credential: QoderCredential = { accessToken: 'tok', refreshToken: 'r1', machineId: 'mid' }
const request = { model: 'qwen3.8-max', messages: [{ role: 'user', content: 'hello' }] }

function sse(events: unknown[]): Response {
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', {
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const chunks: unknown[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('Qoder 国际版的模型请求', () => {
  it('请求体带上 metadata.context 与流式开关', () => {
    const body = buildQoderBody({ ...request, system: 'system', maxTokens: 128 }, 'rid', 'sid')
    expect(body['model']).toBe('qwen3.8-max')
    expect(body['stream']).toBe(true)
    expect(body['stream_options']).toEqual({ include_usage: true })
    expect(body['metadata']).toEqual({
      context: { request_id: 'rid', request_set_id: 'rid', session_id: 'sid', client_type: '5' },
    })
    expect((body['messages'] as { role: string }[])[0]).toEqual({ role: 'system', content: 'system' })
  })

  it('模型 id 上的档位后缀会被摘掉，档位改走 reasoning_effort', () => {
    const body = buildQoderBody({ model: 'qwen3.8-max[high]', messages: [] }, 'rid', 'sid')
    expect(body['model']).toBe('qwen3.8-max')
    expect(body['reasoning_effort']).toBe('high')
  })

  it('请求打对了地址并带齐头', async () => {
    const mock = vi.fn().mockResolvedValue(sse([
      { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] },
    ]))
    await collect(streamQoder(request, { credential: async () => credential, fetchImpl: mock }))
    const [url, init] = mock.mock.calls[0]!
    expect(url).toBe('https://api2-v2.qoder.sh/model/v1/chat/completions')
    const headers = init.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer tok')
    expect(headers['Accept']).toBe('text/event-stream')
    expect(headers['Content-Type']).toBe('application/json')
    expect(headers['X-Request-ID']).toBeTruthy()
    expect(headers['X-Session-ID']).toBeTruthy()
    expect(headers['Cosy-ClientType']).toBe('5')
    expect(init.method).toBe('POST')
  })

  it('401 时续期一次再重试', async () => {
    const mock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(sse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]))
    const resolve = vi.fn().mockResolvedValue(credential)
    const chunks = await collect(streamQoder(request, { credential: resolve, fetchImpl: mock }))
    expect(resolve.mock.calls[1]).toEqual(['tok'])
    expect(mock).toHaveBeenCalledTimes(2)
    expect(chunks.length).toBeGreaterThan(0)
  })

  it('401 之后再失败就报需要重新登录', async () => {
    const mock = vi.fn().mockResolvedValue(new Response('', { status: 401 }))
    await expect(collect(streamQoder(request, {
      credential: vi.fn().mockResolvedValue(credential),
      fetchImpl: mock,
    }))).rejects.toThrow('登录')
  })

  it('断流不算成功', async () => {
    await expect(collect(streamQoder(request, {
      credential: async () => credential,
      fetchImpl: vi.fn().mockResolvedValue(sse([{ choices: [{ delta: { content: '半句' } }] }])),
    }))).rejects.toThrow('中断')
  })

  it('错误帧不算成功，错误信息里不反射令牌', async () => {
    await expect(collect(streamQoder(request, {
      credential: async () => credential,
      fetchImpl: vi.fn().mockResolvedValue(sse([{ error: { message: 'tok' } }])),
    }))).rejects.toThrow('Qoder')
    await expect(collect(streamQoder(request, {
      credential: async () => credential,
      fetchImpl: vi.fn().mockResolvedValue(sse([{ error: { message: 'tok' } }])),
    }))).rejects.not.toThrow(/tok/)
  })

  it('不是事件流的应答直接报错', async () => {
    await expect(collect(streamQoder(request, {
      credential: async () => credential,
      fetchImpl: vi.fn().mockResolvedValue(new Response('{}', { headers: { 'Content-Type': 'application/json' } })),
    }))).rejects.toThrow('事件流')
  })

  it('已经取消的回合不再发请求', async () => {
    const controller = new AbortController()
    controller.abort()
    const mock = vi.fn()
    await expect(collect(streamQoder({ ...request, signal: controller.signal }, {
      credential: async () => credential,
      fetchImpl: mock,
    }))).rejects.toThrow()
    expect(mock).not.toHaveBeenCalled()
  })
})
