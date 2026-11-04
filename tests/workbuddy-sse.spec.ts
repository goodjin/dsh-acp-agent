/**
 * WorkBuddy 的 SSE 解析与增量翻译。
 *
 * WorkBuddy 的模型响应是 OpenAI 形状的流：每一帧 `data:` 一个 JSON，增量在
 * `choices[0].delta` 里，工具调用的参数跨帧到达。这一层要把它翻译成 DSH 循环
 * 认得的块词汇（开块 → 增量 → 收块 → 用量 → 结束）。
 *
 * 钉住的四件事：
 * 1. 文本与推理各自成块，块序号按首次出现顺序分配（循环靠它把内容摆回原位）；
 * 2. **工具调用的参数跨帧到达时必须按 index 归并成一个完整调用**——名字在第一帧、
 *    参数在后面几帧，拼接错一次就是半截 JSON，工具直接执行失败；
 * 3. 结束原因与用量的翻译；
 * 4. 畸形帧（不是 JSON）跳过而不是炸掉整轮。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { chunksFromOpenAiEvents, readSseEvents } from '../src/workbuddy/sse.ts'
import type { WorkBuddyFinish, WorkBuddyStreamChunk } from '../src/workbuddy/sse.ts'

const FIXTURE = fileURLToPath(new URL('./fixtures/workbuddy-stream.sse.txt', import.meta.url))

/** 把一串事件对象变成异步可迭代。 */
async function* iterate(events: readonly unknown[]): AsyncGenerator<unknown> {
  for (const event of events) yield event
}

/** 把一串事件对象喂进翻译器，收齐所有块。 */
async function translate(events: readonly unknown[]): Promise<WorkBuddyStreamChunk[]> {
  const chunks: WorkBuddyStreamChunk[] = []
  for await (const chunk of chunksFromOpenAiEvents(iterate(events))) chunks.push(chunk)
  return chunks
}

/** 一帧文本增量。 */
function textFrame(text: string): unknown {
  return { choices: [{ index: 0, delta: { content: text } }] }
}

/** 一帧工具调用增量。 */
function toolFrame(index: number, part: Record<string, unknown>): unknown {
  return { choices: [{ index: 0, delta: { tool_calls: [{ index, ...part }] } }] }
}

/** 文本帧拼成的字节流。 */
function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
}

/** 只留下收块的那一类。 */
function isBlockEnd(chunk: WorkBuddyStreamChunk): chunk is Extract<WorkBuddyStreamChunk, { type: 'block-end' }> {
  return chunk.type === 'block-end'
}

/** 最后一块的结束原因。 */
function finishReason(chunks: readonly WorkBuddyStreamChunk[]): WorkBuddyFinish | undefined {
  const last = chunks[chunks.length - 1]
  return last !== undefined && last.type === 'finish' ? last.reason : undefined
}

describe('SSE 读取', () => {
  it('按帧读出 JSON，跳过畸形帧与 [DONE]', async () => {
    const body = streamOf([
      'data: {"a":1}',
      '',
      'data: 不是 JSON',
      '',
      'data: {"b":2}',
      '',
      'data: [DONE]',
      '',
    ].join('\n'))
    const events: unknown[] = []
    for await (const event of readSseEvents(body)) events.push(event)
    expect(events).toEqual([{ a: 1 }, { b: 2 }])
  })
})

describe('增量翻译', () => {
  it('文本增量合成一个块，先开块再收块', async () => {
    const chunks = await translate([textFrame('你'), textFrame('好')])
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '你' },
      { type: 'text-delta', index: 0, text: '好' },
      { type: 'block-end', index: 0, block: { type: 'text', text: '你好' } },
      { type: 'finish', reason: { kind: 'stop' }, replayState: { response: { stopReason: 'stop' }, blocks: [{}] } },
    ])
  })

  it('推理内容另起一块', async () => {
    const chunks = await translate([
      { choices: [{ index: 0, delta: { reasoning_content: '想了一下' } }] },
      textFrame('答案'),
    ])
    expect(chunks[0]).toEqual({ type: 'block-start', index: 0, blockType: 'reasoning' })
    expect(chunks[1]).toEqual({ type: 'reasoning-delta', index: 0, text: '想了一下' })
    expect(chunks[2]).toEqual({ type: 'block-start', index: 1, blockType: 'text' })
    expect(chunks[3]).toEqual({ type: 'text-delta', index: 1, text: '答案' })
  })

  it('工具调用的参数跨帧到达时归并成一个完整调用', async () => {
    const chunks = await translate([
      toolFrame(0, { id: 'call_1', type: 'function', function: { name: 'Bash', arguments: '' } }),
      toolFrame(0, { function: { arguments: '{"cmd":' } }),
      toolFrame(0, { function: { arguments: '"ls"}' } }),
    ])
    const ended = chunks.filter(isBlockEnd)
    const callBlocks = ended.filter(end => end.block.type === 'tool-call')
    expect(callBlocks).toHaveLength(1)
    expect(callBlocks[0]?.block).toEqual({ type: 'tool-call', id: 'call_1', name: 'Bash', arguments: '{"cmd":"ls"}' })
    // 名字只在第一帧出现：后面的帧只带参数增量，不重复带名字。
    const deltas = chunks.filter(chunk => chunk.type === 'tool-call-delta')
    expect(deltas[0]?.name).toBe('Bash')
    expect(deltas[1]?.name).toBeUndefined()
  })

  it('两个工具调用交错时各自成块，参数不串', async () => {
    const chunks = await translate([
      toolFrame(0, { id: 'call_a', type: 'function', function: { name: 'Read', arguments: '' } }),
      toolFrame(1, { id: 'call_b', type: 'function', function: { name: 'Bash', arguments: '' } }),
      toolFrame(0, { function: { arguments: '{"path":"a"}' } }),
      toolFrame(1, { function: { arguments: '{"cmd":"ls"}' } }),
    ])
    const ends = chunks.filter(isBlockEnd)
    expect(ends).toEqual([
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_a', name: 'Read', arguments: '{"path":"a"}' } },
      { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'call_b', name: 'Bash', arguments: '{"cmd":"ls"}' } },
    ])
  })

  it('结束原因与用量各翻各的', async () => {
    const chunks = await translate([
      textFrame('好'),
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } },
    ])
    const usage = chunks.find(chunk => chunk.type === 'usage')
    expect(usage).toEqual({ type: 'usage', usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 } })
    expect(finishReason(chunks)).toEqual({ kind: 'tool-calls' })
  })

  it('长度上限与正常结束分得开', async () => {
    const stopped = await translate([{ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }])
    expect(finishReason(stopped)).toEqual({ kind: 'stop' })
    const truncated = await translate([{ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }])
    expect(finishReason(truncated)).toEqual({ kind: 'max-tokens' })
  })

  it('没有 choices 的帧不产出块', async () => {
    const chunks = await translate([{ object: 'ping' }, textFrame('在')])
    expect(chunks[0]).toEqual({ type: 'block-start', index: 0, blockType: 'text' })
  })
})

describe('整条流', () => {
  it('夹具里的那段流翻译出文本、工具调用、用量与结束', async () => {
    const body = streamOf(readFileSync(FIXTURE, 'utf8'))
    const chunks: WorkBuddyStreamChunk[] = []
    for await (const chunk of chunksFromOpenAiEvents(readSseEvents(body))) chunks.push(chunk)

    const ends = chunks.filter(isBlockEnd)
    expect(ends).toEqual([
      { type: 'block-end', index: 0, block: { type: 'text', text: '你好，世界' } },
      { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'call_1', name: 'Bash', arguments: '{"cmd":"ls"}' } },
    ])
    expect(chunks.find(chunk => chunk.type === 'usage')).toEqual({
      type: 'usage',
      usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
    })
    expect(finishReason(chunks)).toEqual({ kind: 'tool-calls' })
  })
})
