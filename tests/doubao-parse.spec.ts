import { describe, expect, it } from 'vitest'
import { answerDelta, parseTurn } from '../src/doubao/parse.ts'
import type { DomSnapshot } from '../src/doubao/dom.ts'

function snapshot(rows: string[], generating = false): DomSnapshot {
  return {
    url: 'chrome://doubao-chat/chat/38451600002457090',
    conversationId: '38451600002457090',
    generating,
    rows: rows.map(text => ({ text })),
  }
}

describe('doubao turn parsing', () => {
  it('reads the answer that follows the prompt row', () => {
    const turn = parseTurn(snapshot([
      '你好',
      '你好呀😊，有什么想聊的或者需要我帮忙的吗？\n免费',
    ]), '你好')
    expect(turn.answer).toBe('你好呀😊，有什么想聊的或者需要我帮忙的吗？')
    expect(turn.started).toBe(true)
    expect(turn.done).toBe(true)
  })

  it('reports nothing when the prompt was never sent', () => {
    const turn = parseTurn(snapshot(['别的对话']), '你好')
    expect(turn.started).toBe(false)
    expect(turn.done).toBe(false)
    expect(turn.answer).toBe('')
  })

  it('drops the answer banner and the free-tier footer', () => {
    const turn = parseTurn(snapshot([
      '问题',
      'AI 生成可能有误 注意核实\n这是回答\n免费',
    ]), '问题')
    expect(turn.answer).toBe('这是回答')
  })

  it('separates 豆包\'s own tool activity from the answer', () => {
    const turn = parseTurn(snapshot([
      '问题',
      '搜索 1 个关键词，参考 5 篇资料\n这是回答\n免费',
    ]), '问题')
    expect(turn.toolActions).toEqual(['搜索 1 个关键词，参考 5 篇资料'])
    expect(turn.answer).toBe('这是回答')
  })

  it('is not done while the page still generates', () => {
    const turn = parseTurn(snapshot(['问题', '回答到一半'], true), '问题')
    expect(turn.started).toBe(true)
    expect(turn.done).toBe(false)
  })

  it('takes the last matching prompt row', () => {
    const turn = parseTurn(snapshot([
      '问题',
      '第一次回答',
      '问题',
      '第二次回答',
    ]), '问题')
    expect(turn.answer).toBe('第二次回答')
  })

  it('falls back to a row that merely contains the prompt', () => {
    const turn = parseTurn(snapshot(['前缀 问题 后缀', '回答']), '问题')
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

describe('doubao prompt matching', () => {
  it('finds the prompt row when 豆包 rewrote its spacing', () => {
    const turn = parseTurn(snapshot([
      '联网搜索一下「2026 年 11 月 5 日是星期几」，一句话回答。',
      '搜索 1 个关键词，参考 5 篇资料\n2026 年 11 月 5 日是星期四。\n免费',
    ]), '联网搜索一下「2026年11月5日是星期几」，一句话回答。')
    expect(turn.answer).toBe('2026 年 11 月 5 日是星期四。')
    expect(turn.toolActions).toEqual(['搜索 1 个关键词，参考 5 篇资料'])
  })
})
