/**
 * A read-only probe of an ACP agent's published model list.
 *
 * The list an agent serves is not a file anyone can read: it comes out of the
 * agent itself, in the `session/new` reply (`models.availableModels`, or the
 * model config option, depending on the agent). So the only honest way to
 * learn "what does this agent serve right now" is to ask the agent — start it,
 * handshake, open one session, read the list off the reply, and leave. No
 * prompt is ever sent, so nothing is spent and no conversation happens.
 *
 * The same three questions every time, whichever agent:
 * - **How is it reached?** grok is a WebSocket server the transport starts and
 *   owns (`grok agent serve`); everyone else is a child process speaking ACP
 *   over stdio, with the arguments and the environment the shared spawn table
 *   says (`spawn-args.ts`) — the same ones the sessions use, or the probe
 *   would ask a different agent than the user's.
 * - **What if it needs a login?** Some agents refuse `session/new` until they
 *   are logged in. Qoder's refusal is the documented one ("Authentication
 *   required"); the probe answers it the way the runner does — authenticate on
 *   demand, once, and retry — and when that cannot work either, it says so
 *   with the login command to run, instead of reporting a silent success.
 * - **What if it hangs?** A button must not hold the settings dialog
 *   hostage: the whole probe is bounded (60 s), and the child process is
 *   always reclaimed, on every path out.
 *
 * The failure is a value, not a free-form string: {@link AcpProbeError}
 * carries a reason code, and the reason is what the user is told. "It did not
 * work" is not an answer; "the agent is not logged in — run `qoderclicn
 * login`" is.
 */

import { homedir } from 'node:os'
import { basename } from 'node:path'
import { AcpClient } from './client.ts'
import { acpInitializeParams } from './acp-handshake.ts'
import type { AcpDialect } from './dialects/types.ts'
import { dialectForAgent } from './dialect-registry.ts'
import { stdioArgsFor, stdioEnvFor } from './spawn-args.ts'
import { GrokServeTransport, StdioAcpTransport } from './transport.ts'
import type { AcpTransport } from './transport.ts'
import type { ReportedModel } from './catalog-registration.ts'

/**
 * Why a probe did not answer with a list.
 *
 * The codes are what the user is told; the message carries the technical
 * detail (the agent's own words) underneath them.
 */
export type AcpProbeReason =
  /** The agent refused because it is not logged in. */
  | 'not-logged-in'
  /** The authenticate round-trip itself failed. */
  | 'auth-failed'
  /** The agent answered, but published no models at all. */
  | 'empty-list'
  /** The agent did not answer within the deadline. */
  | 'timeout'
  /** The command could not be started at all. */
  | 'spawn-failed'
  /** The agent answered the open, but not with a list we can read. */
  | 'session-failed'

/** A probe failure with a reason the user can act on. */
export class AcpProbeError extends Error {
  /** Why the probe did not answer with a list. */
  readonly reason: AcpProbeReason
  /** The command that logs the agent in, when one is known. */
  readonly login: string | undefined

  constructor(reason: AcpProbeReason, message: string, login?: string) {
    super(message)
    this.name = 'AcpProbeError'
    this.reason = reason
    this.login = login
  }
}

/** The probe's default deadline: one open must not hold the button forever. */
export const ACP_PROBE_TIMEOUT_MS = 60_000

/**
 * The login step's own budget.
 *
 * The authenticate round-trip is the one call an agent can leave hanging on
 * purpose: Qoder's CLI answers it by asking for an interactive login, which
 * never comes over a pipe. So the step gets a short budget of its own — a
 * probe that cannot log the agent in says "not logged in" in seconds, instead
 * of sitting on the whole deadline and reporting a timeout that hides the
 * real reason.
 */
export const ACP_AUTH_TIMEOUT_MS = 15_000

/** The probe's seams: which agent, which command, and where it may run. */
export type AcpProbeOptions = {
  /** The agent kind (`qoder`, `claude`, …); picks the dialect and the transport. */
  readonly agent: string
  /** The command the preset declares for this agent. */
  readonly command: string
  /** The preset's own arguments; absent means the shared per-agent default. */
  readonly args?: readonly string[]
  /** Where the probe runs; defaults to the home directory (no workspace of its own). */
  readonly cwd?: string
  /** Whole-probe deadline; the process is killed when it fires. */
  readonly timeoutMs?: number
  /** Test seam: build the transport instead of spawning a real process. */
  readonly createTransport?: (options: {
    readonly command: string
    readonly cwd: string
    readonly args: readonly string[]
    readonly env: NodeJS.ProcessEnv | undefined
  }) => Promise<AcpTransport>
}

/**
 * Which agents know how to log themselves in, and how.
 *
 * The command is derived from the preset's own command (its file name), so the
 * CN build says `qoderclicn login` and the international one says
 * `qodercli login` — the same binary, spelled as it is on this machine.
 */
const LOGIN_SUBCOMMAND: Readonly<Record<string, string>> = {
  qoder: 'login',
  cursor: 'login',
}

/**
 * The command that logs this agent in, or `undefined` when we do not know one.
 *
 * Guessing would be worse than saying nothing: a wrong login command sends
 * the user to a command that fails, and the failure reads as "the plugin is
 * broken".
 */
export function loginCommandFor(agent: string, command: string): string | undefined {
  const subcommand = LOGIN_SUBCOMMAND[agent]
  if (subcommand === undefined) return undefined
  const name = basename(command)
  return name === '' ? undefined : `${name} ${subcommand}`
}

/**
 * One read-only probe: start the agent, read the list it publishes, leave.
 *
 * The process is reclaimed on every path out — a normal answer, a timeout, a
 * refusal, a crash — so a refresh never leaves an agent running behind the
 * settings dialog.
 *
 * @param options - the agent, its command and the probe's seams.
 * @returns the models the agent published, in the order it published them.
 */
export async function probeAcpModels(options: AcpProbeOptions): Promise<readonly ReportedModel[]> {
  const dialect = dialectForAgent(options.agent)
  if (dialect === undefined) {
    throw new AcpProbeError('session-failed', `no ACP dialect for agent ${options.agent}`)
  }
  const cwd = options.cwd ?? homedir()
  const args = options.args ?? stdioArgsFor(options.agent)
  const env = stdioEnvFor(options.agent)
  const login = loginCommandFor(options.agent, options.command)
  let transport: AcpTransport
  try {
    transport = await (options.createTransport !== undefined
      ? options.createTransport({ command: options.command, cwd, args, env })
      : transportFor(options.agent, options.command, cwd, args, env))
  } catch (error) {
    throw new AcpProbeError('spawn-failed', `could not start ${options.command}: ${messageOf(error)}`, login)
  }
  try {
    const ms = options.timeoutMs ?? ACP_PROBE_TIMEOUT_MS
    return await withDeadline(
      readModelsOver(transport, dialect, cwd),
      ms,
      () => new AcpProbeError('timeout', `the ${options.agent} model probe did not answer within ${String(ms)}ms`, login),
    )
  } catch (error) {
    throw classify(error, login)
  } finally {
    await reclaim(transport)
  }
}

/** The transport one agent is reached over. */
async function transportFor(
  agent: string,
  command: string,
  cwd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv | undefined,
): Promise<AcpTransport> {
  if (agent === 'grok') {
    // grok is a WebSocket server, not a stdio child: the transport starts
    // `grok agent serve` and owns it until the probe closes it.
    return await GrokServeTransport.create({ command, cwd })
  }
  return new StdioAcpTransport({
    command,
    args,
    cwd,
    ...(env === undefined ? {} : { env }),
    // Its own process group: an agent that starts a helper of its own (cursor
    // runs a worker server) would otherwise leave that helper running after
    // the probe is done.
    detached: true,
  })
}

/** The handshake-and-read half of the probe, over a ready transport. */
async function readModelsOver(
  transport: AcpTransport,
  dialect: AcpDialect,
  cwd: string,
): Promise<readonly ReportedModel[]> {
  const client = new AcpClient(transport, dialect)
  const initializeResult = await client.request('initialize', acpInitializeParams(dialect))
  client.notify('initialized', {})
  // The method id is the agent's own: the CN and international Qoder builds
  // name theirs differently, and the initialize reply is the only source that
  // holds across both.
  const methodId = dialect.authenticateMethodId
    ?? dialect.authenticateMethodIdFrom?.(initializeResult)
  const authenticate = methodId === undefined
    ? undefined
    : async (failure: AcpProbeReason): Promise<void> => {
      try {
        await withDeadline(
          client.request('authenticate', { methodId }),
          ACP_AUTH_TIMEOUT_MS,
          () => new AcpProbeError(failure, `the ${dialect.id} agent's login step did not answer within ${String(ACP_AUTH_TIMEOUT_MS)}ms`),
        )
      } catch (error) {
        if (error instanceof AcpProbeError) throw error
        throw new AcpProbeError(failure, `the ${dialect.id} agent's login step failed: ${messageOf(error)}`)
      }
    }
  // Cursor must authenticate before session/new; Qoder must not (its CLI is
  // logged in already, and its authenticate intermittently stalls). The
  // dialect says which — the runner reads the same flag.
  if (authenticate !== undefined && dialect.authenticateOnDemand !== true) {
    await authenticate('auth-failed')
  }
  const openSession = async (): Promise<unknown> => await client.request('session/new', { cwd, mcpServers: [] })
  let reply: unknown
  try {
    reply = await openSession()
  } catch (error) {
    const wantsAuth = dialect.authenticateOnDemand === true
      && dialect.sessionNeedsAuthenticate?.(error) === true
    if (!wantsAuth || authenticate === undefined) throw error
    // The agent asked for a login and the login step did not give it one:
    // that is "not logged in", not a broken handshake.
    await authenticate('not-logged-in')
    reply = await openSession()
  }
  const models = dialect.readModels(reply)
  if (models.length === 0) {
    throw new AcpProbeError('empty-list', `the ${dialect.id} agent reported no models on session/new`)
  }
  return models
}

/**
 * Give the failure its reason code.
 *
 * The codes are what the user is told; the agent's own words stay in the
 * message underneath them.
 */
function classify(error: unknown, login: string | undefined): AcpProbeError {
  if (error instanceof AcpProbeError) {
    return error.login === undefined && login !== undefined
      ? new AcpProbeError(error.reason, error.message, login)
      : error
  }
  const message = messageOf(error)
  if (/could not run/i.test(message)) return new AcpProbeError('spawn-failed', message, login)
  if (/authentication required|not authenticated|unauthorized/i.test(message)) {
    return new AcpProbeError('not-logged-in', message, login)
  }
  return new AcpProbeError('session-failed', message, login)
}

/** Bound a promise; the loser's late rejection is silenced, not dropped. */
async function withDeadline<T>(work: Promise<T>, ms: number, message: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  // The race resolves on the deadline, but the work may still reject later
  // (the transport close below fails its in-flight requests). The host treats
  // an unhandled rejection as fatal, so the loser's rejection needs a taker —
  // the race above is the one that matters.
  work.catch(() => {})
  return await Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => { reject(message()) }, ms)
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

/**
 * Reclaim the probe's process.
 *
 * Asking is not the same as the process being gone, so the transports that own
 * a child are asked to wait for it (and to insist, if it ignores SIGTERM).
 * A transport without that seam is closed the ordinary way.
 */
async function reclaim(transport: AcpTransport): Promise<void> {
  const shutdown = (transport as { shutdown?: (graceMs?: number) => Promise<void> }).shutdown
  try {
    if (typeof shutdown === 'function') {
      await shutdown.call(transport)
      return
    }
    transport.close()
  } catch {
    // Reclaiming must never turn a probe's answer into a failure.
  }
}

/** The message of any thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
