/**
 * Which frame dialect an agent speaks — the one list of that mapping.
 *
 * It used to live inside the session factory, but the model probe needs the
 * same answer ("which dialect reads this agent's model list?") and a second
 * copy of the mapping is how the probe ends up reading a list the sessions
 * never see. So the table lives here and the factory imports it.
 *
 * The dialect modules are imported directly rather than through `index.ts`:
 * `index.ts` re-exports the factory, and a cycle back into it would make the
 * table's contents depend on module evaluation order.
 */

import { claudeDialect } from './dialects/claude.ts'
import { codexDialect } from './dialects/codex.ts'
import { cursorDialect } from './dialects/cursor.ts'
import { doubaoDialect } from './dialects/doubao.ts'
import { grokDialect } from './dialects/grok.ts'
import { qoderDialect } from './dialects/qoder.ts'
import type { AcpDialect } from './dialects/types.ts'

/** The dialect per agent id. An agent not named here is not ours. */
export const DIALECTS: Readonly<Record<string, AcpDialect>> = {
  grok: grokDialect,
  claude: claudeDialect,
  codex: codexDialect,
  cursor: cursorDialect,
  doubao: doubaoDialect,
  qoder: qoderDialect,
}

/**
 * The dialect of one agent id, or `undefined` when the agent is not ours.
 * @param agent - the agent id from the preset configuration.
 */
export function dialectForAgent(agent: string | undefined): AcpDialect | undefined {
  if (agent === undefined) return undefined
  return DIALECTS[agent]
}
