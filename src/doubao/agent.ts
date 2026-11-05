/**
 * The Doubao browser agent, as an ACP service.
 *
 * This process speaks the Agent Client Protocol over stdio, which is what
 * the plugin's runner expects from an agent it spawns. Behind that protocol
 * there is no model of our own: the answers come from the Doubao desktop app
 * running in its own browser, which we drive over the DevTools protocol.
 *
 * The shape of a turn:
 *   1. `session/prompt` arrives with the user's text;
 *   2. the text goes into 豆包's editor and is sent;
 *   3. the page is polled until the model stops generating;
 *   4. every change in the answer becomes an `agent_message_chunk`, and
 *      every tool activity 豆包 performed on its own becomes a `tool_call`.
 *
 * 豆包 does its own tool use (web search, images) and the desktop app runs
 * that work server-side, so those steps are reported, not executed by us.
 * DSH's own tools do not take part in the model's decisions yet — the
 * personal-MCP path that would allow it exists on 豆包's side but has no
 * client-side trigger in the shipped build (see the design note).
 */

import { randomUUID } from 'node:crypto'
import { DoubaoBrowser, type DoubaoBrowserOptions } from './browser.ts'
import type { DomSnapshot } from './dom.ts'
import { answerDelta, parseTurn } from './parse.ts'

/**
 * What the agent needs from the browser.
 *
 * The real implementation is `DoubaoBrowser`; tests hand in a fake, so the
 * conversation can be exercised without the desktop app.
 */
export type DoubaoBrowserLike = {
  snapshot(): Promise<DomSnapshot>
  sendPrompt(text: string): Promise<void>
  stopGeneration(): Promise<void>
  close(): Promise<void>
}

export type DoubaoTurnEvent =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; action: string }
  | { kind: 'done' }

export type DoubaoAgentOptions = {
  /** How often the page is read while a turn runs. */
  pollIntervalMs?: number
  /** How long one turn may take before it is given up on. */
  turnTimeoutMs?: number
  /** How many polls must show the same answer before the turn counts as done. */
  stablePolls?: number
  /** Where diagnostics go (stderr — never stdout, which carries the protocol). */
  onDiagnostic?: (line: string) => void
  /** The browser host; injected in tests. */
  browser?: DoubaoBrowserLike
  /** How to open the browser; injected in tests. */
  openBrowser?: (options: DoubaoBrowserOptions) => Promise<DoubaoBrowserLike>
}

/**
 * One turn of conversation with 豆包.
 *
 * The page is polled rather than watched: the chat list is virtualized, so
 * there is no stable node to observe, and a poll of the visible rows is both
 * simpler and robust against the page re-rendering itself.
 */
export class DoubaoConversation {
  private readonly browser: DoubaoBrowserLike
  private readonly options: {
    pollIntervalMs?: number
    turnTimeoutMs?: number
    /** How many polls must show the same answer before the turn counts as done. */
    stablePolls?: number
  }

  // No constructor parameter properties: DSH erases plugin types with a
  // strip-only eraser, which cannot erase `constructor(private readonly x: T)`.
  constructor(browser: DoubaoBrowserLike, options: {
    pollIntervalMs?: number
    turnTimeoutMs?: number
    stablePolls?: number
  } = {}) {
    this.browser = browser
    this.options = options
  }

  async run(
    prompt: string,
    onEvent: (event: DoubaoTurnEvent) => void,
    isCancelled: () => boolean = () => false,
  ): Promise<{ stopReason: 'end_turn' | 'cancelled' }> {
    const pollIntervalMs = this.options.pollIntervalMs ?? 350
    const turnTimeoutMs = this.options.turnTimeoutMs ?? 300_000
    // The page has no control we can read to ask "is it still writing?" (the
    // desktop build renders none), so completion is judged by the answer
    // itself: 豆包's text grows chunk by chunk and then stops (measured
    // 2026-11-05: the answer changed on every poll while writing and then
    // stayed identical). Waiting for the text to hold still is what keeps a
    // half-written answer from being read as the whole one.
    const stablePolls = this.options.stablePolls ?? 5
    const deadline = Date.now() + turnTimeoutMs

    await this.browser.sendPrompt(prompt)

    let answered = ''
    let stable = 0
    const reportedTools = new Set<string>()
    for (;;) {
      if (isCancelled()) {
        await this.browser.stopGeneration()
        onEvent({ kind: 'done' })
        return { stopReason: 'cancelled' }
      }
      const snapshot = await this.browser.snapshot()
      const turn = parseTurn(snapshot, prompt)
      // The page shows 豆包's tool activity before its answer, so the tool
      // frames go out first: the transcript then reads in the order the user
      // watched it happen.
      for (const action of turn.toolActions) {
        if (reportedTools.has(action)) continue
        reportedTools.add(action)
        onEvent({ kind: 'tool', action })
      }
      if (turn.answer.length > 0 && turn.answer !== answered) {
        const delta = answerDelta(answered, turn.answer)
        answered = turn.answer
        stable = 0
        if (delta.length > 0) onEvent({ kind: 'text', text: delta })
      } else if (turn.answer.length > 0) {
        stable += 1
      }
      if (turn.started && turn.answer.length > 0 && stable >= stablePolls && !snapshot.generating) {
        onEvent({ kind: 'done' })
        return { stopReason: 'end_turn' }
      }
      if (Date.now() > deadline) {
        throw new Error(`豆包在 ${String(turnTimeoutMs)}ms 内没有答完这一轮`)
      }
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
    }
  }
}

type Session = {
  readonly id: string
  cancelled: boolean
}

/**
 * The ACP service.
 *
 * `handle` is the whole protocol surface, kept separate from stdio so the
 * behavior can be tested without a process.
 */
export class DoubaoAcpAgent {
  private readonly sessions = new Map<string, Session>()
  private browser: DoubaoBrowserLike | undefined
  private cancelled = false
  private readonly options: DoubaoAgentOptions

  // No constructor parameter properties (see DoubaoConversation).
  constructor(options: DoubaoAgentOptions = {}) {
    this.options = options
  }

  /** The frames the agent sends; replaced in tests. */
  notify: (frame: unknown) => void = () => {}

  private report(line: string): void {
    this.options.onDiagnostic?.(line)
  }

  private async ensureBrowser(): Promise<DoubaoBrowserLike> {
    if (this.browser) return this.browser
    const open = this.options.openBrowser
      ?? ((browserOptions: DoubaoBrowserOptions) => DoubaoBrowser.open({
        ...browserOptions,
        onDiagnostic: this.options.onDiagnostic,
      }))
    this.browser = await open({})
    return this.browser
  }

  /** Handle one ACP request and return its result. */
  async handle(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return {
          protocolVersion: 1,
          agentCapabilities: {
            promptCapabilities: { image: false, audio: false, embeddedContext: false },
            loadSession: false,
          },
          authMethods: [],
        }
      case 'session/new': {
        // The browser is NOT opened here. The host asks a fresh agent for its
        // model list while it builds the picker, and opening 豆包 at that
        // moment would (a) start the desktop app behind the user's back and
        // (b) collide with the instance they may already be running, which
        // makes this provider drop out of the picker instead of showing up.
        // The app is opened when a prompt actually arrives.
        const id = `doubao-${randomUUID()}`
        this.sessions.set(id, { id, cancelled: false })
        return {
          sessionId: id,
          models: {
            availableModels: [{ id: 'doubao-default', name: '豆包' }],
            currentModelId: 'doubao-default',
          },
        }
      }
      case 'session/prompt':
        return await this.runPrompt(params)
      case 'session/cancel': {
        const sessionId = params['sessionId']
        const session = typeof sessionId === 'string' ? this.sessions.get(sessionId) : undefined
        if (session) session.cancelled = true
        return {}
      }
      case 'session/set_config_option':
        // 豆包 picks its own model; there is nothing for a client to set.
        return {}
      default:
        throw new Error(`unsupported method: ${method}`)
    }
  }

  private async runPrompt(params: Record<string, unknown>): Promise<unknown> {
    const sessionId = params['sessionId']
    const session = typeof sessionId === 'string' ? this.sessions.get(sessionId) : undefined
    if (!session) throw new Error(`unknown session: ${String(sessionId)}`)
    const prompt = DoubaoAcpAgent.promptText(params['prompt'])
    const browser = await this.ensureBrowser()
    const conversation = new DoubaoConversation(browser, {
      pollIntervalMs: this.options.pollIntervalMs,
      turnTimeoutMs: this.options.turnTimeoutMs,
      stablePolls: this.options.stablePolls,
    })
    const outcome = await conversation.run(
      prompt,
      event => {
        if (event.kind === 'text') {
          this.notify({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: session.id,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: event.text },
              },
            },
          })
          return
        }
        if (event.kind === 'tool') {
          this.notify({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: session.id,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: `doubao-tool-${randomUUID()}`,
                title: event.action,
                kind: 'other',
                status: 'completed',
                rawInput: { detail: event.action },
                content: [{ type: 'content', content: { type: 'text', text: event.action } }],
              },
            },
          })
        }
      },
      () => session.cancelled,
    )
    return { stopReason: outcome.stopReason }
  }

  /** The user's text out of an ACP prompt, which is a list of content blocks. */
  static promptText(prompt: unknown): string {
    if (typeof prompt === 'string') return prompt
    if (!Array.isArray(prompt)) return ''
    const parts: string[] = []
    for (const block of prompt) {
      if (typeof block !== 'object' || block === null) continue
      const record = block as Record<string, unknown>
      if (record['type'] !== 'text') continue
      const text = record['text']
      if (typeof text === 'string') parts.push(text)
    }
    return parts.join('\n')
  }

  /** Release the browser. */
  async close(): Promise<void> {
    await this.browser?.close()
    this.browser = undefined
  }
}

/**
 * Run the agent on stdio until stdin closes.
 *
 * stdout carries the protocol and nothing else — a stray log line there
 * would break the frame stream — so diagnostics go to stderr.
 */
export function runStdioAgent(agent: DoubaoAcpAgent): void {
  // The frames the agent produces are the protocol's output: stdout carries
  // them and nothing else.
  agent.notify = frame => {
    process.stdout.write(JSON.stringify(frame) + '\n')
  }
  let buffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', chunk => {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line.length > 0) void handleLine(agent, line)
      index = buffer.indexOf('\n')
    }
  })
  process.stdin.on('end', () => {
    void agent.close().finally(() => process.exit(0))
  })
}

async function handleLine(agent: DoubaoAcpAgent, line: string): Promise<void> {
  let request: { id?: unknown; method?: unknown; params?: unknown }
  try {
    request = JSON.parse(line) as typeof request
  } catch {
    return
  }
  const id = request.id
  const method = typeof request.method === 'string' ? request.method : ''
  if (id === undefined) return
  try {
    const result = await agent.handle(method, (request.params ?? {}) as Record<string, unknown>)
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: { code: -32000, message },
    }) + '\n')
  }
}
