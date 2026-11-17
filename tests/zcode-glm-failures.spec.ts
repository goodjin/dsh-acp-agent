/**
 * GLM 流的失败映射：5xx/网络类失败交给宿主的有界重试，4xx 终局但可见。
 *
 * 背景（2026-11-17 现场）：HTTP 500（api_error 1234「网络错误…请稍后重试」）
 * 原来裸抛——宿主归类 UNKNOWN，零重试，一击终局。改法与 qoder 行同款：非终局
 * 类失败以 `finish {kind:'error', failure:{message, code}}` 收尾块结束流，宿主的
 * dsh-llm-retry 按代码决定重试（SERVER/TRANSPORT/TIMEOUT 在可重试名单里）。
 * 4xx 是请求本身的问题，重试不会变好——映射成 GLM_REQUEST_REJECTED 终局收尾，
 * 消息可见、不重试。中止保持中止语义。
 */

import { describe, expect, it } from 'vitest'
import { streamGlm } from '../src/zcode/glm.ts'

const KEY = 'test-key-not-a-secret'

function request(fetchImpl: typeof fetch, signal?: AbortSignal) {
  return {
    model: 'glm-5.3',
    maxTokens: 64,
    system: '',
    messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }],
    tools: [],
    apiKey: KEY,
    fetchImpl,
    ...(signal === undefined ? {} : { signal }),
  }
}

/** 收尾块形状断言：最后一个块必须是 finish，且 reason 携带结构化失败。 */
function errorFinishOf(chunks: unknown[]): { code: string; message: string } | undefined {
  const last = chunks.at(-1) as { type?: string; reason?: { kind?: string; failure?: { code: string; message: string } } } | undefined
  if (last?.type !== 'finish' || last.reason?.kind !== 'error') return undefined
  return last.reason.failure
}

describe('GLM 流的失败映射', () => {
  it('HTTP 500：以 SERVER 收尾块结束流，不抛', async () => {
    const fetchImpl = (async () => new Response('{"error":{"message":"网络错误，请稍后重试"}}', { status: 500 })) as typeof fetch
    const chunks: unknown[] = []
    for await (const chunk of streamGlm(request(fetchImpl))) chunks.push(chunk)
    expect(errorFinishOf(chunks)).toMatchObject({ code: 'SERVER' })
  })

  it('HTTP 502/503：同样 SERVER', async () => {
    for (const status of [502, 503]) {
      const fetchImpl = (async () => new Response('bad gateway', { status })) as typeof fetch
      const chunks: unknown[] = []
      for await (const chunk of streamGlm(request(fetchImpl))) chunks.push(chunk)
      expect(errorFinishOf(chunks)).toMatchObject({ code: 'SERVER' })
    }
  })

  it('HTTP 401：GLM_REQUEST_REJECTED 终局收尾（可见、不重试），不抛', async () => {
    const fetchImpl = (async () => new Response('unauthorized', { status: 401 })) as typeof fetch
    const chunks: unknown[] = []
    for await (const chunk of streamGlm(request(fetchImpl))) chunks.push(chunk)
    const failure = errorFinishOf(chunks)
    expect(failure).toMatchObject({ code: 'GLM_REQUEST_REJECTED' })
    expect(failure?.message).toContain('401')
    expect(failure?.message).not.toContain(KEY)
  })

  it('响应体为 null：SERVER（协议异常但可重发）', async () => {
    const fetchImpl = (async () => new Response(null as unknown as ReadableStream<Uint8Array>, { status: 200 })) as typeof fetch
    const chunks: unknown[] = []
    for await (const chunk of streamGlm(request(fetchImpl))) chunks.push(chunk)
    expect(errorFinishOf(chunks)).toMatchObject({ code: 'SERVER' })
  })

  it('网络断（fetch failed）：沿用 TRANSPORT 收尾块', async () => {
    const fetchImpl = (async () => { throw new TypeError('fetch failed') }) as typeof fetch
    const chunks: unknown[] = []
    for await (const chunk of streamGlm(request(fetchImpl))) chunks.push(chunk)
    expect(errorFinishOf(chunks)).toMatchObject({ code: 'TRANSPORT' })
  })

  it('调用方中止照旧上抛（保持中止语义）', async () => {
    const controller = new AbortController()
    controller.abort()
    // 真 fetch 会因为 signal 已中止而拒绝；假件照这个语义写。
    const fetchImpl = (async (_url: unknown, init?: { signal?: AbortSignal }) => {
      if (init?.signal?.aborted === true) throw new DOMException('This operation was aborted', 'AbortError')
      return new Response('x')
    }) as typeof fetch
    await expect(async () => {
      for await (const _chunk of streamGlm(request(fetchImpl, controller.signal))) { /* 消费到抛错为止 */ }
    }).rejects.toThrow()
  })
})
