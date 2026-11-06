/**
 * 复制会话时，工具调用与结果必须配好对再写进新会话。
 *
 * 源会话的日志里，一个后台子代理调用的结果可能写在日志尾部，而不紧跟它
 * 应答的调用（回合被打断时的恢复就是这么写的）。这份记录对视图是忠实的，
 * 但切到原生 DeepSeek 后，宿主的原生适配器要求每个 tool/call 在紧随其后的
 * 消息里有结果，否则整轮请求报
 * "DeepSeek Messages tool calls need immediate results"（2026-11-07 现场，
 * session-fd1a44d3 最后一次切换）。请求出站的路径已经有 pairToolResults
 * （model-plugins.ts），复制入档的路径此前没有——本仓一个工具、两个出口，
 * 只修一个出口就是这次的教训。
 */

import { describe, expect, it } from 'vitest'
import { planReplay } from '../src/replay.ts'
import type { LoggedEvent } from '../src/replay.ts'

const call = (callId: string): LoggedEvent => ({
  type: 'tool/call',
  data: { callId, name: 'bash', arguments: '{}' },
})
const resultAt = (callId: string): LoggedEvent => ({
  type: 'tool/result',
  surfaceOp: 'append',
  data: { message: { role: 'tool', toolCallId: callId, content: [{ type: 'text', text: 'ok' }] } },
})
const assistantWithCall = (callId: string): LoggedEvent => ({
  type: 'assistant/message',
  surfaceOp: 'append',
  data: { message: { role: 'assistant', content: [{ type: 'tool-call', id: callId, name: 'bash' }] } },
})

describe('planReplay 的工具配对', () => {
  it('日志尾部的结果被搬回它应答的调用之后', () => {
    // 顺序忠实于真实日志：调用 A、调用 B、B 的结果、A 的结果（A 是后台调用，
    // 结果落在回合尾部）。
    const events: LoggedEvent[] = [
      { type: 'turn/start', data: {} },
      assistantWithCall('call-a'),
      call('call-a'),
      assistantWithCall('call-b'),
      call('call-b'),
      resultAt('call-b'),
      resultAt('call-a'),
      { type: 'turn/end', data: {} },
    ]
    const plan = planReplay(events)
    const types = plan.steps.map(step => step.type)
    // 每个调用之后立刻跟着它的结果：结果只会在 tool/call 之后一位出现。
    for (let i = 0; i < plan.steps.length; i++) {
      if (plan.steps[i]!.type !== 'tool/call') continue
      expect(plan.steps[i + 1]?.type, `tool/call at ${i} must be followed by its result`).toBe('tool/result')
    }
    expect(types).toContain('tool/result')
  })

  it('没有结果的后台调用补一条「结果未知」的结果，而不是裸调用', () => {
    const events: LoggedEvent[] = [
      { type: 'turn/start', data: {} },
      assistantWithCall('call-open'),
      call('call-open'),
      { type: 'turn/end', data: {} },
    ]
    const plan = planReplay(events)
    for (let i = 0; i < plan.steps.length; i++) {
      if (plan.steps[i]!.type !== 'tool/call') continue
      const next = plan.steps[i + 1]
      expect(next?.type).toBe('tool/result')
      const message = (next?.data as { message?: { toolCallId?: string; isError?: boolean } }).message
      expect(message?.toolCallId).toBe('call-open')
      expect(message?.isError).toBe(true)
    }
  })
})
