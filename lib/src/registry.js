/**
 * Turning configuration into the preset table the dispatcher consults.
 *
 * Only ACP presets belong in this table, and a native preset must be **absent**
 * rather than present-and-skipped: absence is what lets the dispatcher leave
 * those sessions completely alone, with nothing left to forget.
 */
/** A fresh place to keep open conversations, for restart to clear. */
export function sessionsRegistry() {
    return new Map();
}
/**
 * The workspace a new external conversation may open in.
 *
 * Only the session's own directory counts. A preset directory and this
 * process's directory are not workspaces, so a session that names neither
 * is refused instead of being parked in one of them.
 */
export function cwdForOpen(sessionCwd) {
    if (typeof sessionCwd === 'string' && sessionCwd !== '')
        return sessionCwd;
    throw new Error('这个会话没有工作区，外部会话不会在预设目录或宿主进程目录里开工');
}
/**
 * Build the preset table.
 *
 * One agent process is shared per preset on first use and reused by all DSH
 * sessions on that preset. Each DSH session opens its own ACP session
 * (`session/new` or `session/resume`) on the shared connection, keeping
 * conversation histories isolated. When a connection dies, the shared agent
 * is revived on next use: a fresh process spawns and all cached sessions
 * reattach via `session/resume` (or fall back to text replay).
 */
export function buildPresetTable(config, factory, sessions, options = {}) {
    const table = new Map();
    for (const [presetId, preset] of Object.entries(config.presets)) {
        if (preset.agent === undefined)
            continue;
        const dialect = factory.dialectFor(presetId, preset);
        // Not an agent we drive: leave whatever that preset is entirely alone.
        if (dialect === undefined)
            continue;
        // The capability table decides whether this agent can be stopped at all:
        // a dialect that does not declare `cancelsTurns` gets no cancel notice,
        // keeping the table the single source of truth for what an agent can do.
        const stopsTurns = dialect.capabilities?.cancelsTurns === true;
        // One shared agent process per preset, serving all DSH sessions on it.
        //
        // Each DSH session gets its own ACP session (session/new, or the journaled
        // one via session/resume or session/load) on the shared connection, so
        // conversation histories stay isolated. When the process dies, the shared
        // agent is revived on next use: a fresh process spawns and all journaled
        // sessions reattach.
        const opened = new Map();
        sessions.set(presetId, opened);
        let sharedAgent;
        const sessionFor = async (sessionId, abort) => {
            let session = opened.get(sessionId);
            if (session === undefined) {
                // Lazily create the shared agent on first session open
                if (sharedAgent === undefined || !sharedAgent.alive) {
                    if (sharedAgent !== undefined) {
                        // Previous agent died; revive it
                        options.onDropped?.({ presetId, sessionId, reason: 'shared agent died — reviving' });
                    }
                    sharedAgent = await factory.openShared(presetId);
                }
                session = await sharedAgent.openSession({
                    dshSessionId: sessionId,
                    cwd: cwdForOpen(options.cwdOfSession?.(sessionId)),
                    ...(preset.model === undefined ? {} : { modelId: preset.model }),
                    ...(preset.mode === undefined ? {} : { modeId: preset.mode }),
                    ...(options.primer === undefined ? {} : { primer: options.primer }),
                    ...(options.replay === undefined ? {} : { replay: options.replay }),
                    ...(stopsTurns && abort !== undefined ? { abort } : {}),
                    dialect,
                    ...(options.resumeOf === undefined ? {} : { resumeOf: options.resumeOf }),
                });
                session.onDead(reason => {
                    // Drop only this session's entry from the cache. The shared agent
                    // may still be alive for other sessions; if it died too, the next
                    // sessionFor call will revive it.
                    if (opened.get(sessionId) === session)
                        opened.delete(sessionId);
                    options.onDropped?.({ presetId, sessionId, reason });
                });
                opened.set(sessionId, session);
            }
            return session;
        };
        table.set(presetId, {
            dialect,
            run: async (decision, turn) => (await sessionFor(turn.sessionId, turn.abort)).run(decision, turn),
            runSteps: async (decision, turn, at) => {
                const session = await sessionFor(turn.sessionId, turn.abort);
                // 会话对象没带 runSteps（自备工厂、旧测试桩）：回落单发 run——一次调用
                // 跑完整个回合，其结束原因就是末段的结束原因。
                return session.runSteps !== undefined
                    ? session.runSteps(decision, turn, at)
                    : (await session.run(decision, turn)).end;
            },
            restart: async () => {
                // Kill the shared agent and drop all cached sessions. The next turn
                // for any session on this preset will spawn a fresh process and
                // reattach via session/resume or session/load (or fall back to text
                // replay).
                if (sharedAgent !== undefined && sharedAgent.alive) {
                    sharedAgent.kill('manual restart');
                }
                opened.clear();
                sharedAgent = undefined;
                options.onDropped?.({ presetId, sessionId: '*', reason: 'manual restart' });
            },
        });
    }
    return table;
}
/** The open conversations per preset, so a teardown can find and drop them. */
export function openSessionsOf(sessions, presetId) {
    return sessions.get(presetId) ?? new Map();
}
