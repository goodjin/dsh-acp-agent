import { describe, expect, it } from 'vitest'
import { DoubaoAcpAgent, type DoubaoBrowserLike } from '../src/doubao/agent.ts'
import type { DomSnapshot } from '../src/doubao/dom.ts'

/** A browser that replays a fixed sequence of page states. */
class FakeBrowser implements DoubaoBrowserLike {
  readonly sent: string[] = []
  stopped = 0
  closed = 0
  private index = 0

  constructor(private readonly states: DomSnapshot[]) {}

  async snapshot(): Promise<DomSnapshot> {
    const state = this.states[Math.min(this.index, this.states.length - 1)]
    this.index += 1
    return state!
  }

  async sendPrompt(text: string): Promise<void> {
    this.sent.push(text)
  }

  async stopGeneration(): Promise<void> {
    this.stopped += 1
  }

  async close(): Promise<void> {
    this.closed += 1
  }
}

function state(rows: string[], generating = false): DomSnapshot {
  return {
    url: 'chrome://doubao-chat/chat/1',
    conversationId: '1',
    generating,
    rows: rows.map(text => ({ text })),
  }
}

describe('the doubao ACP agent', () => {
  it('answers initialize and opens a session', async () => {
    const agent = new DoubaoAcpAgent({ openBrowser: async () => new FakeBrowser([]) })
    const initialize = await agent.handle('initialize', {}) as { protocolVersion: number }
    expect(initialize.protocolVersion).toBe(1)
    const session = await agent.handle('session/new', {}) as { sessionId: string; models: { availableModels: { id: string }[] } }
    expect(session.sessionId).toMatch(/^doubao-/)
    expect(session.models.availableModels[0]?.id).toBe('doubao-default')
  })

  it('turns the page into answer chunks and tool frames', async () => {
    const browser = new FakeBrowser([
      state(['问题', '搜索 1 个关键词，参考 5 篇资料\n答案开头'], true),
      state(['问题', '搜索 1 个关键词，参考 5 篇资料\n答案开头\n答案结尾'], false),
    ])
    const agent = new DoubaoAcpAgent({ openBrowser: async () => browser, pollIntervalMs: 1 })
    const frames: { method: string; params: { update: { sessionUpdate: string; content?: { text?: string }; title?: string } } }[] = []
    agent.notify = frame => frames.push(frame as never)
    const session = await agent.handle('session/new', {}) as { sessionId: string }
    const reply = await agent.handle('session/prompt', {
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: '问题' }],
    }) as { stopReason: string }

    expect(reply.stopReason).toBe('end_turn')
    expect(browser.sent).toEqual(['问题'])
    const texts = frames
      .filter(frame => frame.params.update.sessionUpdate === 'agent_message_chunk')
      .map(frame => frame.params.update.content?.text ?? '')
      .join('')
    expect(texts).toContain('答案开头')
    expect(texts).toContain('答案结尾')
    const tools = frames.filter(frame => frame.params.update.sessionUpdate === 'tool_call')
    expect(tools).toHaveLength(1)
    expect(tools[0]?.params.update.title).toBe('搜索 1 个关键词，参考 5 篇资料')
  })

  it('stops the page when the turn is cancelled', async () => {
    const browser = new FakeBrowser([state(['问题', '答案开头'], true)])
    const agent = new DoubaoAcpAgent({ openBrowser: async () => browser, pollIntervalMs: 1 })
    const session = await agent.handle('session/new', {}) as { sessionId: string }
    await agent.handle('session/cancel', { sessionId: session.sessionId })
    const reply = await agent.handle('session/prompt', {
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: '问题' }],
    }) as { stopReason: string }
    expect(reply.stopReason).toBe('cancelled')
    expect(browser.stopped).toBe(1)
  })

  it('refuses an unknown session', async () => {
    const agent = new DoubaoAcpAgent({ openBrowser: async () => new FakeBrowser([]) })
    await expect(agent.handle('session/prompt', { sessionId: 'nope', prompt: [] })).rejects.toThrow(/unknown session/)
  })

  it('reads the user text out of an ACP prompt', () => {
    expect(DoubaoAcpAgent.promptText([{ type: 'text', text: '一' }, { type: 'text', text: '二' }])).toBe('一\n二')
    expect(DoubaoAcpAgent.promptText([{ type: 'image', data: 'x' }])).toBe('')
  })
})
