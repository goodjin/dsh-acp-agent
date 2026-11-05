import { describe, expect, it } from 'vitest'
import { answerDelta, parseTurn } from '../src/doubao/parse.ts'
import type { DomBlock, DomSnapshot } from '../src/doubao/dom.ts'

function block(kind: DomBlock['kind'], text: string, href?: string): DomBlock {
  return href === undefined ? { kind, text } : { kind, text, href }
}

/** A snapshot with one user message (the prompt) and the assistant's blocks. */
function snapshot(assistant: DomBlock[], generating = false): DomSnapshot {
  return {
    url: 'chrome://doubao-chat/chat/38451600002457090',
    conversationId: '38451600002457090',
    generating,
    messages: [
      { role: 'user', blocks: [block('text', '问题')] },
      { role: 'assistant', blocks: assistant },
    ],
  }
}

describe('doubao turn parsing', () => {
  it('reads the answer that follows the prompt', () => {
    const turn = parseTurn(snapshot([
      block('text', '你好呀😊，有什么想聊的或者需要我帮忙的吗？'),
      block('noise', '免费'),
    ]), '问题')
    expect(turn.answer).toBe('你好呀😊，有什么想聊的或者需要我帮忙的吗？')
    expect(turn.started).toBe(true)
    // The footer (`免费`) is the page's own "this message is finished" mark.
    expect(turn.complete).toBe(true)
  })

  it('reports nothing when the prompt was never sent', () => {
    const turn = parseTurn({
      url: 'chrome://doubao-chat/chat/1',
      generating: false,
      messages: [
        { role: 'user', blocks: [block('text', '别的对话')] },
        { role: 'assistant', blocks: [block('text', '别的回答')] },
      ],
    }, '问题')
    expect(turn.started).toBe(false)
    expect(turn.answer).toBe('')
  })

  it('drops the answer banner and the free-tier footer', () => {
    const turn = parseTurn(snapshot([
      block('text', 'AI 生成可能有误 注意核实'),
      block('text', '这是回答'),
      block('noise', '免费'),
    ]), '问题')
    expect(turn.answer).toBe('这是回答')
  })

  it('separates 豆包\'s own tool activity from the answer', () => {
    const turn = parseTurn(snapshot([
      block('text', '搜索 1 个关键词，参考 5 篇资料'),
      block('text', '这是回答'),
      block('noise', '免费'),
    ]), '问题')
    expect(turn.trace).toEqual(['搜索 1 个关键词，参考 5 篇资料'])
    expect(turn.answer).toBe('这是回答')
  })

  it('splits the agent trace from the answer in 工作模式', () => {
    const turn = parseTurn(snapshot([
      block('step', '查询存储芯片相关资讯'),
      block('text', '我来搜索今天关于存储芯片的新闻。'),
      block('step', '整理存储芯片今日资讯'),
      block('text', '已找到今天（11 月 5 日）关于存储芯片的三条新闻：'),
      block('text', '1. 存储股较高点接近腰斩！…'),
      block('link', '腾讯新闻（财联社）', 'https://news.qq.com/xxx'),
      block('noise', '免费'),
    ]), '问题')
    expect(turn.trace).toEqual([
      '查询存储芯片相关资讯',
      '我来搜索今天关于存储芯片的新闻。',
      '整理存储芯片今日资讯',
    ])
    expect(turn.answer).toBe([
      '已找到今天（11 月 5 日）关于存储芯片的三条新闻：',
      '1. 存储股较高点接近腰斩！…',
      '腾讯新闻（财联社）',
    ].join('\n'))
    expect(turn.links).toEqual([{ text: '腾讯新闻（财联社）', href: 'https://news.qq.com/xxx' }])
  })

  it('is not complete while the message has no footer yet', () => {
    const turn = parseTurn(snapshot([block('text', '回答到一半')], true), '问题')
    expect(turn.started).toBe(true)
    expect(turn.complete).toBe(false)
  })

  it('takes the last matching prompt row', () => {
    const turn = parseTurn({
      url: 'chrome://doubao-chat/chat/1',
      generating: false,
      messages: [
        { role: 'user', blocks: [block('text', '问题')] },
        { role: 'assistant', blocks: [block('text', '第一次回答')] },
        { role: 'user', blocks: [block('text', '问题')] },
        { role: 'assistant', blocks: [block('text', '第二次回答')] },
      ],
    }, '问题')
    expect(turn.answer).toBe('第二次回答')
  })

  it('falls back to a row that merely contains the prompt', () => {
    const turn = parseTurn({
      url: 'chrome://doubao-chat/chat/1',
      generating: false,
      messages: [
        { role: 'user', blocks: [block('text', '前缀 问题 后缀')] },
        { role: 'assistant', blocks: [block('text', '回答')] },
      ],
    }, '问题')
    expect(turn.answer).toBe('回答')
  })
})

describe('doubao answer deltas', () => {
  it('returns the appended tail', () => {
    expect(answerDelta('你好', '你好呀')).toBe('呀')
  })

  it('returns nothing when the answer did not change', () => {
    expect(answerDelta('你好', '你好')).toBe('')
  })

  it('returns the whole text when the answer was rewritten', () => {
    expect(answerDelta('你好', '重新生成的回答')).toBe('重新生成的回答')
  })
})
