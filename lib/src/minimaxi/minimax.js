/**
 * One turn against MiniMax's managed gateway.
 *
 * The credential comes from the local MiniMax Code login and stays in memory;
 * nothing here writes it, and every failure message is scrubbed before it can
 * reach a log. Reading files, running commands, approval, cancellation and the
 * session transcript stay with DSH's own loop — this only answers the model
 * request, exactly as the GLM plugin does.
 */
import { buildAnthropicBody } from "./anthropic.js";
import { isMiniMaxLoginRequired, messagesUrl } from "./credential.js";
import { resolveCredential } from "./credential.js";
import { loginUrlHint } from "./login.js";
import { chunksFromEvents, readSseEvents } from "./sse.js";
/** Stream one turn. Cancellation rejects the iterator; the text already sent stays. */
export async function* streamMiniMax(request) {
    let credential;
    try {
        credential = request.credential ?? await resolveCredential(request.credentialOverrides ?? {});
    }
    catch (error) {
        // 登录不可用（没登录 / 过期且刷新被拒）时，光说「失败」帮不上忙：
        // 这条消息会落进会话，把授权地址一起带出去，用户点开就能重新登录。
        if (!isMiniMaxLoginRequired(error))
            throw error;
        const hint = loginUrlHint(error.region ?? 'cn', error.buildEnv ?? 'prod');
        throw new Error(`${error.message}${hint === undefined ? '' : ` 授权地址：${hint}`}`);
    }
    const url = messagesUrl(credential.baseUrl);
    const body = buildAnthropicBody(request);
    const fetchImpl = request.fetchImpl ?? fetch;
    let response;
    try {
        response = await fetchImpl(url, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                accept: 'text/event-stream',
                'anthropic-version': '2023-06-01',
                authorization: `Bearer ${credential.accessToken}`,
            },
            body: JSON.stringify(body),
            ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
    }
    catch (error) {
        if (isAbort(error) || request.signal?.aborted === true)
            throw error;
        yield transportFailure(error, credential.accessToken);
        return;
    }
    if (!response.ok) {
        const detail = scrub(await response.text().catch(() => ''), credential.accessToken).slice(0, 500);
        const unauthorized = response.status === 401 || response.status === 403;
        const hint = unauthorized ? loginUrlHint(credential.region, credential.buildEnv) : undefined;
        throw new Error(`MiniMax request failed (${String(response.status)})${detail === '' ? '' : `: ${detail}`}`
            + (unauthorized
                ? ' — the local MiniMax Code login was rejected; open MiniMax Code and log in again'
                    + (hint === undefined ? '' : `, or use the authorization link: ${hint}`)
                : ''));
    }
    if (response.body === null)
        throw new Error('MiniMax request returned no body');
    try {
        for await (const chunk of chunksFromEvents(readSseEvents(response.body))) {
            yield scrubChunk(chunk, credential.accessToken);
        }
    }
    catch (error) {
        if (isAbort(error) || request.signal?.aborted === true)
            throw error;
        yield transportFailure(error, credential.accessToken);
        return;
    }
}
/**
 * The failure code the host retries on its own.
 *
 * A connection that dies is not a wrong answer, it is a moment lost: the host
 * retries TRANSPORT failures itself, so a proxy hiccup costs a second instead
 * of the turn. Any other code ends the turn outright.
 */
const TRANSPORT_CODE = 'TRANSPORT';
/**
 * The terminal chunk for a network failure.
 *
 * Undici names these only "fetch failed"; the reason that matters — the proxy
 * that went away, the refused connection, the name that did not resolve — sits
 * in the cause chain, so that is what the message names. The token never
 * reaches it: the message is scrubbed like every other one.
 */
function transportFailure(error, secret) {
    return {
        type: 'finish',
        reason: {
            kind: 'error',
            failure: {
                message: scrub(`MiniMax request failed: ${describeTransportFailure(error)}`, secret),
                code: TRANSPORT_CODE,
            },
        },
    };
}
/** The one-line reason for a network failure: the deepest cause that says why. */
function describeTransportFailure(error) {
    const base = error instanceof Error ? error.message : String(error);
    let detail = '';
    let current = error?.cause;
    for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
        const message = current instanceof Error
            ? current.message
            : typeof current === 'string' ? current : '';
        if (message !== '' && message !== base)
            detail = message;
        current = current.cause;
    }
    return detail === '' ? base : detail;
}
/** Drop the token from anything that might be shown. A short or empty secret is left alone. */
export function scrub(text, secret) {
    if (secret.length < 8)
        return text;
    return text.split(secret).join('[redacted]');
}
function scrubChunk(chunk, secret) {
    if (chunk.type !== 'finish' || chunk.reason.kind !== 'error')
        return chunk;
    return {
        type: 'finish',
        reason: {
            kind: 'error',
            failure: { message: scrub(chunk.reason.failure.message, secret), code: chunk.reason.failure.code },
        },
    };
}
function isAbort(error) {
    return error instanceof Error && error.name === 'AbortError';
}
