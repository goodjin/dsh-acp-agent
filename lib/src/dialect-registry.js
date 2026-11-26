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
import { claudeDialect } from "./dialects/claude.js";
import { codexDialect } from "./dialects/codex.js";
import { cursorDialect } from "./dialects/cursor.js";
import { grokDialect } from "./dialects/grok.js";
import { qoderDialect } from "./dialects/qoder.js";
/** The dialect per agent id. An agent not named here is not ours. */
export const DIALECTS = {
    grok: grokDialect,
    claude: claudeDialect,
    codex: codexDialect,
    cursor: cursorDialect,
    qoder: qoderDialect,
};
/**
 * The dialect of one agent id, or `undefined` when the agent is not ours.
 * @param agent - the agent id from the preset configuration.
 */
export function dialectForAgent(agent) {
    if (agent === undefined)
        return undefined;
    return DIALECTS[agent];
}
