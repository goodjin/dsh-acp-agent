/**
 * 软接管引导语（delegationHint）：让外部 agent 优先用我们的委派工具。
 *
 * 挂上 MCP 服务器（Task 7）之后，外部 agent 能看到 `delegate` 工具了，但它
 * 自己也还带着原生委派工具（codex 的 collab、claude 的 Task、cursor 的
 * task、grok 的 spawn_subagent）——不点一句就默认用自家的。这一轮是「软」
 * 接管：不关原生工具，只在发给 agent 的 prompt 里带一句引导，让模型更可能
 * 选我们的。
 *
 * 分层各测各的：
 *   1. runner——run 与 runSteps 两条 prompt 组装路径都带（外部 agent 常走
 *      分段那条，只加一处会让最需要引导的路径裸奔）；开关缺省/false 不带，
 *      prompt 与今天逐字节一致。
 *   2. runner——引导语只进 prompt 载荷：用户没说过这句话，会话日志里不能
 *      出现。
 *   3. factory——预设配置的 delegationHint 在两条建会话路径（open 与
 *      openShared→openSession）上都接进 prompt，配置写了就生效。
 *   4. 入口——schema 列了这个字段（loader 归一化不丢，stallMs 踩过的老
 *      坑），apply 把它接进预设（跨文件钉子：字段加了类型忘了接映射时，
 *      配置写了也不生效）。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { claudeDialect } from '../src/index.ts'
import type { AcpTransport } from '../src/index.ts'
import { AcpTurnRunner } from '../src/runner.ts'
import type { AcpClientPort } from '../src/runner.ts'
import { makeSessionFactory } from '../src/factory.ts'
import type { PresetConfig } from '../src/registry.ts'
import { Config as EntryConfig } from '../src/entry.ts'

/** 记录每次请求的假 client（照 mcp-attach 的立桩法）。 */
function fakeClient() {
  const calls: { method: string; params: unknown }[] = []
  const client: AcpClientPort & { calls: typeof calls } = {
    calls,
    request: async (method, params) => {
      calls.push({ method, params })
      if (method === 'session/new') return { sessionId: 's1' }
      if (method === 'session/prompt') return { stopReason: 'end_turn' }
      return {}
    },
    notify: () => {},
    onFrame: () => {},
  }
  return client
}

const DECISION = { kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] } as const
const TURN = (sessionId: string) => ({ sessionId, position: { turn: 1, step: 1 }, produce: () => [], write: () => 1 })

/** 取 `session/prompt` 发出的文本块——引导语只可能出现在这里。 */
function promptTextOf(calls: readonly { method: string; params: unknown }[]): string {
  const prompt = calls.find(call => call.method === 'session/prompt')!
  const blocks = (prompt.params as { prompt: { type: string; text?: string }[] }).prompt
  return (blocks.find(block => block.type === 'text') as { text: string }).text
}

describe('AcpTurnRunner — 两条 prompt 组装路径都带引导语', () => {
  it('run 路径：开关打开时 prompt 点名词具 delegate，并明说别用自带的', async () => {
    const client = fakeClient()
    await new AcpTurnRunner(client, { cwd: '/tmp', delegationHint: true }).run(DECISION, TURN('s1'))

    const text = promptTextOf(client.calls)
    expect(text).toContain('delegate')
    expect(text).toContain('不要用你自带的')
    // 用户文本在前、引导语拼在后面：会话轮到模型时先读到人的话。
    expect(text.startsWith('hi')).toBe(true)
  })

  it('runSteps 路径：开关打开时首段 prompt 同样带（外部 agent 常走这条）', async () => {
    const client = fakeClient()
    const runner = new AcpTurnRunner(client, { cwd: '/tmp', dialect: claudeDialect, delegationHint: true })
    await runner.runSteps(DECISION, TURN('s1'), { first: true })

    const text = promptTextOf(client.calls)
    expect(text).toContain('delegate')
    expect(text).toContain('不要用你自带的')
    expect(text.startsWith('hi')).toBe(true)
  })

  it('开关缺省（run 路径）：prompt 与今天逐字节一致，一个字都不多', async () => {
    const client = fakeClient()
    await new AcpTurnRunner(client, { cwd: '/tmp' }).run(DECISION, TURN('s1'))

    expect(promptTextOf(client.calls)).toBe('hi')
  })

  it('开关显式 false（runSteps 路径）：同样不带引导语', async () => {
    const client = fakeClient()
    const runner = new AcpTurnRunner(client, { cwd: '/tmp', dialect: claudeDialect, delegationHint: false })
    await runner.runSteps(DECISION, TURN('s1'), { first: true })

    expect(promptTextOf(client.calls)).toBe('hi')
  })
})

describe('引导语只进 prompt 载荷，不进会话日志', () => {
  it('run 路径写入会话日志的内容（事件、追加、实时流）里没有这句话', async () => {
    const client = fakeClient()
    // 用户没说过「委派提示」这句话——日志里出现它，就是把 prompt 载荷错当
    // 成用户发言写进去了。三个写入口（produce、write、流增量）全记下来查。
    const written: unknown[] = []
    const deltas: string[] = []
    await new AcpTurnRunner(client, { cwd: '/tmp', delegationHint: true }).run(DECISION, {
      sessionId: 's1',
      position: { turn: 1, step: 1 },
      produce: result => { written.push(result); return [] },
      write: events => { written.push(events); return 1 },
      openStream: () => ({
        start: () => {},
        textDelta: text => { deltas.push(text) },
        reasoningDelta: () => {},
        records: () => [],
        settle: () => {},
        abandon: () => {},
      }),
    })

    expect(promptTextOf(client.calls)).toContain('委派提示')
    expect(JSON.stringify(written), '会话日志事件里不该出现引导语').not.toContain('委派提示')
    expect(deltas.join(''), '实时流里不该出现引导语').not.toContain('委派提示')
  })
})

/** 记录式传输（照 mcp-attach 的立桩法）：记录发出的帧，可按帧应答。 */
function recordingTransport(): AcpTransport & { readonly sent: string[]; receive(frame: string): void } {
  const sent: string[] = []
  let line: (frame: string) => void = () => {}
  return {
    sent,
    send: frame => { sent.push(frame) },
    onLine: handler => { line = handler },
    onDeath: () => {},
    lastFrameAt: () => Date.now(),
    lastDiagnosticAt: () => 0,
    stderrTail: () => [],
    close: () => {},
    receive: frame => { line(frame) },
  } as AcpTransport & { readonly sent: string[]; receive(frame: string): void }
}

/** 让排队的微任务跑完，异步应答路径先结算。 */
async function flush(): Promise<void> {
  for (let tick = 0; tick < 12; tick++) await Promise.resolve()
}

const HINTED: PresetConfig = {
  presets: { 'acp-claude': { agent: 'claude', command: 'claude-agent-acp', mode: 'default', delegationHint: true } },
}
const UNHINTED: PresetConfig = {
  presets: { 'acp-claude': { agent: 'claude', command: 'claude-agent-acp', mode: 'default' } },
}

/** 驱动 factory.open 走完一回合，回传 session/prompt 的文本块。 */
async function promptViaOpen(config: PresetConfig): Promise<string> {
  const transport = recordingTransport()
  const factory = makeSessionFactory(config, {
    answerPermission: async () => ({ outcome: 'reject' as const }),
    transport: () => transport,
  })
  const session = await factory.open('acp-claude', { cwd: '/tmp' })
  void session.run(DECISION, TURN('s1'))
  for (const frame of transport.sent) {
    const request = JSON.parse(frame) as { id?: number; method?: string }
    if (request.id === undefined) continue
    transport.receive(JSON.stringify({
      jsonrpc: '2.0',
      id: request.id,
      result: request.method === 'session/new' ? { sessionId: 's1' } : {},
    }))
    await flush()
  }
  const prompt = transport.sent
    .map(frame => JSON.parse(frame) as { method?: string; params?: Record<string, unknown> })
    .find(frame => frame.method === 'session/prompt')!
  return ((prompt.params!.prompt as { type: string; text?: string }[]).find(block => block.type === 'text') as { text: string }).text
}

/** 驱动 openShared→openSession（接管会话的建法）走完一回合，回传 prompt 文本。 */
async function promptViaOpenSession(config: PresetConfig): Promise<string> {
  const transport = recordingTransport()
  const factory = makeSessionFactory(config, {
    answerPermission: async () => ({ outcome: 'reject' as const }),
    transport: () => transport,
  })
  const shared = await factory.openShared('acp-claude')
  const session = await shared.openSession({ dshSessionId: 'dsh-9', cwd: '/tmp', dialect: claudeDialect, modeId: 'default' })
  void session.run(DECISION, TURN('dsh-9'))
  for (const frame of transport.sent) {
    const request = JSON.parse(frame) as { id?: number; method?: string }
    if (request.id === undefined) continue
    transport.receive(JSON.stringify({
      jsonrpc: '2.0',
      id: request.id,
      result: request.method === 'session/new' ? { sessionId: 's1' } : {},
    }))
    await flush()
  }
  const prompt = transport.sent
    .map(frame => JSON.parse(frame) as { method?: string; params?: Record<string, unknown> })
    .find(frame => frame.method === 'session/prompt')!
  return ((prompt.params!.prompt as { type: string; text?: string }[]).find(block => block.type === 'text') as { text: string }).text
}

describe('factory — 预设配置的 delegationHint 两条建会话路径都接进 prompt', () => {
  it('open 路径（网关借作模型）：预设声明打开 → prompt 带引导语', async () => {
    expect(await promptViaOpen(HINTED)).toContain('delegate')
  })

  it('openShared→openSession 路径（接管会话）：预设声明打开 → prompt 带引导语', async () => {
    expect(await promptViaOpenSession(HINTED)).toContain('delegate')
  })

  it('预设没声明 → prompt 不带引导语（默认关）', async () => {
    expect(await promptViaOpen(UNHINTED)).toBe('hi')
  })
})

describe('入口配置 — delegationHint 一路读进预设', () => {
  it('schema 列了这个字段：经过 loader 归一化不丢（stallMs 踩过的老坑）', () => {
    const preset = EntryConfig({
      presetId: 'acp-claude',
      agent: 'claude',
      command: 'claude-agent-acp',
      mode: 'default',
      delegationHint: true,
    })
    expect(preset.delegationHint).toBe(true)
  })

  it('apply 把 config.delegationHint 接进预设对象（跨文件钉子）', () => {
    // 字段加了类型却忘了接 apply 映射时，配置写了也不生效——entry-config
    // 只查「有人读 config.delegationHint」，读的位置对不对靠这道钉子。
    const source = readFileSync(fileURLToPath(new URL('../src/entry.ts', import.meta.url)), 'utf8')
    expect(source).toMatch(/\.\.\.\(config\.delegationHint === undefined \? \{\} : \{ delegationHint: config\.delegationHint \}\)/)
  })
})
