import { describe, expect, it } from 'vitest'
import { attachPage, connectCdp, evaluate, type WebSocketLike } from '../src/doubao/cdp.ts'

type Listener = (event: { data?: unknown }) => void

/**
 * A socket that answers CDP commands from a table.
 *
 * The real browser is not needed to know that a command and its reply are
 * correlated, that an error rejects, and that a page value comes back.
 */
class FakeSocket implements WebSocketLike {
  readonly sent: { id: number; method: string; params?: Record<string, unknown>; sessionId?: string }[] = []
  private readonly listeners = new Map<string, Listener[]>()
  closed = false

  constructor(private readonly reply: (message: { id: number; method: string; params?: Record<string, unknown> }) => unknown) {
    // The client attaches its listeners right after the socket is handed to
    // it, so the open event has to arrive on a later turn of the loop.
    queueMicrotask(() => this.emit('open', {}))
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }

  send(data: string): void {
    const message = JSON.parse(data) as { id: number; method: string; params?: Record<string, unknown>; sessionId?: string }
    this.sent.push(message)
    const result = this.reply(message)
    if (result === undefined) return
    // A CDP error frame carries `error` beside the id, not inside `result`.
    const envelope = (result as { error?: unknown }).error !== undefined
      ? { id: message.id, error: (result as { error: unknown }).error }
      : { id: message.id, result }
    this.emit('message', { data: JSON.stringify(envelope) })
  }

  close(): void {
    this.closed = true
  }

  /** Push an event to whoever subscribed. */
  emit(type: string, event: { data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

function connectionWith(reply: (message: { id: number; method: string; params?: Record<string, unknown> }) => unknown, timeoutMs?: number) {
  // The socket is built inside the factory: a fake constructed earlier would
  // announce its open event before the client attached its listener.
  let socket: FakeSocket | undefined
  const promise = connectCdp(1234, {
    socketFactory: () => {
      socket = new FakeSocket(reply)
      return socket
    },
    fetchVersion: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:1234/devtools/browser/x' }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  })
  return { get socket() { return socket! }, promise }
}

describe('the doubao devtools client', () => {
  it('correlates a command with its reply', async () => {
    const harness = connectionWith(message => {
      if (message.method === 'Target.getTargets') {
        return { targetInfos: [{ targetId: 'T1', type: 'page', url: 'chrome://doubao-chat/chat' }] }
      }
      if (message.method === 'Target.attachToTarget') return { sessionId: 'S1' }
      if (message.method === 'Runtime.evaluate') return { result: { value: 42 } }
      return {}
    })
    const connection = await harness.promise
    const session = await attachPage(connection, url => url.includes('doubao-chat/chat'))
    expect(session?.sessionId).toBe('S1')
    expect(session?.targetId).toBe('T1')
    const value = await evaluate<number>(connection, session!.sessionId, '1 + 41')
    expect(value).toBe(42)
    expect(harness.socket.sent.map(message => message.method)).toEqual([
      'Target.getTargets',
      'Target.attachToTarget',
      'Runtime.evaluate',
    ])
    connection.close()
    expect(harness.socket.closed).toBe(true)
  })

  it('rejects when the browser answers with an error', async () => {
    const { promise } = connectionWith(() => ({ error: { message: 'boom' } }))
    const connection = await promise
    await expect(connection.send('Runtime.evaluate')).rejects.toThrow(/boom/)
  })

  it('rejects when the command outruns its deadline', async () => {
    const { promise } = connectionWith(() => undefined, 50)
    const connection = await promise
    await expect(connection.send('Runtime.evaluate')).rejects.toThrow(/timed out/)
  })

  it('reports a page exception instead of returning nothing', async () => {
    const { promise } = connectionWith(() => ({ exceptionDetails: { exception: { description: 'ReferenceError: x' } } }))
    const connection = await promise
    await expect(evaluate(connection, 'S1', 'x')).rejects.toThrow(/ReferenceError/)
  })

  it('finds no page when nothing matches', async () => {
    const { promise } = connectionWith(() => ({ targetInfos: [] }))
    const connection = await promise
    expect(await attachPage(connection, () => true)).toBeUndefined()
  })
})
