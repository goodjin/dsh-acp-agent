/**
 * The model list the coding-plan gateway itself serves.
 *
 * Measured 2026-11-24 against the default gateway
 * (`open.bigmodel.cn/api/anthropic`, the coding-plan credential): `GET
 * {base}/v1/models` answers HTTP 200 with a camelCase envelope —
 * `{ data: [...], firstId, hasMore, lastId }`, each item
 * `{ id, display_name, type, created_at }` — listing the GLM models the
 * plan can serve today (glm-4.5 … glm-5.4 at the time of the probe).
 *
 * Three measured traps shape the parsing:
 * - **Errors also answer HTTP 200.** A wrong path comes back as
 *   `{ code: 500, msg: "404 NOT_FOUND", success: false }` with a green status
 *   code, so the envelope — not the status — is what tells success.
 * - **The OpenAI-shaped variant does not exist.** Only the anthropic gateway's
 *   own `/v1/models` answers; the URL is built from the coding-plan base.
 * - **Upstream ids are lowercase** where the declared list writes `GLM-5.3`.
 *   Case-only differences are the same model (see `mergeZcodeModels` in the
 *   refresh module); this module only reports what the gateway said.
 *
 * The key lives in memory only and is stripped from every thrown message.
 */
import { resolveApiKey, resolveEndpoint, scrub } from "./glm.js";
import { planBase } from "./provider-config.js";
/**
 * The list address of a coding-plan base: the base plus `/v1/models`.
 * A full messages URL serves the same — the request suffixes come off first.
 * @param base - a coding-plan base or a messages URL.
 * @returns the `…/api/anthropic/v1/models` address.
 */
export function modelsUrl(base) {
    return `${planBase(base)}/v1/models`;
}
/**
 * Read the gateway's answer envelope into model rows.
 * @param body - the parsed JSON answer.
 * @returns the models, in the order the gateway listed them, deduplicated by
 * case-insensitive id. Throws when the shape is the gateway's error envelope
 * or unrecognized — a green status code proves nothing here.
 */
export function parseGlmModels(body) {
    if (!isRecord(body))
        throw new Error('unrecognised GLM models answer — not a JSON object');
    if (body['success'] === false) {
        const message = typeof body['msg'] === 'string' ? body['msg'] : 'the gateway reported an error';
        throw new Error(`GLM models request failed: ${message}`);
    }
    const data = body['data'];
    if (!Array.isArray(data))
        throw new Error('unrecognised GLM models answer — no data list');
    const models = [];
    const seen = new Set();
    for (const item of data) {
        if (!isRecord(item))
            continue;
        const id = item['id'];
        if (typeof id !== 'string' || id.trim() === '')
            continue;
        const key = id.toLowerCase();
        if (seen.has(key))
            continue;
        seen.add(key);
        const displayName = typeof item['display_name'] === 'string' && item['display_name'] !== ''
            ? item['display_name']
            : typeof item['displayName'] === 'string' && item['displayName'] !== ''
                ? item['displayName']
                : id;
        models.push({ id, name: displayName });
    }
    return models;
}
/**
 * Fetch the coding plan's model list once.
 * @param request - the key/endpoint overrides and fetch implementation.
 * @returns the models the gateway serves today. An empty list is an error —
 * the caller must be able to tell "fetched nothing" from "fetched a list" —
 * and refusals and network faults throw with the key scrubbed; caller aborts
 * rethrow as-is.
 */
export async function fetchGlmModels(request) {
    const apiKey = await resolveApiKey(request);
    const url = modelsUrl(resolveEndpoint(request.endpoint));
    const fetchImpl = request.fetchImpl ?? fetch;
    let response;
    try {
        response = await fetchImpl(url, {
            method: 'GET',
            headers: {
                accept: 'application/json',
                'x-api-key': apiKey,
                authorization: `Bearer ${apiKey}`,
            },
            ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
    }
    catch (error) {
        if (isAbort(error) || request.signal?.aborted === true)
            throw error;
        throw new Error(scrub(error instanceof Error ? error.message : String(error), apiKey));
    }
    if (!response.ok) {
        const detail = scrub(await response.text().catch(() => ''), apiKey).slice(0, 500);
        throw new Error(`GLM models request failed (${String(response.status)})${detail === '' ? '' : `: ${detail}`}`);
    }
    let body;
    try {
        body = await response.json();
    }
    catch (error) {
        throw new Error(scrub(`GLM models answer was not JSON: ${error instanceof Error ? error.message : String(error)}`, apiKey));
    }
    const models = parseGlmModels(body);
    if (models.length === 0)
        throw new Error('the GLM gateway listed no models');
    return models;
}
function isAbort(error) {
    return error instanceof Error && error.name === 'AbortError';
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
