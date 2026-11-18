/**
 * What every mounted row of this plugin shares, in one place.
 *
 * A switch is a cross-row act: a session on the grok row picks a codex model,
 * and the session it continues in is driven by the codex row. The two halves
 * meet here, because rows cannot see each other's composition — a row is
 * mounted inside its own preset's scope, and the registry's leak audit rightly
 * forbids a row from providing services the others could read.
 *
 * Two facts make a process-global module the honest shape rather than a hack:
 * each DSH process hosts exactly one machine's preset registry (design doc
 * §2.7c — one preset registry per process, isolated across hosts by nature),
 * and every row of this plugin in the process imports one module instance.
 * A host restart clears both tables, which is correct: nothing links the old
 * process's handovers to the new one, and the presets remount from config.
 */
/** How many characters of one tool result travel; the rest is cut. */
const TOOL_RESULT_LIMIT = 500;
/** One content block's text, or nothing when it carries none. */
function blockTextOf(block) {
    if (typeof block === 'string')
        return block;
    const record = (typeof block === 'object' && block !== null ? block : {});
    return record['type'] === 'text' && typeof record['text'] === 'string' ? record['text'] : '';
}
/** Flatten one log message's content — a string or a block array — to its text. */
function messageTextOf(message) {
    const record = (typeof message === 'object' && message !== null ? message : {});
    if (typeof record.content === 'string')
        return record.content;
    if (!Array.isArray(record.content))
        return '';
    return record.content.map(blockTextOf).filter(text => text !== '').join('\n');
}
/** Read one logged event into a replay line, or nothing when it carries none. */
function replayLineOf(event) {
    if (typeof event !== 'object' || event === null)
        return undefined;
    const record = event;
    const data = (typeof record.data === 'object' && record.data !== null ? record.data : {});
    switch (record.type) {
        case 'user/message': {
            const text = messageTextOf(record.data);
            return text === '' ? undefined : { kind: 'user', text };
        }
        case 'assistant/message': {
            const text = messageTextOf(data.message);
            return text === '' ? undefined : { kind: 'assistant', text };
        }
        case 'tool/call':
            return typeof data.name === 'string' && data.name !== '' ? { kind: 'tool', text: data.name } : undefined;
        case 'tool/result': {
            const text = messageTextOf(data.message);
            if (text === '')
                return undefined;
            return { kind: 'result', text: text.length > TOOL_RESULT_LIMIT ? `${text.slice(0, TOOL_RESULT_LIMIT)}…` : text };
        }
        default:
            return undefined;
    }
}
/** The label each replay line carries, named so a model reads the exchange. */
const LABEL_OF = {
    user: '【用户】',
    assistant: '【助手】',
    tool: '【工具】',
    result: '【工具结果】',
};
/**
 * Render the transcript into the replay text.
 *
 * Every finished turn travels whole — only a single tool result is cut, at
 * `TOOL_RESULT_LIMIT`. The trailing user messages are dropped: the dispatch
 * writes the opening turn's question to the log before its step runs, so those
 * trailing messages are the question the prompt itself carries, and keeping
 * them here would read the same words to the agent twice.
 */
function renderReplay(events) {
    const lines = [];
    for (const event of events) {
        const line = replayLineOf(event);
        if (line !== undefined)
            lines.push(line);
    }
    let end = lines.length;
    while (end > 0 && lines[end - 1].kind === 'user')
        end -= 1;
    const kept = lines.slice(0, end);
    if (kept.length === 0)
        return undefined;
    return kept.map(line => `${LABEL_OF[line.kind]}${line.text}`).join('\n');
}
/**
 * The transcript events of one host session, read structurally.
 *
 * A live session exposes a snapshot read; a query lease exposes the events
 * array directly. Whatever shape answers, an unreadable one is absence — the
 * caller replays nothing rather than failing the turn.
 */
function sessionEvents(session) {
    const record = session;
    for (const read of [record.snapshotEvents, record.ownEvents]) {
        if (typeof read !== 'function')
            continue;
        try {
            const events = read.call(session);
            if (Array.isArray(events))
                return events;
        }
        catch {
            // Fall through to the next reader; absence is handled below.
        }
    }
    return Array.isArray(record.events) ? record.events : undefined;
}
export function makeSwitchShared(reads = {}) {
    const presets = new Map();
    const primed = new Map();
    const switched = new Map();
    let sessionById = reads.sessionById;
    return {
        registerPreset(presetId, preset, models) {
            presets.set(presetId, { preset, models });
        },
        config() {
            const entries = {};
            for (const [presetId, mounted] of presets)
                entries[presetId] = mounted.preset;
            return { presets: entries };
        },
        modelsOf(presetId) {
            return presets.get(presetId)?.models ?? [];
        },
        contextWindowOf(presetId, modelId) {
            const found = presets.get(presetId)?.models.find(model => model.id === modelId);
            const window = found?.contextWindow;
            return typeof window === 'number' && Number.isFinite(window) && window > 0 ? window : undefined;
        },
        sessionExists(sessionId) {
            if (sessionById === undefined)
                return true;
            return sessionById(sessionId) !== undefined;
        },
        wireSessions(reader) {
            sessionById = reader;
        },
        primeHandover(sessionId, text) {
            primed.set(sessionId, text);
        },
        takeHandover(sessionId) {
            const text = primed.get(sessionId);
            if (text !== undefined)
                primed.delete(sessionId);
            return text;
        },
        restoreHandover(sessionId, text) {
            primed.set(sessionId, text);
        },
        replayPrimer(sessionId) {
            let session;
            try {
                session = sessionById?.(sessionId);
            }
            catch {
                // An unreadable session replays nothing; the first request stays the
                // question alone rather than failing the turn over a display read.
                return undefined;
            }
            if (session === undefined || session === null)
                return undefined;
            const events = sessionEvents(session);
            if (events === undefined)
                return undefined;
            return renderReplay(events);
        },
        recordSwitch(sourceSessionId, record) {
            switched.set(sourceSessionId, record);
        },
        switchFor(sourceSessionId) {
            const record = switched.get(sourceSessionId);
            if (record === undefined)
                return undefined;
            // A switch whose new session is gone (deleted, or the host restarted and
            // forgot it) no longer points anywhere: fall through and let the switch
            // be made again rather than naming a session that is not there.
            if (!this.sessionExists(record.sessionId))
                return undefined;
            return record;
        },
    };
}
/**
 * The process-wide fabric every mounted row shares.
 *
 * Session liveness reads through the host's own session service when one is
 * injected (the entry wires it); standalone tests register without it, where
 * "still exists" means "not proven gone".
 */
export const switchShared = makeSwitchShared();
