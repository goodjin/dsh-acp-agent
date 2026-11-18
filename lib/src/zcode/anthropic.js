/**
 * The GLM Coding Plan request, shaped the way ZCode's model adapter sends it.
 *
 * Coding plan is `anthropic-messages`. The public templates put BigModel at
 * `https://open.bigmodel.cn/api/anthropic` and Z.ai at `https://api.z.ai/api/anthropic`;
 * the adapter appends `/v1` because the messages call is `{base}/v1/messages`.
 * Reasoning follows the builtin anthropic rule: `none` disables thinking, and
 * every other level is adaptive with `output_config.effort` of low, high, or max.
 *
 * The signature that has to round-trip is the thinking-block signature the
 * model already returned. Replaying a thinking block without it makes the next
 * turn fail. The public tree's request-security transport is a no-op, so there
 * is no extra request signature to attach here.
 */
export const BIGMODEL_CODING_PLAN_BASE = 'https://open.bigmodel.cn/api/anthropic';
export const ZAI_CODING_PLAN_BASE = 'https://api.z.ai/api/anthropic';
/** Output cap the builtin coding-plan map uses when the caller does not set one. */
export const DEFAULT_MAX_TOKENS = 32_000;
/** `{base}/v1/messages`, appending `/v1` only when the base does not already end in it. */
export function messagesUrl(base) {
    const trimmed = base.trim().replace(/\/+$/u, '');
    let withV1 = trimmed;
    try {
        const url = new URL(trimmed);
        const pathname = url.pathname.replace(/\/+$/u, '');
        url.pathname = pathname.toLowerCase().endsWith('/v1') ? pathname : `${pathname}/v1`;
        url.search = '';
        url.hash = '';
        withV1 = url.href.replace(/\/+$/u, '');
    }
    catch {
        withV1 = trimmed.toLowerCase().endsWith('/v1') ? trimmed : `${trimmed}/v1`;
    }
    return `${withV1}/messages`;
}
/** Map a DSH reasoning effort onto the anthropic thinking fields GLM expects. */
export function reasoningFields(effort) {
    const level = (effort ?? 'high').trim().toLowerCase();
    if (level === 'none' || level === 'disabled' || level === 'off') {
        return { thinking: { type: 'disabled' } };
    }
    const mapped = level === 'minimal' || level === 'low'
        ? 'low'
        : level === 'max' || level === 'xhigh'
            ? 'max'
            : 'high';
    return { thinking: { type: 'adaptive' }, output_config: { effort: mapped } };
}
/** The JSON body for one messages call. */
export function buildAnthropicBody(input) {
    const systemParts = [];
    if (input.system !== undefined && input.system.trim() !== '')
        systemParts.push(input.system);
    const messages = projectMessages(input.messages, systemParts);
    const tools = input.tools === undefined ? undefined : input.tools.map(toolSchema);
    const reasoning = reasoningFields(input.reasoningEffort);
    const maxTokens = typeof input.maxTokens === 'number' && input.maxTokens > 0
        ? Math.floor(input.maxTokens)
        : DEFAULT_MAX_TOKENS;
    return {
        model: input.model,
        max_tokens: maxTokens,
        stream: true,
        messages,
        ...reasoning,
        ...(systemParts.length === 0 ? {} : { system: systemParts.join('\n\n') }),
        ...(tools === undefined || tools.length === 0 ? {} : { tools }),
    };
}
function toolSchema(tool) {
    const parameters = isRecord(tool.parameters) ? { ...tool.parameters } : {};
    if (typeof parameters['type'] !== 'string')
        parameters['type'] = 'object';
    return {
        name: tool.name,
        description: tool.description ?? tool.name,
        input_schema: parameters,
    };
}
function projectMessages(messages, systemParts) {
    const turns = [];
    const push = (role, content) => {
        if (content.length === 0)
            return;
        const last = turns[turns.length - 1];
        if (last !== undefined && last.role === role) {
            last.content.push(...content);
            return;
        }
        turns.push({ role, content: [...content] });
    };
    for (const message of messages) {
        if (!isRecord(message))
            continue;
        const role = message['role'];
        if (role === 'system' || role === 'developer') {
            const text = textOf(message['content']).join('\n');
            if (text !== '')
                systemParts.push(text);
            continue;
        }
        if (role === 'user') {
            push('user', userContent(message['content']));
            continue;
        }
        if (role === 'assistant') {
            push('assistant', assistantContent(message));
            continue;
        }
        if (role === 'tool') {
            push('user', [toolResult(message)]);
        }
    }
    if (turns.length === 0 || turns[0]?.role === 'assistant') {
        turns.unshift({ role: 'user', content: [{ type: 'text', text: '.' }] });
    }
    return turns;
}
function assistantContent(message) {
    const blocks = Array.isArray(message['content']) ? message['content'] : [];
    const replay = replayBlocks(message);
    const content = [];
    for (let index = 0; index < blocks.length; index += 1) {
        const block = blocks[index];
        if (!isRecord(block))
            continue;
        const meta = replayEntry(replay, index);
        if (block['type'] === 'text' && typeof block['text'] === 'string' && block['text'] !== '') {
            content.push({ type: 'text', text: block['text'] });
            continue;
        }
        if (block['type'] === 'reasoning') {
            if (typeof meta['redactedData'] === 'string') {
                content.push({ type: 'redacted_thinking', data: meta['redactedData'] });
                continue;
            }
            content.push({
                type: 'thinking',
                thinking: typeof block['text'] === 'string' ? block['text'] : '',
                signature: typeof meta['signature'] === 'string' ? meta['signature'] : '',
            });
            continue;
        }
        if (block['type'] === 'tool-call') {
            content.push({
                type: 'tool_use',
                id: typeof block['id'] === 'string' && block['id'] !== '' ? block['id'] : `call-${String(index)}`,
                name: typeof block['name'] === 'string' && block['name'] !== '' ? block['name'] : 'tool',
                input: parseInput(block['arguments']),
            });
        }
    }
    return content;
}
function userContent(content) {
    const blocks = Array.isArray(content) ? content : [];
    const projected = [];
    for (const block of blocks) {
        if (!isRecord(block))
            continue;
        if (block['type'] === 'text' && typeof block['text'] === 'string' && block['text'] !== '') {
            projected.push({ type: 'text', text: block['text'] });
            continue;
        }
        if (block['type'] === 'image')
            projected.push({ type: 'text', text: '[image attached]' });
        if (block['type'] === 'file')
            projected.push({ type: 'text', text: '[file attached]' });
    }
    return projected;
}
function toolResult(message) {
    const source = isRecord(message['source']) ? message['source'] : undefined;
    const fromSource = source?.['callId'];
    const id = typeof message['toolCallId'] === 'string' && message['toolCallId'] !== ''
        ? message['toolCallId']
        : typeof fromSource === 'string' && fromSource !== ''
            ? fromSource
            : 'call';
    const text = textOf(message['content']).join('\n');
    return {
        type: 'tool_result',
        tool_use_id: id,
        content: text,
        ...(message['isError'] === true ? { is_error: true } : {}),
    };
}
function textOf(content) {
    if (!Array.isArray(content))
        return [];
    const texts = [];
    for (const block of content) {
        if (isRecord(block) && block['type'] === 'text' && typeof block['text'] === 'string' && block['text'] !== '') {
            texts.push(block['text']);
        }
    }
    return texts;
}
function replayBlocks(message) {
    const source = message['source'];
    if (!isRecord(source))
        return undefined;
    const replay = source['replayState'];
    if (!isRecord(replay) || !Array.isArray(replay['blocks']))
        return undefined;
    return replay['blocks'];
}
function replayEntry(blocks, index) {
    const entry = blocks?.[index];
    return isRecord(entry) ? entry : {};
}
function parseInput(value) {
    if (typeof value === 'string') {
        if (value.trim() === '')
            return {};
        try {
            return JSON.parse(value);
        }
        catch {
            return { raw: value };
        }
    }
    if (isRecord(value) || Array.isArray(value))
        return value;
    return {};
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
