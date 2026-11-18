/**
 * One GLM Coding Plan call.
 *
 * The key is the desktop app's coding-plan credential, read from the app's own
 * files and kept in memory only. The request goes to the anthropic messages
 * URL with both `x-api-key` and `Authorization: Bearer`, which is how ZCode's
 * adapter authenticates that gateway. Nothing here writes the key, and a
 * failure message has it stripped before it can reach a log.
 */
import { join } from 'node:path';
import { BIGMODEL_CODING_PLAN_BASE, buildAnthropicBody, messagesUrl } from "./anthropic.js";
import { findApiKey, zcodeDataDir } from "./credential.js";
import { planBase, readPlanProviderKey } from "./provider-config.js";
import { chunksFromEvents, readSseEvents } from "./sse.js";
const CREDENTIALS_ENV = 'ZCODE_ACP_CREDENTIALS_FILE';
const CONFIG_ENV = 'ZCODE_ACP_CONFIG_FILE';
const ENDPOINT_ENV = 'ZCODE_GLM_BASE_URL';
/** Stream one turn. Cancellation rejects the iterator; the loop keeps the text already sent. */
export async function* streamGlm(request) {
    const apiKey = await resolveApiKey(request);
    const url = resolveEndpoint(request.endpoint);
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
                'x-api-key': apiKey,
                authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(body),
            ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
    }
    catch (error) {
        if (isAbort(error) || request.signal?.aborted === true)
            throw error;
        yield transportFailure(error, apiKey);
        return;
    }
    if (!response.ok) {
        const detail = scrub(await response.text().catch(() => ''), apiKey).slice(0, 500);
        // 失败分类（2026-11-17 现场：HTTP 500 裸抛 → 宿主归类 UNKNOWN 零重试）：
        // 5xx/429 是服务端或限流问题，交宿主的有界重试；4xx 是请求本身的问题，
        // 重试不会变好——终局收尾，消息可见。中止在下面统一保持中止语义。
        const code = response.status === 429
            ? 'RATE_LIMIT'
            : response.status >= 500 ? 'SERVER' : 'GLM_REQUEST_REJECTED';
        yield {
            type: 'finish',
            reason: {
                kind: 'error',
                failure: {
                    message: `GLM request failed (${String(response.status)})${detail === '' ? '' : `: ${detail}`}`,
                    code,
                },
            },
        };
        return;
    }
    if (response.body === null) {
        yield {
            type: 'finish',
            reason: { kind: 'error', failure: { message: 'GLM request returned no body', code: 'SERVER' } },
        };
        return;
    }
    try {
        for await (const chunk of chunksFromEvents(readSseEvents(response.body))) {
            yield scrubChunk(chunk, apiKey);
        }
    }
    catch (error) {
        if (isAbort(error) || request.signal?.aborted === true)
            throw error;
        yield transportFailure(error, apiKey);
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
 * in the cause chain, so that is what the message names. The key never reaches
 * it: the message is scrubbed like every other one.
 */
function transportFailure(error, apiKey) {
    return {
        type: 'finish',
        reason: {
            kind: 'error',
            failure: {
                message: scrub(`GLM request failed: ${describeTransportFailure(error)}`, apiKey),
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
/**
 * The coding-plan key of a request's overrides.
 *
 * Two places hold it, and the newer one wins:
 *
 * 1. ZCode's own provider configuration — `…/config.json`, plain text, the
 *    coding-plan provider's `options.apiKey`. That is where the current
 *    desktop app (3.17.2) keeps it.
 * 2. The encrypted credential file — `…/credentials.json`, the entry
 *    `account-provider:coding-plan:…:api-key`. The older app wrote it there;
 *    the current app writes that entry no more.
 *
 * Both are read per call, never cached: the desktop app rewrites them when
 * the user signs in again or switches plans, and a key from before that is a
 * key that no longer works.
 *
 * The key never leaves this function except in memory, and nothing here logs
 * it — the failure message names the files it looked in, never their content.
 */
export async function resolveApiKey(request) {
    if (request.apiKey !== undefined && request.apiKey !== '')
        return request.apiKey;
    const base = planBase(resolveEndpoint(request.endpoint));
    const configFile = request.configFile ?? process.env[CONFIG_ENV] ?? join(zcodeDataDir(), 'config.json');
    const fromConfig = await readPlanProviderKey(configFile, base);
    if (fromConfig !== undefined)
        return fromConfig.key;
    const credentialsFile = request.credentialsFile ?? process.env[CREDENTIALS_ENV] ?? join(zcodeDataDir(), 'credentials.json');
    const legacy = await findApiKey(credentialsFile);
    if (legacy !== undefined)
        return legacy;
    throw new Error(`no coding-plan api key for ${base} — looked in ZCode's provider configuration (${configFile}) and in ZCode's credentials (${credentialsFile}). Sign in to ZCode, or point ${CONFIG_ENV} / ${CREDENTIALS_ENV} at the files that hold it.`);
}
/** The messages URL of a request's endpoint override, or the configured default. */
export function resolveEndpoint(override) {
    const configured = override ?? process.env[ENDPOINT_ENV];
    const base = configured !== undefined && configured.trim() !== ''
        ? configured.trim()
        : BIGMODEL_CODING_PLAN_BASE;
    return base.endsWith('/messages') ? base : messagesUrl(base);
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
/** Drop the key from anything that might be shown. A short or empty secret is left alone. */
export function scrub(text, secret) {
    if (secret.length < 8)
        return text;
    return text.split(secret).join('[redacted]');
}
function isAbort(error) {
    return error instanceof Error && error.name === 'AbortError';
}
