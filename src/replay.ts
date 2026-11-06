/**
 * Putting a finished conversation back on a record, one event at a time.
 *
 * A switch continues in a NEW session — a started session's agent cannot be
 * changed, and a fork of one replays that same lock. The conversation the user
 * was looking at therefore does not come along by itself: the new agent reads
 * it as primed text, and its session's own record starts empty. That is what
 * made the switch look like it lost the history — the user opened the new
 * session and read a blank thread.
 *
 * So the visible conversation is copied into the new session's log, event by
 * event and in order, before the new session is asked anything. What travels is
 * the record the user already read: the questions, the answers, the tool calls
 * and their results, and the turn and step boundaries that group them. What
 * stays behind is the old agent's own bookkeeping — its request header, its
 * system prompt, its retry records, its seed marker — because those belong to
 * the agent that is being left, not to the conversation.
 *
 * Two rules keep the copy honest:
 *
 * - it stops at the last completed turn. The turn that is switching away is
 *   open and holds the question, which is about to be asked in the new session;
 *   copying it would put one question in two conversations;
 * - a surface replacement (a compaction checkpoint) is left behind rather than
 *   replayed, because it names surface positions by sequence number and those
 *   positions belong to different events here.
 */

/** One event as a session log exposes it, read structurally. */
export type LoggedEvent = {
  readonly type: string
  readonly data?: unknown
  readonly surfaceOp?: unknown
}

/** One event to write into the new session, in the order it must be written. */
export type ReplayStep = {
  readonly type: string
  readonly data: unknown
  /** Model-visible messages enter the surface; the rest are log-only records. */
  readonly surface: boolean
}

export type ReplayPlan = {
  readonly steps: readonly ReplayStep[]
  /** How many finished turns the plan carries. */
  readonly turns: number
}

/**
 * The events a copied conversation is made of.
 *
 * Boundaries travel with the content because the view groups content under the
 * step the loop opened for it: content written under a step the view never saw
 * start is dropped by the client. The two bridged sub-call records travel with
 * the tool calls they belong to, so a nested call still renders inside its
 * parent's card.
 */
const CARRIED_TYPES: ReadonlySet<string> = new Set([
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'user/message',
  'assistant/message',
  'tool/call',
  'tool/ptc-dispatch-start',
  'tool/ptc-dispatch',
  'tool/result',
])

/** Events that enter the model-visible surface, and so need the append intent. */
const SURFACE_TYPES: ReadonlySet<string> = new Set([
  'user/message',
  'assistant/message',
  'tool/result',
])

/** Whether this event is a plain surface append, or a replacement to leave behind. */
function isPlainAppend(event: LoggedEvent): boolean {
  return event.surfaceOp === undefined || event.surfaceOp === 'append'
}

/** One turn's worth of steps, with the boundaries that place them. */
function turnSteps(events: readonly LoggedEvent[]): ReplayStep[] {
  const steps: ReplayStep[] = []
  for (const event of events) {
    if (!CARRIED_TYPES.has(event.type)) continue
    if (!isPlainAppend(event)) continue
    steps.push({ type: event.type, data: event.data, surface: SURFACE_TYPES.has(event.type) })
  }
  return steps
}

/** Split a log's prefix into its finished turns, oldest first. */
function finishedTurns(events: readonly LoggedEvent[]): ReplayStep[][] {
  const turns: ReplayStep[][] = []
  let open: ReplayStep[] | undefined
  for (const event of events) {
    if (event.type === 'turn/start') {
      // A turn that starts before another one closed means the log is not the
      // record this planner understands; the newest closed turn wins and the
      // half-open one is dropped with the tail.
      if (open !== undefined) open = undefined
      open = []
    }
    if (open === undefined) continue
    open.push(...turnSteps([event]))
    if (event.type === 'turn/end') {
      turns.push(open)
      open = undefined
    }
  }
  return turns
}

import { pairToolResults } from './tool-pairing.ts'

/**
 * The conversation to copy, as events ready to write.
 * @param events - the source session's log, in order; anything after the last completed turn is ignored.
 */
export function planReplay(events: readonly LoggedEvent[]): ReplayPlan {
  const turns = finishedTurns(events)
  return { steps: pairTurns(turns.flat()), turns: turns.length }
}

/**
 * Re-pair the copied steps so every tool call is answered by the result right
 * after it.
 *
 * The log is faithful to what happened, and what happened includes results
 * recorded away from their calls: a background subagent's outcome lands at the
 * tail of the log when a turn ends interrupted. The view renders that fine,
 * but a native DeepSeek request built from the copy demands each call answered
 * immediately, or the turn dies as "tool calls need immediate results". The
 * request path already re-pairs with `pairToolResults` (model-plugins.ts);
 * this runs the same repair on the log-copy path, so both exits from this
 * plugin hand over a paired history.
 *
 * Steps go in as the message shape `pairToolResults` reads (role, content,
 * toolCallId at the top level), each carrying its source step for the way
 * back; results the pairing itself inserts (the "outcome unknown" answers)
 * have no source and become tool/result steps of their own.
 */
function pairTurns(steps: readonly ReplayStep[]): ReplayStep[] {
  const sourceOf = new Map<Message & { source?: ReplayStep }, ReplayStep | undefined>()
  const messages = steps.map(step => {
    const message = stepAsMessage(step)
    sourceOf.set(message, step)
    return message
  })
  return pairToolResults(messages).map(message => {
    const source = sourceOf.get(message as Message & { source?: ReplayStep })
    if (source !== undefined) return source
    const record = message as { toolCallId?: unknown; isError?: unknown; content?: unknown }
    return {
      type: 'tool/result',
      data: { message: { role: 'tool', toolCallId: record.toolCallId, isError: record.isError === true, content: Array.isArray(record.content) ? record.content : [] } },
      surface: true,
    }
  })
}

type Message = Record<string, unknown>

/** Read one step as the message shape `pairToolResults` consumes. */
function stepAsMessage(step: ReplayStep): Message & { source?: ReplayStep } {
  if (step.type === 'tool/result') {
    const message = (step.data as { message?: Record<string, unknown> } | undefined)?.message
    return message !== undefined && typeof message === 'object'
      ? { ...message, source: step }
      : { role: 'tool', source: step }
  }
  if (step.type === 'tool/call') {
    // A call step renders as the assistant turn that carries the tool-use block.
    const data = (step.data ?? {}) as { callId?: unknown; name?: unknown }
    return {
      role: 'assistant',
      content: [typeof data.callId === 'string' ? { type: 'tool-call', id: data.callId, name: data.name ?? '' } : { type: 'text', text: '' }],
      source: step,
    }
  }
  if (step.type === 'user/message' || step.type === 'assistant/message') {
    const message = (step.data as { message?: Record<string, unknown> } | undefined)?.message
    return message !== undefined && typeof message === 'object' ? { ...message, source: step } : { source: step }
  }
  // Boundary events (turn/start, step/end, …): not messages; pass through.
  return { role: 'boundary', source: step }
}

/** The session log's append, if this session has one. */
function appendOf(session: unknown): ((type: string, data: unknown, intent?: unknown) => unknown) | undefined {
  const holder = session as { append?: unknown } | undefined
  if (typeof holder?.append !== 'function') return undefined
  const append = holder.append as (this: unknown, type: string, data: unknown, intent?: unknown) => unknown
  return (type, data, intent) => (intent === undefined ? append.call(holder, type, data) : append.call(holder, type, data, intent))
}

/** Whether this session has a log to write into at all. */
export function hasLog(session: unknown): boolean {
  return appendOf(session) !== undefined
}

/**
 * Write one plan into a live session.
 *
 * A refusal part-way leaves the session holding half a conversation, so the
 * error names how far it got — the caller decides whether that session is
 * still worth continuing in.
 * @returns how many events were written.
 */
export function replayInto(session: unknown, steps: readonly ReplayStep[]): number {
  const append = appendOf(session)
  if (append === undefined) {
    throw new Error('cannot replay the conversation: this session has no log to append to')
  }
  let written = 0
  for (const step of steps) {
    try {
      if (step.surface) append(step.type, step.data, { surfaceOp: 'append' })
      else append(step.type, step.data)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(
        `cannot replay the conversation: ${written} of ${steps.length} events written before this session refused one — ${reason}`,
      )
    }
    written += 1
  }
  return written
}
