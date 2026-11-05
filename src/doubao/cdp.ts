/**
 * A minimal Chrome DevTools Protocol client.
 *
 * The Doubao desktop app is a Chromium shell (ByteDance's "saman"), not an
 * Electron app: it has no `app.asar` and no CLI, but the whole browser is
 * reachable over CDP when it is started with `--remote-debugging-port`
 * (measured 2026-11-05: the shell forwards the switch to its embedded
 * Chromium, and the chat page then appears as the target
 * `chrome://doubao-chat/chat`).
 *
 * So the protocol client is the only thing we need to drive the app: no
 * third-party driver, and Node's own WebSocket is enough.
 *
 * Two facts shaped this file:
 *
 *   - `Page.addScriptToEvaluateOnNewDocument` belongs to the CDP *session*.
 *     A script registered on one session is gone once that session detaches
 *     (measured 2026-11-05: injected on one connection, reloaded through
 *     another, the hook had vanished). Therefore the caller keeps ONE
 *     connection for the whole life of the browser it drives.
 *   - The client must be testable without a browser, so the socket is
 *     injectable: a fake answers `Target.getTargets` and friends in a unit
 *     test, the real app in production.
 */

/** The part of a WebSocket this client needs, so a test can stand one in. */
export type WebSocketLike = {
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void
  send(data: string): void
  close(): void
}

/** A page target we attached to. */
export type CdpSession = {
  readonly sessionId: string
  readonly targetId: string
}

export type CdpConnection = {
  /**
   * Send one CDP command.
   *
   * Rejects when the browser answers with an `error`, when the command
   * outruns `timeoutMs`, and when the socket dies with a command in flight —
   * a silent socket and a silent browser look identical otherwise.
   */
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>
  /** Subscribe to a CDP event. Returns an unsubscribe function. */
  on(method: string, handler: (params: any) => void): () => void
  close(): void
}

const DEFAULT_TIMEOUT_MS = 30_000

type Pending = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  method: string
}

/**
 * Open a DevTools connection to a browser listening on `port`.
 *
 * The browser's own `/json/version` hands out the WebSocket URL, so the port
 * is the only thing the caller has to know.
 */
export async function connectCdp(
  port: number,
  options?: {
    socketFactory?: (url: string) => WebSocketLike
    timeoutMs?: number
    /** Injected in tests: how the browser's version endpoint is read. */
    fetchVersion?: () => Promise<{ webSocketDebuggerUrl?: string }>
  },
): Promise<CdpConnection> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const readVersion = options?.fetchVersion
    ?? (async () => await fetch(`http://127.0.0.1:${port}/json/version`).then(r => r.json()) as { webSocketDebuggerUrl?: string })
  const version = await readVersion()
  const url = version.webSocketDebuggerUrl
  if (typeof url !== 'string' || url.length === 0) {
    throw new Error(`devtools endpoint on port ${port} did not return a websocket url`)
  }
  const socket = options?.socketFactory
    ? options.socketFactory(url)
    : new WebSocket(url) as unknown as WebSocketLike

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`devtools websocket on port ${port} did not open`)), timeoutMs)
    socket.addEventListener('open', () => {
      clearTimeout(timer)
      resolve()
    })
    socket.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error(`devtools websocket on port ${port} failed to open`))
    })
  })

  let seq = 0
  const pending = new Map<number, Pending>()
  const listeners = new Map<string, Set<(params: any) => void>>()

  socket.addEventListener('message', (event) => {
    const raw = typeof event.data === 'string' ? event.data : String(event.data ?? '')
    let message: any
    try {
      message = JSON.parse(raw)
    } catch {
      return
    }
    if (typeof message?.id === 'number' && pending.has(message.id)) {
      const entry = pending.get(message.id)
      pending.delete(message.id)
      clearTimeout(entry!.timer)
      if (message.error) {
        entry!.reject(new Error(`${entry!.method} failed: ${message.error.message ?? JSON.stringify(message.error)}`))
      } else {
        entry!.resolve(message.result)
      }
      return
    }
    if (typeof message?.method === 'string') {
      const handlers = listeners.get(message.method)
      if (!handlers) return
      for (const handler of [...handlers]) {
        try {
          handler(message.params)
        } catch {
          // A listener that throws must not take the connection down with it.
        }
      }
    }
  })

  const connection: CdpConnection = {
    send(method, params, sessionId) {
      return new Promise<unknown>((resolve, reject) => {
        const id = ++seq
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`${method} timed out after ${String(timeoutMs)}ms`))
        }, timeoutMs)
        pending.set(id, { resolve, reject, timer, method })
        try {
          socket.send(JSON.stringify(sessionId === undefined
            ? { id, method, ...(params === undefined ? {} : { params }) }
            : { id, method, ...(params === undefined ? {} : { params }), sessionId }))
        } catch (error) {
          pending.delete(id)
          clearTimeout(timer)
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
    },
    on(method, handler) {
      let handlers = listeners.get(method)
      if (!handlers) {
        handlers = new Set()
        listeners.set(method, handlers)
      }
      handlers.add(handler)
      return () => {
        handlers?.delete(handler)
      }
    },
    close() {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer)
        entry.reject(new Error('devtools connection closed'))
      }
      pending.clear()
      socket.close()
    },
  }
  return connection
}

/**
 * Attach to the first page target whose URL satisfies `match`.
 *
 * Undefined when no target matches — the caller decides whether that is a
 * wait-for-it condition or an error.
 */
export async function attachPage(
  connection: CdpConnection,
  match: (url: string) => boolean,
): Promise<CdpSession | undefined> {
  const result = await connection.send('Target.getTargets') as { targetInfos?: { targetId: string; type: string; url: string }[] }
  const target = (result.targetInfos ?? []).find(info => info.type === 'page' && match(info.url))
  if (!target) return undefined
  const attached = await connection.send('Target.attachToTarget', { targetId: target.targetId, flatten: true }) as { sessionId?: string }
  if (typeof attached.sessionId !== 'string') {
    throw new Error(`could not attach to target ${target.targetId}`)
  }
  return { sessionId: attached.sessionId, targetId: target.targetId }
}

/** Evaluate an expression in the page and return its value. */
export async function evaluate<T = unknown>(
  connection: CdpConnection,
  sessionId: string,
  expression: string,
): Promise<T> {
  const result = await connection.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  }, sessionId) as { result?: { value?: T }; exceptionDetails?: { text?: string; exception?: { description?: string } } }
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'page threw'
    throw new Error(`page evaluation failed: ${detail}`)
  }
  return result.result?.value as T
}
