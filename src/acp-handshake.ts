/**
 * The ACP handshake, in one place.
 *
 * `initialize` carries the client's capabilities, and the agents read them:
 * cursor reads the subagent draft out of `_meta`, codex reads the AIR contract
 * out of `_meta.jetbrains.air`, and a client that declares less gets a
 * different agent than the one the sessions talk to. The model probe only
 * reads a list, but it has to talk to the *same* agent the sessions do — so
 * the parameters live here and both callers send exactly these.
 *
 * Kept beside the runner rather than inside it because there are two callers
 * now (the runner that opens a session, the probe that opens one to read a
 * list), and two copies of a capability list is how a probe ends up asking a
 * question the sessions never ask.
 */

import type { AcpDialect } from './dialects/types.ts'

/** The `initialize` parameters, as the wire sees them. */
export type AcpInitializeParams = {
  readonly protocolVersion: number
  readonly clientCapabilities: {
    readonly fs: { readonly readTextFile: boolean; readonly writeTextFile: boolean }
    readonly terminal: boolean
    readonly subagents: Record<string, never>
    readonly _meta: Record<string, unknown>
  }
}

/**
 * The `initialize` parameters one dialect expects.
 *
 * The `subagents` draft field and the `_meta.jetbrains.air` extension both
 * ride along: the released SDK strips the draft field off before the adapter
 * sees it, so the adapters read the `_meta` spelling instead. An agent that
 * knows neither ignores the unknown keys.
 * @param dialect - the agent's dialect; absent means the plain capabilities.
 * @returns the parameters for the `initialize` request.
 */
export function acpInitializeParams(dialect: AcpDialect | undefined): AcpInitializeParams {
  const capabilities = dialect?.capabilities
  return {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
      subagents: {},
      _meta: {
        ...(capabilities?.metaSubagents === true ? { subagents: {} } : {}),
        ...(capabilities?.terminalOutputDelta === true ? { terminal_output_delta: true } : {}),
        jetbrains: { air: { version: 1, capabilities: ['nativeSubagentSessions', 'asyncTasks'] } },
      },
    },
  }
}
