/**
 * The phase-3 stack against the real agent binaries.
 *
 * This is the acceptance gate for dispatch: a real agent must be driven through
 * the turn runner, produce text that reaches the stream **while the turn is
 * still running**, and project into the same content events the native loop
 * expects around it.
 *
 * The streaming assertion is the load-bearing one. Collecting frames and
 * replaying them after the turn passes every other test here and still shows
 * the user nothing until the agent finishes — which is the exact behaviour
 * this work exists to remove. So the test records whether any text arrived
 * before the prompt call resolved.
 *
 * Skipped unless `ACP_AGENT_LIVE_ACP=1`: real binaries, real model, real
 * wall clock. See the ACP layer's live spec for what the local claude actually
 * is — its frame shapes are genuine, its model behaviour is not.
 */

import { describe, expect, it } from 'vitest'
import { AcpClient, TerminalService, StdioAcpTransport, GrokServeTransport } from '../src/index.ts'
import type { AcpDialect, AcpTransport } from '../src/index.ts'
import { AcpTurnRunner } from '../src/runner.ts'
import type { ChildSessionLike, SubagentSessionHost } from '../src/subagent-sessions.ts'
import type { AcpClientPort, StdioMcpServer } from '../src/runner.ts'
import { adaptClient } from '../src/factory.ts'
import { stdioArgsForDialect, stdioEnvFor } from '../src/index.ts'
import { AcpAssistantStream } from '../src/stream.ts'
import { makeContentWriter, UNDELIVERED } from '../src/content-writer.ts'
import { projectStepContent } from '../src/index.ts'
import { claudeDialect } from '../src/index.ts'
import { codexDialect, cursorDialect, qoderDialect } from '../src/index.ts'
import { grokDialect } from '../src/index.ts'
import { bridgePermissions } from '../src/index.ts'
import { DELEGATION_ROUTE_PATH } from '../src/delegation-route.ts'
import type { StepEndReason, TurnContext } from '../src/dispatch.ts'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const LIVE = process.env['ACP_AGENT_LIVE_ACP'] === '1'
const CODEX_ACP = process.env['THREADHARBOR_CODEX_ACP'] ?? 'codex-acp'
const CURSOR_ACP = process.env['THREADHARBOR_CURSOR_ACP'] ?? 'cursor-agent'
const CLAUDE_ACP = process.env['THREADHARBOR_CLAUDE_ACP'] ?? 'claude-agent-acp'

const PROMPT = 'Reply with exactly this one sentence and nothing else: the tide comes in and goes out.'

/** Drive one real agent through the dispatch stack and report what streamed. */
async function runDispatch(command: string, dialect: AcpDialect, options: { modeId?: string } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'th-acp-dispatch-'))
  const transport = new StdioAcpTransport({ command, args: stdioArgsForDialect(dialect), cwd, onDiagnostic: () => {} })
  const client = new AcpClient(transport, dialect)
  if (dialect.id === 'grok') client.terminals = new TerminalService()
  // Through the very bridge production uses, so this exercises the fail-closed
  // path rather than a test-only shortcut.
  client.onPermissionRequest = request => bridgePermissions(request, async () => 'allowed-once')

  let stream: AcpAssistantStream | undefined
  const deltas: { text: string; settled: boolean }[] = []
  // Through the same adapter production uses. Handing the runner a no-op
  // frame sink here would make every streaming assertion below pass vacuously
  // — the frames reach the client but never the turn.
  const runner = new AcpTurnRunner(
    adaptClient(client, grokDialect),
    {
      cwd,
      ...(options.modeId === undefined ? {} : { modeId: options.modeId }),
    },
  )
  const openStream = () => {
    let attempt = 0
        stream = new AcpAssistantStream({
          emit: () => {},
          nextRevision: () => ++attempt,
          sessionId: 'live',
          attempt: 1,
          turn: 1,
          step: 1,
        })
    stream.start()
    return {
      start: () => {},
      textDelta: (text: string) => { deltas.push({ text, settled: stream?.finished ?? false }) },
      reasoningDelta: () => {},
      records: () => [],
      settle: () => {},
      abandon: () => {},
    }
  }

  // Through TurnContext, which is where the runner reads it — the same place
  // dispatch puts it. Passing it as a runner option tested a path nothing uses.
  const result = await runner.run({
    kind: 'enter',
    messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }] }],
  }, { sessionId: 's1', position: { turn: 1, step: 1 }, produce: r => [], write: () => 1, openStream })
  stream?.settle('assistant/message', () => 1)

  return { result, deltas, stream, client }
}

/**
 * The segmented case's prompt: a real tool run plus a report. Running
 * something is the point — the segmenter only finds a boundary once a tool
 * batch has settled — and demanding the report afterwards is what makes the
 * multi-segment shape the expected outcome rather than a lucky one. Cheap
 * and deterministic: one echo, one line of answer.
 */
const TOOL_REPORT_PROMPT =
  'Run the shell command `echo acp-live-ok` and then tell me exactly what it printed.'

/** What one segmented live turn collected, for the assertions that read it. */
type SegmentedTurn = {
  /** Every runSteps call's return, in call order; null means "the turn goes on". */
  readonly calls: (StepEndReason | null)[]
  /** Every event appended to the log, in write order, tagged with the call that wrote it. */
  readonly appended: { readonly type: string; readonly payload: Record<string, unknown>; readonly call: number }[]
  /** Each call's live stream, whose records() is what that call's message embeds. */
  readonly streams: AcpAssistantStream[]
  /** How many events were on the log when the prompt reply resolved. */
  readonly promptSettledOrder: number
  /** The prompt reply's own result object, as the agent sent it. */
  readonly promptReply: { readonly stopReason?: unknown } | undefined
}

/**
 * Drive one real codex turn through runSteps the way the takeover loop does.
 *
 * Everything is the production wiring — the adapted client port, a runner
 * carrying the dialect (the segmenter and the live cards exist only then),
 * the real content writer, and a real per-call stream like entry.ts's
 * `openAssistantStream` — plus three observation taps that change nothing on
 * the wire: the call tag on each append, the log's size when the prompt reply
 * resolved, and the reply result itself. The client is closed before the
 * assertions run; they read only what this collected.
 */
async function runStepsLive(prompt: string, options?: {
  subagents?: SubagentSessionHost
  dialect?: AcpDialect
  command?: string
}): Promise<SegmentedTurn> {
  const dialect = options?.dialect ?? codexDialect
  const command = options?.command ?? CODEX_ACP
  const cwd = await mkdtemp(join(tmpdir(), 'th-acp-runsteps-'))
  const transport = new StdioAcpTransport({ command, args: stdioArgsForDialect(dialect), cwd, onDiagnostic: () => {} })
  const client = new AcpClient(transport, dialect)
  // cursor 的两个阻塞式自定义方法：按生产 client 的方式跳过/取消，否则回合会干等。
  client.onExtensionRequest = frame => {
    if (dialect.id !== 'cursor' || typeof frame.id !== 'number') return false
    if (frame.method === 'cursor/ask_question') { client.reply(frame.id, { outcome: { outcome: 'skipped' } }); return true }
    if (frame.method === 'cursor/create_plan') { client.reply(frame.id, { outcome: { outcome: 'cancelled' } }); return true }
    return false
  }
  // Through the very bridge production uses, so a real command execution is
  // approved the way a session approves it.
  client.onPermissionRequest = request => bridgePermissions(request, async () => 'allowed-once')

  const appended: SegmentedTurn['appended'] = []
  let promptSettledOrder = -1
  let promptReply: SegmentedTurn['promptReply']
  const base = adaptClient(client, dialect)
  const port: AcpClientPort = {
    request: async (method, params) => {
      const reply = await base.request(method, params)
      if (method === 'session/prompt') promptSettledOrder = appended.length
      return reply
    },
    notify: (method, params) => { base.notify(method, params) },
    onFrame: handler => base.onFrame(frame => {
      // The reply frame reaches onFrame before the request promise resolves
      // (client.ts answers its pending call after observing the frame), so
      // this holds the agent's own usage report for the assertions below.
      const result = (frame as { result?: { stopReason?: unknown } }).result
      if (frame.method === undefined && result !== undefined && result.stopReason !== undefined) promptReply = result
      handler(frame)
    }),
  }
  // The dialect rides the runner options — without it there is no segmenter
  // and no live-card binding, and every assertion below would pass vacuously.
  const runner = new AcpTurnRunner(port, {
    cwd,
    dialect,
    ...(options?.subagents === undefined ? {} : { subagents: options.subagents }),
  })

  let activeStep = 0
  const write = makeContentWriter((type, payload) => ({
    seq: appended.push({ type, payload: payload as Record<string, unknown>, call: activeStep }),
  }))
  let attempt = 0
  let revision = 0
  const streams: AcpAssistantStream[] = []
  const turnOf = (step: number): TurnContext => ({
    sessionId: 's1',
    position: { turn: 1, step },
    produce: result => projectStepContent(result.frames, {
      turn: 1,
      step,
      dialect,
      ...(result.stream === undefined ? {} : { stream: result.stream }),
    }),
    write,
    openStream: () => {
      const stream = new AcpAssistantStream({
        emit: () => {},
        nextRevision: () => ++revision,
        sessionId: 'live',
        attempt: ++attempt,
        turn: 1,
        step,
      })
      streams.push(stream)
      return stream
    },
  })

  const calls: (StepEndReason | null)[] = []
  try {
    // The takeover loop itself: null makes the loop append the next step's
    // boundaries and call again with a fresh position; the real end reason is
    // the last segment. Twelve steps is far past anything this prompt can
    // produce — a runaway loop fails here with its shape on the record.
    for (let step = 1; step <= 12; step++) {
      activeStep = step
      const end = await runner.runSteps(
        { kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }] },
        turnOf(step),
        { first: step === 1 },
      )
      calls.push(end)
      if (end !== null) break
    }
    return { calls, appended, streams, promptSettledOrder, promptReply }
  } finally {
    client.close()
  }
}

/** The usage the reply reported and the log may honestly carry, or nothing. */
function reportedUsage(reply: SegmentedTurn['promptReply']): { inputTokens: number; outputTokens: number } | undefined {
  const usage = reply === undefined ? undefined : codexDialect.readReplyUsage(reply)
  if (usage === undefined) return undefined
  if (!Number.isSafeInteger(usage.inputTokens) || !Number.isSafeInteger(usage.outputTokens)) return undefined
  return { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }
}

describe.skipIf(!LIVE)('dispatch stack against real agents', () => {
  it('streams text while the turn is still running (claude)', async () => {
    const { deltas, result, client } = await runDispatch(CLAUDE_ACP, claudeDialect, { modeId: 'default' })
    expect(deltas.length).toBeGreaterThan(0)
    // Some text must arrive while the turn is open. If everything arrives
    // after, the turn is being replayed rather than streamed.
    expect(deltas.some(d => !d.settled)).toBe(true)
    expect(deltas.map(d => d.text).join('')).toContain('tide')
    expect(result.end.kind).toBe('completed')
    client.close()
  }, 240_000)

  it('streams text while the turn is still running (codex)', async () => {
    const { deltas, result, client } = await runDispatch(CODEX_ACP, codexDialect)
    expect(deltas.length).toBeGreaterThan(0)
    expect(deltas.some(d => !d.settled)).toBe(true)
    expect(result.end.kind).toBe('completed')
    client.close()
  }, 240_000)

  it('projects a real turn into content events', async () => {
    const { result, client } = await runDispatch(CODEX_ACP, codexDialect)
    const events = projectStepContent(result.frames as never[], { turn: 1, step: 1, dialect: codexDialect })
    // Only content events: the native loop owns the boundaries around them.
    expect(events.every(e => e.type === 'assistant/message' || e.type === 'tool/call' || e.type === 'tool/result')).toBe(true)
    expect(events.some(e => e.type === 'assistant/message')).toBe(true)
    client.close()
  }, 240_000)

  /**
   * The segmented takeover against a real codex turn (Tasks 1-6 end to end).
   *
   * A turn that actually segmented — some later call wrote events under its
   * own step — must span at least two runSteps calls: the first returning
   * null after writing its segment under its own step position, the last
   * returning the real end reason. Each segment's durable message embeds
   * exactly its own call's stream records, a result filed by a non-final
   * segment must be on the log before the prompt reply resolved (the live
   * result, not a turn-end replay), and the final segment's message carries
   * the usage the reply itself reported. Model mood is tolerated where it is
   * real: codex may answer without touching a tool, and a tool it runs as
   * its very last act forms no boundary at all (the segmenter needs fresh
   * content after the batch settles) — both turns are one call, and the
   * branch is read off what the frames actually wrote, not off what the
   * prompt hoped for.
   */
  it('a real tool turn spans several runSteps calls with live results', async () => {
    const { calls, appended, streams, promptSettledOrder, promptReply } = await runStepsLive(TOOL_REPORT_PROMPT)

    // The turn produced something, and every event was written under the
    // step position of the call that wrote it — the loop's numbering and
    // the log agree all the way through, first call included.
    expect(appended.length, 'the turn wrote nothing').toBeGreaterThan(0)
    for (const event of appended) {
      expect(event.payload['step'], `event ${event.type} of call ${event.call} numbered ${String(event.payload['step'])}`).toBe(event.call)
    }

    // Tool use is read off the projected cards by name. The projection names
    // spawned runs 'subagent'/'async_task', and those are exactly the runs
    // the segmenter never lets open, settle or close anything — its exclusion
    // is by update kind (only tool_call/tool_call_update move it, never the
    // spawned kinds), this one by the name that kind projects to. Two
    // spellings of the same distinction.
    const usedTools = appended.some(
      event => event.type === 'tool/call' && event.payload['name'] !== 'subagent' && event.payload['name'] !== 'async_task',
    )
    // Whether the turn segmented is read off the log itself: a later call
    // wrote events under its own step number. A boundary needs a settled
    // tool batch AND fresh content after it, so a tool the model runs as its
    // very last act never segments — that is correct behaviour (the
    // segmenter's own rule), and this branch accepts it as one call instead
    // of demanding two. Branching on written events keeps model mood out of
    // the assertion: the test holds the loop to what the frames did, not to
    // what the prompt hoped the model would do.
    const segmented = appended.some(
      event => typeof event.payload['step'] === 'number' && (event.payload['step'] as number) > 1,
    )
    if (segmented) {
      // Segment 1 closed and the loop was called again: interior calls null,
      // the last one the turn's real end.
      expect(calls.length, `expected ≥2 segment calls, got ${JSON.stringify(calls)}`).toBeGreaterThanOrEqual(2)
      expect(calls[0]).toBeNull()
      expect(calls.slice(1, -1).every(c => c === null)).toBe(true)
      expect(calls.at(-1)).toEqual({ kind: 'completed' })

      // Live result: a tool result filed by a non-final segment was already
      // on the log when the reply resolved — written at the terminal frame,
      // not replayed at turn end.
      const midResult = appended.findIndex(
        event => event.type === 'tool/result' && (event.payload['step'] as number) < calls.length,
      )
      expect(midResult, 'no tool result was written by a non-final segment').toBeGreaterThanOrEqual(0)
      expect(midResult, 'the mid-turn result was written after the reply settled').toBeLessThan(promptSettledOrder)
      // Stronger still: it preceded the first prose message on the log. That
      // message is written at the segment's close, so a result landing at or
      // after it would be a close-batch replay, not a live settle.
      const firstProse = appended.findIndex(
        event => event.type === 'assistant/message'
          && (event.payload['message'] as { content: { type: string }[] }).content.some(block => block.type === 'text'),
      )
      if (firstProse >= 0) {
        expect(midResult, 'the mid-turn result was written at its segment close, not at its terminal frame').toBeLessThan(firstProse)
      }
    } else {
      // Nothing was ever written past step 1: no boundary was found, and one
      // call owns the whole turn — with or without tools.
      expect(calls).toEqual([{ kind: 'completed' }])
    }

    // Whatever the shape, a tool the turn ran has its outcome on the log —
    // written live at the terminal frame, or close-paired by the projection.
    if (usedTools) {
      expect(appended.some(event => event.type === 'tool/result'), 'a tool ran but no result was written').toBe(true)
    }

    // The agent answered in prose either way — the report is what the turn
    // was for, and a completed turn without an answer is a broken one.
    const prose = appended
      .filter(event => event.type === 'assistant/message')
      .flatMap(event => (event.payload['message'] as { content: { type: string; text?: string }[] }).content)
      .filter(block => block.type === 'text')
      .map(block => block.text ?? '')
      .join('')
    expect(prose.length).toBeGreaterThan(0)

    // Each segment's message embeds exactly its own call's stream records —
    // segment 2 must not carry segment 1's text. A message with prose has
    // its call's records, and the records' text IS the message's text; an
    // announcement (a one-block tool-call message the live card path files)
    // carries no stream at all.
    for (let step = 1; step <= calls.length; step++) {
      const own = streams[step - 1]!.records()
      for (const message of appended.filter(e => e.type === 'assistant/message' && e.call === step)) {
        const content = (message.payload['message'] as { content: { type: string; text?: string }[] }).content
        const carried = message.payload['stream'] as { type: string; texts?: readonly string[] }[]
        if (content.some(block => block.type === 'text' || block.type === 'reasoning')) {
          expect(carried, `step ${step}'s message does not embed its own stream`).toEqual(own)
          expect(
            carried.filter(record => record.type === 'text-chunks').flatMap(record => record.texts ?? []).join(''),
          ).toBe(content.filter(block => block.type === 'text').map(block => block.text ?? '').join(''))
        } else {
          expect(carried).toEqual([])
        }
      }
    }

    // The final segment's message carries the usage the reply itself
    // reported, when it reported one the log may carry. Guarded twice by
    // what actually happened: a reply without a usable usage asserts
    // nothing, and a final segment whose content was only tool cards (mood:
    // a batch as the very last act) writes no message and cannot carry one.
    // In the one-call shape the reply frame rides the same segment as the
    // answer, so the message exists and the usage is asserted there.
    const usage = reportedUsage(promptReply)
    if (usage !== undefined) {
      const last = appended
        .filter(event => event.type === 'assistant/message' && event.call === calls.length)
        .at(-1)
      if (last !== undefined) {
        expect(last.payload['usage']).toMatchObject(usage)
      }
    }
  }, 300_000)

  /**
   * 外部子代理 → 影子子会话（真实 codex 回合）。
   *
   * 条件断言：是否真的派子代理由模型决定——没有出生帧就只断言回合正常收尾
   * （测试不替模型打包票）；有出生帧就必须看到会话创建（`acp-sub-` 前缀）、
   * 父会话目录事件、任务用户消息；子会话只在其真实终态到达时收尾。
   */
  it('codex: a real subagent turn becomes a shadow child session', async () => {
    const children: { id: string; appends: { type: string; payload: unknown }[] }[] = []
    const parentEvents: { type: string; payload: unknown }[] = []
    const host: SubagentSessionHost = {
      available: true,
      openChild(_parent, childId) {
        const appends: { type: string; payload: unknown }[] = []
        children.push({ id: childId, appends })
        let seq = 0
        const child: ChildSessionLike = {
          id: childId,
          header: { createdAt: 1 },
          get seq() { return seq },
          append: (type, payload) => { seq += 1; appends.push({ type, payload }); return { seq } },
        }
        return child
      },
      appendParent(_parent, type, payload) { parentEvents.push({ type, payload }) },
      emitChildStream() {},
    }
    const { calls } = await runStepsLive(
      'Use your subagent/spawn-agent tool to delegate computing 6*7 to a child agent, wait for the child result, then reply with the number.',
      { subagents: host },
    )
    // No delegation happened: the turn still completes, and nothing else is claimed.
    if (parentEvents.length === 0) {
      expect(children).toEqual([])
      expect(calls.at(-1)).toEqual({ kind: 'completed' })
      return
    }
    expect(children.length).toBeGreaterThanOrEqual(1)
    expect(children[0]!.id.startsWith('acp-sub-')).toBe(true)
    expect(parentEvents.some(event => event.type === 'subagent/catalog')).toBe(true)
    expect(parentEvents[0]!.type).toBe('subagent/catalog')
    const types = children[0]!.appends.map(entry => entry.type)
    expect(types).toContain('turn/start')
    expect(types).toContain('user/message')
    // 等真实终态：收到终态才写收尾消息；父回合先结束时它保持开放（用户选择的语义）。
    if (types.includes('turn/end')) {
      expect(types).toContain('assistant/message')
      expect(types.at(-1)).toBe('turn/end')
    }
  }, 300_000)

  /**
   * cursor: 接管路径的活体验收（对照 codex 的同一组断言）。
   *
   * cursor 走自己的方言——`kind` 当工具名、pending 占位帧、diff 输出、无用量——
   * 但接管路径的契约与 codex 相同：正文/思考在回合进行中就进流；工具结果在应答
   * 落定前落盘（实时结果，不是回合末重放）；切段时首调 null、末调 completed；
   * 回合末的遥测只以汇总卡出现，不混别的内容。
   */
  it('cursor: a real turn streams live, files live results, and summarizes telemetry', async () => {
    const { calls, appended, streams, promptSettledOrder } = await runStepsLive(TOOL_REPORT_PROMPT, {
      dialect: cursorDialect,
      command: CURSOR_ACP,
    })
    expect(appended.length, 'the turn wrote nothing').toBeGreaterThan(0)
    expect(streams.some(stream => stream.records().length > 0), 'no text streamed during the turn').toBe(true)
    for (const event of appended) expect(typeof event.payload['step']).toBe('number')
    const toolResultAt = appended.findIndex(event => event.type === 'tool/result')
    if (toolResultAt >= 0 && promptSettledOrder >= 0) {
      expect(toolResultAt, 'the tool result was replayed at turn end, not filed live').toBeLessThan(promptSettledOrder)
    }
    const segmented = appended.some(event => typeof event.payload['step'] === 'number' && (event.payload['step'] as number) > 1)
    if (segmented) {
      expect(calls.length).toBeGreaterThanOrEqual(2)
      expect(calls[0]).toBeNull()
    }
    expect(calls.at(-1)).toEqual({ kind: 'completed' })
    // 遥测汇总卡只允许四种已知遥测种类；`外部输出 ·` 前缀下出现别的种类就是分类缺口。
    const rawCards = appended.filter(event => event.type === 'tool/call'
      && String((event.payload as { name?: string }).name ?? '').includes('外部输出 ·'))
    for (const card of rawCards) {
      expect(String((card.payload as { name?: string }).name)).toMatch(
        /外部输出 · (usage_update|session_info_update|available_commands_update|current_mode_update)/,
      )
    }
  }, 300_000)

  /**
   * claude: 接管路径的活体验收（对照 codex/cursor 的同一组断言）。
   *
   * claude 的方言差异（工具名在 _meta.claudeCode.toolName、双层嵌套 content、
   * 双帧工具生命周期）不影响接管路径的契约：分段、实时结果、遥测汇总。
   */
  it('claude: a real turn spans several runSteps calls with live results', async () => {
    const { calls, appended, streams, promptSettledOrder } = await runStepsLive(TOOL_REPORT_PROMPT, {
      dialect: claudeDialect,
      command: CLAUDE_ACP,
    })
    expect(appended.length, 'the turn wrote nothing').toBeGreaterThan(0)
    expect(streams.some(stream => stream.records().length > 0), 'no text streamed during the turn').toBe(true)
    for (const event of appended) expect(typeof event.payload['step']).toBe('number')
    const toolResultAt = appended.findIndex(event => event.type === 'tool/result')
    if (toolResultAt >= 0 && promptSettledOrder >= 0) {
      expect(toolResultAt, 'the tool result was replayed at turn end, not filed live').toBeLessThan(promptSettledOrder)
    }
    const segmented = appended.some(event => typeof event.payload['step'] === 'number' && (event.payload['step'] as number) > 1)
    if (segmented) {
      expect(calls.length).toBeGreaterThanOrEqual(2)
      expect(calls[0]).toBeNull()
    }
    expect(calls.at(-1)).toEqual({ kind: 'completed' })
  }, 300_000)

  /**
   * The image-interception branch of the capability table, end to end: a real
   * claude turn whose user message carries an image. claude's table cell says
   * no, so the wire prompt must stay text-only, and the writer must expand the
   * held-back attachment into the paired 未送达 row — never the internal marker.
   * (The wire-level half — codex/grok/cursor really reading an image — lives in
   * the ACP package's live spec.)
   */
  it('claude: a declined image rides no wire prompt and lands as the 未送达 row', async () => {
    // A minimal 1×1 red PNG: the branch never lets the agent see it — only its
    // presence in the user message matters.
    const image = {
      type: 'image',
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
      mimeType: 'image/png',
    }
    const cwd = await mkdtemp(join(tmpdir(), 'th-acp-image-'))
    const inner = new StdioAcpTransport({ command: CLAUDE_ACP, cwd, onDiagnostic: () => {} })
    // A sending spy: the assertion is about what claude was actually handed.
    const sent: string[] = []
    const transport: AcpTransport = {
      send: line => { sent.push(line); inner.send(line) },
      onLine: handler => inner.onLine(handler),
      onDeath: handler => inner.onDeath(handler),
      lastFrameAt: () => inner.lastFrameAt(),
      lastDiagnosticAt: () => inner.lastDiagnosticAt(),
      stderrTail: () => inner.stderrTail(),
      close: () => inner.close(),
    }
    const client = new AcpClient(transport, claudeDialect)
    client.onPermissionRequest = request => bridgePermissions(request, async () => 'allowed-once')
    const runner = new AcpTurnRunner(adaptClient(client, claudeDialect), { cwd, modeId: 'default' })
    // The real writer over a capturing sink: the row the user reads is the
    // expanded pair, so that pair is what the test accepts.
    const appended: { type: string; payload: unknown }[] = []
    const write = makeContentWriter((type, payload) => ({ seq: appended.push({ type, payload }) }))

    try {
      const result = await runner.run({
        kind: 'enter',
        messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }, image] }],
      }, {
        sessionId: 's1',
        position: { turn: 1, step: 1 },
        produce: r => projectStepContent(r.frames as never[], { turn: 1, step: 1, dialect: claudeDialect }),
        write,
      })

      // The interception is not a failure: the turn completes as an answer.
      expect(result.end.kind).toBe('completed')

      // Nothing but text went over the wire — every block of every
      // session/prompt request claude received is a text block.
      const promptBlocks = sent
        .map(line => JSON.parse(line) as { method?: string; params?: { prompt?: { type?: string }[] } })
        .filter(frame => frame.method === 'session/prompt')
        .flatMap(frame => frame.params?.prompt ?? [])
      expect(promptBlocks.length).toBeGreaterThan(0)
      expect(promptBlocks.every(block => block.type === 'text')).toBe(true)

      // The visible half: the marker became the paired row, and the marker
      // itself never touched the log.
      expect(appended.some(event => event.type === UNDELIVERED)).toBe(false)
      const noticeCall = appended.find(
        event => event.type === 'tool/call' && (event.payload as { name?: string }).name === '附件未送达',
      )
      expect(noticeCall).toBeDefined()
      const callId = (noticeCall!.payload as { callId?: string }).callId
      expect(typeof callId).toBe('string')
      const noticeRow = appended.find(
        event => event.type === 'tool/result' &&
          (event.payload as { message?: { toolCallId?: string } }).message?.toolCallId === callId,
      )
      expect(noticeRow).toBeDefined()
      const message = (noticeRow!.payload as { message?: { content?: { text?: string }[]; isError?: boolean } }).message
      expect(message?.isError).toBe(true)
      expect((message?.content ?? []).map(part => part.text).join('')).toContain('未送达')
    } finally {
      client.close()
    }
  }, 240_000)
})

// ───────────────────────── MCP 委派探针（Task 9）─────────────────────────
//
// 验的不是接管路径，而是「外部 agent 认不认 session/new 里挂的 stdio MCP
// 服务器」：initialize / tools/list / tools/call 有没有真的到达桥接进程，
// delegate 的结果有没有回到回合里。宿主侧没有真宿主——回调路由用进程内的
// node:http 假宿主扮演（形状与 src/delegation-route.ts 一致：验
// x-dsh-delegation-token 头后回一份 DelegationResult），断言到「桥接 ↔
// 假宿主」为止；真委派实现（superpowers 仓）的联调属 Task 10。
//
// 观测手段是一个 tee 垫片：agent 拉起的「MCP 服务器」实为垫片，垫片再拉起
// 真桥接进程（bridge/dsh-acp-mcp-bridge.mjs，一字不改），双向帧记账后原样
// 转发。这是唯一能同时看清「桥接收到了哪些方法」与「agent 发没发 ping」的
// 位置；代价是 args[0] 与生产挂载（直接是桥接路径）不同，env 与命令形状
// 照抄生产（tests/mcp-attach.spec.ts 钉死的那份），帧内容零修改。

const QODER_ACP = process.env['THREADHARBOR_QODER_ACP'] ?? 'qoderclicn'
const GROK_CLI = process.env['THREADHARBOR_GROK_ACP'] ?? 'grok'

/** 假宿主认的会话 id：桥接进程原样转发挂载时 env 里那一份，收到即证明 env 通了 */
const PROBE_DSH_SESSION = 'probe-dsh-session'

/** 真桥接进程的绝对路径（与 src/factory.ts 同一解析法：从包位置出发） */
const PROBE_BRIDGE_PATH = fileURLToPath(new URL('../bridge/dsh-acp-mcp-bridge.mjs', import.meta.url))

/** tee 垫片记下的帧：dir=in 是 agent→桥接，dir=out 是桥接→agent */
type TeeEntry = {
  readonly dir: 'in' | 'out'
  readonly method?: string
  readonly id?: number | string
  readonly params?: Record<string, unknown>
  readonly errorCode?: number
  readonly isError?: boolean
  readonly resultText?: string
  readonly raw?: string
}

/** 假宿主：探针在测试进程内自起的回调路由，形状与生产路由一致 */
type ProbeHost = {
  readonly origin: string
  readonly token: string
  /** 每轮随机的输出标记：agent 不真调工具就编不出来 */
  readonly nonce: string
  readonly hits: { readonly body: Record<string, unknown> }[]
  readonly close: () => Promise<void>
}

async function startProbeHost(): Promise<ProbeHost> {
  const token = randomBytes(24).toString('hex')
  const nonce = randomBytes(8).toString('hex')
  const hits: ProbeHost['hits'] = []
  const server = createServer((req, res) => {
    // 只认回调路径上的 POST（与生产路由同一形状）
    if (req.method !== 'POST' || req.url !== DELEGATION_ROUTE_PATH) {
      res.writeHead(404).end()
      return
    }
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      // 令牌走专用请求头，不进 URL 也不进载荷（Task 5/6 的跨任务约定）
      if (req.headers['x-dsh-delegation-token'] !== token) {
        res.writeHead(401, { 'content-type': 'text/plain' }).end('unauthorized')
        return
      }
      const raw = Buffer.concat(chunks).toString('utf8')
      hits.push({ body: raw === '' ? {} : JSON.parse(raw) as Record<string, unknown> })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        output: `子代理答：17 + 25 = 42（探针标记 ${nonce}）`,
        model: 'probe-fake-model',
        childId: 'probe-child-1',
      }))
    })
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${port}`,
    token,
    nonce,
    hits,
    close: () => new Promise<void>(resolve => { server.close(() => resolve()) }),
  }
}

/** 观测垫片源码（测试在运行时写进 agent 工作目录，不进仓库固定位置） */
const TEE_SOURCE = `// 探针观测垫片：agent 以为在跟 MCP 服务器直连；垫片把双向帧记账后原样
// 转发给真桥接进程。对帧内容零修改，env 原样继承。
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { appendFileSync } from 'node:fs'

const bridgePath = process.argv[2]
const logPath = process.argv[3]
const child = spawn(process.execPath, [bridgePath], { stdio: ['pipe', 'pipe', 'inherit'], env: process.env })
child.stdin.on('error', () => {})
child.on('exit', code => { process.exit(code === null ? 0 : code) })

function record(dir, line) {
  let frame = null
  try { frame = JSON.parse(line) } catch { frame = null }
  if (frame === null || typeof frame !== 'object') {
    appendFileSync(logPath, JSON.stringify({ dir, raw: String(line) }) + '\\n')
    return
  }
  const entry = { dir }
  if (frame.method !== undefined) entry.method = frame.method
  if (frame.id !== undefined) entry.id = frame.id
  if (frame.error !== undefined) entry.errorCode = frame.error.code
  if (frame.result !== undefined) {
    if (frame.result.isError === true) entry.isError = true
    if (Array.isArray(frame.result.content)) {
      entry.resultText = frame.result.content
        .map(part => (part && typeof part.text === 'string') ? part.text : '')
        .join('')
    }
  }
  // tools/call 的参数是探针要核对的事实（点了哪个工具、带了什么参数）
  if (dir === 'in' && frame.method === 'tools/call') entry.params = frame.params
  appendFileSync(logPath, JSON.stringify(entry) + '\\n')
}

createInterface({ input: process.stdin }).on('line', line => {
  record('in', line)
  child.stdin.write(line + '\\n')
})
createInterface({ input: child.stdout }).on('line', line => {
  record('out', line)
  process.stdout.write(line + '\\n')
})
// agent 关闭 stdin（会话结束）时原样传递：桥接进程按 stdin 关闭退出
process.stdin.on('close', () => { child.stdin.end() })
process.stdout.on('error', error => {
  if (error && error.code === 'EPIPE') process.exit(0)
  throw error
})
`

/** 一家探针的输入：命令、方言与三家特有的接线 */
type ProbeAgent = {
  readonly command: string
  readonly dialect: AcpDialect
  /** claude 不给 'default' 连问都不问 */
  readonly modeId?: string
  /** grok 不是 stdio 服务端，是 agent serve + WebSocket */
  readonly viaWebSocket?: boolean
  /** qoder 要过滤 IDE 注入的启动环境 */
  readonly scrubEnv?: boolean
}

/** 一家探针带回的全部观测 */
type ProbeOutcome = {
  readonly endKind: unknown
  readonly prose: string
  readonly nonce: string
  readonly hostHits: ProbeHost['hits']
  readonly tee: TeeEntry[]
}

async function runMcpProbe(agent: ProbeAgent): Promise<ProbeOutcome> {
  const host = await startProbeHost()
  const cwd = await mkdtemp(join(tmpdir(), 'th-acp-mcp-probe-'))
  const teePath = join(cwd, 'mcp-tee.mjs')
  await writeFile(teePath, TEE_SOURCE)
  const logPath = join(cwd, 'mcp-tee.jsonl')
  // 条目形状照抄 factory 的挂载（stdio 变体不带 type；command 是当前 node；
  // env 三项）。args[0] 是垫片——探针要看桥接收到了什么，垫片只记账转发。
  const server: StdioMcpServer = {
    name: 'dsh-delegation',
    command: process.execPath,
    args: [teePath, PROBE_BRIDGE_PATH, logPath],
    env: [
      { name: 'DSH_DELEGATION_URL', value: `${host.origin}${DELEGATION_ROUTE_PATH}` },
      { name: 'DSH_DELEGATION_SESSION', value: PROBE_DSH_SESSION },
      { name: 'DSH_DELEGATION_TOKEN', value: host.token },
    ],
  }

  const transport = agent.viaWebSocket === true
    ? await GrokServeTransport.create({ command: agent.command, cwd, onDiagnostic: () => {} })
    : new StdioAcpTransport({
        command: agent.command,
        args: stdioArgsForDialect(agent.dialect),
        cwd,
        onDiagnostic: () => {},
        // qoder 继承 IDE 启动标记会直接死（spawn-args.ts 的实测）；探针与
        // 生产同一份过滤，结论才不依赖跑测时用的是哪个外壳
        ...(agent.scrubEnv === true ? { env: stdioEnvFor(agent.dialect.id) ?? undefined } : {}),
      })
  const client = new AcpClient(transport, agent.dialect)
  if (agent.dialect.id === 'grok') client.terminals = new TerminalService()
  // 与 runStepsLive 同一套应答器：qoder 不应答权限请求会把 session/prompt 挂死
  client.onPermissionRequest = request => bridgePermissions(request, async () => 'allowed-once')
  client.onExtensionRequest = frame => {
    if (agent.dialect.id !== 'cursor' || typeof frame.id !== 'number') return false
    if (frame.method === 'cursor/ask_question') { client.reply(frame.id, { outcome: { outcome: 'skipped' } }); return true }
    if (frame.method === 'cursor/create_plan') { client.reply(frame.id, { outcome: { outcome: 'cancelled' } }); return true }
    return false
  }

  const appended: { type: string; payload: Record<string, unknown> }[] = []
  const write = makeContentWriter((type, payload) => ({ seq: appended.push({ type, payload: payload as Record<string, unknown> }) }))
  const runner = new AcpTurnRunner(adaptClient(client, agent.dialect), {
    cwd,
    dialect: agent.dialect,
    mcpServers: [server],
    ...(agent.modeId === undefined ? {} : { modeId: agent.modeId }),
  })
  try {
    const result = await runner.run(
      {
        kind: 'enter',
        messages: [{
          role: 'user',
          content: [{
            type: 'text',
            text: '请使用 dsh-delegation 这个 MCP 服务器提供的 delegate 工具，把「计算 17 + 25」委派给 DSH 侧的子代理，等结果返回后，把子代理返回文本里的「探针标记」原样告诉我。不要自己计算。',
          }],
        }],
      },
      {
        sessionId: 's1',
        position: { turn: 1, step: 1 },
        produce: r => projectStepContent(r.frames as never[], { turn: 1, step: 1, dialect: agent.dialect }),
        write,
      },
    )
    // 垫片没被拉起 = 一帧都记不下（agent 压根没 spawn MCP 子进程）；回空表，
    // 让握手断言红掉并如实反映，而不是让读文件把「没连」伪装成「测试崩了」
    let tee: TeeEntry[] = []
    try {
      tee = readFileSync(logPath, 'utf8').split('\n').filter(line => line !== '').map(line => JSON.parse(line) as TeeEntry)
    } catch {
      tee = []
    }
    const prose = appended
      .filter(event => event.type === 'assistant/message')
      .flatMap(event => (event.payload['message'] as { content: { type: string; text?: string }[] }).content)
      .filter(block => block.type === 'text')
      .map(block => block.text ?? '')
      .join('')
    return { endKind: (result.end as { kind?: unknown } | undefined)?.kind, prose, nonce: host.nonce, hostHits: host.hits, tee }
  } finally {
    client.close()
    await host.close()
  }
}

/** 基础断言：initialize 与 tools/list 真的到达桥接（= 认了这个服务器并要了工具表） */
function expectBridgeHandshake(outcome: ProbeOutcome): void {
  const methods = outcome.tee.filter(entry => entry.dir === 'in').map(entry => entry.method)
  expect(methods, `垫片一帧未见：agent 可能没拉起 MCP 子进程；已记录 ${JSON.stringify(outcome.tee)}`).toContain('initialize')
  expect(methods).toContain('tools/list')
}

/** 会调用家的完整链：tools/call → 桥接转发到假宿主 → 子代理输出回到回合 */
function expectDelegated(outcome: ProbeOutcome): void {
  const calls = outcome.tee.filter(entry => entry.dir === 'in' && entry.method === 'tools/call')
  expect(calls.length).toBeGreaterThanOrEqual(1)
  for (const call of calls) {
    expect(call.params?.['name'], '工具调用点的不是 delegate').toBe('delegate')
  }
  expect(outcome.hostHits.length).toBeGreaterThanOrEqual(1)
  const hit = outcome.hostHits[0]!
  // env 通不通看这里：桥接原样转发挂载时给的会话 id
  expect(hit.body['sessionId']).toBe(PROBE_DSH_SESSION)
  expect(String(hit.body['task'] ?? '').length, 'task 为空').toBeGreaterThan(0)
  expect(String(hit.body['brief'] ?? '').length, 'brief 为空').toBeGreaterThan(0)
  const skill = hit.body['skill']
  expect(skill === undefined || (typeof skill === 'string' && skill.length > 0)).toBe(true)
  // 工具结果里带着子代理的输出（含随机 nonce，不调工具就编不出来）
  expect(outcome.tee.some(entry => (entry.resultText ?? '').includes(outcome.nonce))).toBe(true)
  // 回合完成，且 agent 把子代理输出转述进了正文
  expect(outcome.endKind).toBe('completed')
  expect(outcome.prose).toContain(outcome.nonce)
}

/** 观察记录（不设门）：这家真机发没发 ping——桥接未实现 ping，发了会拿到 -32601 */
function pingSent(outcome: ProbeOutcome): boolean {
  return outcome.tee.some(entry => entry.dir === 'in' && entry.method === 'ping')
}

describe.skipIf(!LIVE)('MCP 委派探针：五家真机认不认客户端挂的 MCP 服务器', () => {
  it('codex：认 MCP、列工具、调 delegate，子代理输出回到回合', async () => {
    const outcome = await runMcpProbe({ command: CODEX_ACP, dialect: codexDialect })
    expectBridgeHandshake(outcome)
    expectDelegated(outcome)
    console.log(`[mcp-probe] codex 发 ping：${pingSent(outcome)}`)
  }, 300_000)

  it('claude：认 MCP、列工具、调 delegate，子代理输出回到回合', async () => {
    const outcome = await runMcpProbe({ command: CLAUDE_ACP, dialect: claudeDialect, modeId: 'default' })
    expectBridgeHandshake(outcome)
    expectDelegated(outcome)
    console.log(`[mcp-probe] claude 发 ping：${pingSent(outcome)}`)
  }, 300_000)

  it('cursor：认 MCP、列工具；实测不调用 delegate，回合仍正常完成', async () => {
    const outcome = await runMcpProbe({ command: CURSOR_ACP, dialect: cursorDialect })
    expectBridgeHandshake(outcome)
    // 实测基线（2026-11-05 控制者手工探针）：cursor 要了工具表但整回合不调
    // delegate。钉成基线——将来「会调了」或「连都不连了」都该在这里红出来，
    // 实测记录（docs/agent-acp/mcp-probe.md）跟着改。
    expect(outcome.tee.filter(entry => entry.dir === 'in' && entry.method === 'tools/call')).toHaveLength(0)
    expect(outcome.hostHits).toHaveLength(0)
    expect(outcome.endKind).toBe('completed')
    console.log(`[mcp-probe] cursor 发 ping：${pingSent(outcome)}`)
  }, 300_000)

  it('qoder：认 MCP、列工具、调 delegate，子代理输出回到回合', async () => {
    const outcome = await runMcpProbe({ command: QODER_ACP, dialect: qoderDialect, scrubEnv: true })
    expectBridgeHandshake(outcome)
    expectDelegated(outcome)
    console.log(`[mcp-probe] qoder 发 ping：${pingSent(outcome)}`)
  }, 300_000)

  it('grok：认 MCP、列工具、调 delegate，子代理输出回到回合（WebSocket）', async () => {
    const outcome = await runMcpProbe({ command: GROK_CLI, dialect: grokDialect, viaWebSocket: true })
    expectBridgeHandshake(outcome)
    expectDelegated(outcome)
    console.log(`[mcp-probe] grok 发 ping：${pingSent(outcome)}`)
  }, 300_000)
})