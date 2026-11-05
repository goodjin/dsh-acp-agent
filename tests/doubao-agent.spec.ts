import { describe, expect, it } from 'vitest'
import { DoubaoAcpAgent, type DoubaoBrowserLike } from '../src/doubao/agent.ts'
import type { DomBlock, DomSnapshot } from '../src/doubao/dom.ts'

/** A browser that replays a fixed sequence of page states. */
class FakeBrowser implements DoubaoBrowserLike {
  readonly sent: string[] = []
  stopped = 0
  closed = 0
  newChats = 0
  workModes = 0
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

  async startNewChat(): Promise<boolean> {
    this.newChats += 1
    return true
  }

  async enterWorkMode(): Promise<boolean> {
    this.workModes += 1
    return true
  }

  async close(): Promise<void> {
    this.closed += 1
  }
}

function block(kind: DomBlock['kind'], text: string): DomBlock {
  return { kind, text }
}

function state(blocks: DomBlock[], generating = false): DomSnapshot {
  return {
    url: 'chrome://doubao-chat/chat/1',
    conversationId: '1',
    generating,
    messages: [
      { role: 'user', blocks: [block('text', '问题')] },
      { role: 'assistant', blocks },
    ],
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
      state([
        block('step', '查询存储芯片相关资讯'),
        block('text', '我来搜索今天关于存储芯片的新闻。'),
        block('step', '整理存储芯片今日资讯'),
        block('text', '已找到今天的三条新闻：'),
      ], true),
      state([
        block('step', '查询存储芯片相关资讯'),
        block('text', '我来搜索今天关于存储芯片的新闻。'),
        block('step', '整理存储芯片今日资讯'),
        block('text', '已找到今天的三条新闻：'),
        block('text', '答案是星期四。'),
      ], false),
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
    // The conversation starts in 工作模式, where 豆包 answers like an agent.
    expect(browser.newChats).toBe(1)
    expect(browser.workModes).toBe(1)
    const texts = frames
      .filter(frame => frame.params.update.sessionUpdate === 'agent_message_chunk')
      .map(frame => frame.params.update.content?.text ?? '')
      .join('')
    expect(texts).toContain('已找到今天的三条新闻：')
    expect(texts).toContain('答案是星期四。')
    const tools = frames.filter(frame => frame.params.update.sessionUpdate === 'tool_call')
    expect(tools.map(frame => frame.params.update.title)).toEqual([
      '查询存储芯片相关资讯',
      '我来搜索今天关于存储芯片的新闻。',
      '整理存储芯片今日资讯',
    ])
  })

  it('stops the page when the turn is cancelled', async () => {
    const browser = new FakeBrowser([state([block('text', '答案开头')], true)])
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

describe('the doubao ACP agent, method coverage', () => {
  it('accepts the mode and model the host sets after opening', async () => {
    const agent = new DoubaoAcpAgent({ openBrowser: async () => new FakeBrowser([]) })
    const session = await agent.handle('session/new', {}) as { sessionId: string }
    expect(await agent.handle('session/set_mode', { sessionId: session.sessionId, modeId: 'default' })).toEqual({})
    expect(await agent.handle('session/set_model', { sessionId: session.sessionId, modelId: 'doubao-default' })).toEqual({})
    expect(await agent.handle('session/set_config_option', { sessionId: session.sessionId, configOptionId: 'x', value: 'y' })).toEqual({})
  })

  it('answers an optional method it does not implement the standard way', async () => {
    const agent = new DoubaoAcpAgent({ openBrowser: async () => new FakeBrowser([]) })
    await expect(agent.handle('session/load', { sessionId: 'x' })).rejects.toMatchObject({ code: -32601 })
  })
})
