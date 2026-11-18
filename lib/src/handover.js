/**
 * Whether a handover can carry the whole conversation across.
 *
 * Switching agent mid-conversation means the target has to take the history as
 * it stands. If it cannot, the choice is to fail or to quietly carry part of
 * it — and a conversation that starts missing its own earlier turns is worse
 * than one that plainly refuses, because neither the agent nor the user can
 * tell what was lost.
 *
 * So the decision is made before anything moves, and on failure says by how
 * much. Trimming exists, but only when asked for, and only with the amounts
 * stated — a silent truncation is the one outcome this refuses to produce.
 */
/** One raw message's role, or an empty string when it has none. */
function roleOf(message) {
    return typeof message === 'object' && message !== null
        ? String(message.role ?? '')
        : '';
}
/**
 * The `source.kind` a durable message declares, when it has a usable one.
 *
 * Every message the host admits to a session carries a source (session-format
 * validation refuses one without), so this is the boundary between what the
 * human said and what the host injected into the same user role.
 */
export function sourceKindOf(message) {
    const source = typeof message === 'object' && message !== null
        ? message.source
        : undefined;
    if (typeof source !== 'object' || source === null)
        return undefined;
    const kind = source.kind;
    return typeof kind === 'string' && kind !== '' ? kind : undefined;
}
/** Whether this message is something the human typed, not host-injected context. */
export function isHumanInput(message) {
    return roleOf(message) === 'user' && sourceKindOf(message) === 'user';
}
/** Read one content block's text, or nothing when it carries none. */
function textBlockOf(block) {
    if (typeof block === 'string')
        return block;
    const record = (typeof block === 'object' && block !== null ? block : {});
    if (record['type'] !== 'text' || typeof record['text'] !== 'string')
        return '';
    return record['text'];
}
/** Flatten one raw message's content — a string or a block array — to its text. */
function textOfMessage(message) {
    const record = (typeof message === 'object' && message !== null ? message : {});
    const content = record['content'];
    if (typeof content === 'string')
        return content;
    if (!Array.isArray(content))
        return '';
    return content.map(textBlockOf).filter(text => text !== '').join('\n');
}
/**
 * Flatten the conversation a request or a session log carries into handover
 * messages.
 *
 * Only two voices belong to a handover: the human's own words (role user with
 * source kind `user`) and the assistant's replies. System instructions, tool
 * traffic, and injected context ride the user role too — but they are host
 * plumbing, and presenting them to the receiving agent as something the user
 * said would put words in the human's mouth. Anything unshaped reads as empty
 * and is dropped the same way — a handover carries what is actually there,
 * never a guess.
 */
export function messagesOf(raw) {
    if (raw === undefined)
        return [];
    const messages = [];
    for (const message of raw) {
        const text = textOfMessage(message);
        if (text === '')
            continue;
        if (isHumanInput(message))
            messages.push({ role: 'user', text });
        else if (roleOf(message) === 'assistant')
            messages.push({ role: 'assistant', text });
    }
    return messages;
}
/**
 * Assemble the messages into the text that primes a new conversation.
 *
 * The block says plainly what it is and what it is for: the receiving agent is
 * being handed a conversation it did not take part in, and the question that
 * follows is addressed to it. The roles are named in the text, so a model that
 * has never heard of this harness still reads the exchange correctly.
 */
export function assembleHandover(messages) {
    const labelOf = {
        user: '用户',
        assistant: '助手',
    };
    const lines = messages.map(message => `【${labelOf[message.role]}】${message.text}`);
    return [
        `以下是一次会话切换时完整移交的此前对话记录，共 ${String(messages.length)} 条。`
            + '请把这段记录当作已经发生过的上下文，并回答记录之后的问题。',
        '',
        ...lines,
        '',
        '——记录结束——',
    ].join('\n');
}
export function decideHandover(input, options = {}) {
    if (!Number.isFinite(input.historyTokens) || input.historyTokens < 0) {
        return { kind: 'bad-input', reason: 'historyTokens must be a non-negative finite number' };
    }
    const window = input.targetContextWindow;
    if (window !== undefined && (!Number.isFinite(window) || window <= 0)) {
        return { kind: 'bad-input', reason: 'targetContextWindow must be a positive finite number when reported' };
    }
    // An agent that reports no window is not known to be too small; refusing on a
    // missing number would block every target that simply does not advertise one.
    if (window === undefined)
        return { kind: 'ok', keptTokens: input.historyTokens };
    const room = window - input.reservedForOutput;
    if (input.historyTokens <= room)
        return { kind: 'ok', keptTokens: input.historyTokens };
    const shortBy = input.historyTokens - room;
    if (options.trim === true && room > 0) {
        // Keep the newest turns: dropping the old ones leaves the thread coherent,
        // while dropping the newest would discard the exchange just made.
        return { kind: 'trimmed', keptTokens: room, droppedTokens: shortBy, keepsNewest: true };
    }
    return { kind: 'too-long', shortBy, keptTokens: input.historyTokens };
}
