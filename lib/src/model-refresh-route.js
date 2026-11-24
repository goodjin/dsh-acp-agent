/**
 * The host-side entry the settings section's refresh buttons call.
 *
 * One exact POST route: `{ preset: "<presetId>" }` in, the refresh's outcome
 * out. The route itself knows nothing about providers — it dispatches to the
 * refresher the preset row registered (see `model-refresh.ts`), which is the
 * only place the per-preset ledger can be reached from. All answers are
 * HTTP 200 + JSON: the browser folds `ok:false` into a localized failure line,
 * and a 500 would tell it nothing the envelope doesn't.
 *
 * The concurrency lock lives here: one in-flight refresh per preset, and a
 * click that lands while one is running is answered `busy` — a second probe
 * process or upstream request must not start just because the user pressed
 * the button twice.
 *
 * Admission follows the quota routes: `connection.admit` first, rejection
 * status verbatim (401 'unauthorized', otherwise 'forbidden').
 */
import { modelRefresherOf } from "./model-refresh.js";
export const name = 'acp-agent-model-refresh';
/** webServer 挂路由；connection 做准入（admit）。 */
export const inject = ['webServer', 'connection'];
/** exact 路由路径；浏览器侧的刷新按钮按这个常量取数。 */
export const MODEL_REFRESH_ROUTE_PATH = '/acp-agent/models/refresh';
/**
 * 装载入口：挂上这条 exact 路由。
 * @param ctx - 宿主上下文（effect / webServer / connection）。
 * @param deps - 可选注入面；测试换假件。
 */
export function apply(ctx, deps = {}) {
    registerModelRefreshRoute(ctx, deps);
}
/**
 * 注册刷新路由，走 DSH 插件的登记样式：`ctx.effect(() => ctx.webServer.register(...))`。
 *
 * 并发锁在本次注册的闭包里：一次注册一份，重复注册不共享旧账。
 * @param ctx - 宿主上下文（effect / webServer / connection）。
 * @param deps - 可选注入面；测试换假件。
 */
export function registerModelRefreshRoute(ctx, deps = {}) {
    const refresherOf = deps.refresherOf ?? modelRefresherOf;
    const inFlight = new Map();
    ctx.effect(() => ctx.webServer.register({
        kind: 'exact',
        path: MODEL_REFRESH_ROUTE_PATH,
        async handler(req, res) {
            // 拒绝分支照抄官方 /api 的写法：状态码原样，短体固定。
            const admission = ctx.connection.admit(req);
            if ('rejection' in admission) {
                res.writeHead(admission.rejection);
                res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden');
                return;
            }
            if (req.method !== 'POST') {
                res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'POST' });
                res.end('method not allowed');
                return;
            }
            try {
                const body = await readBody(req);
                const preset = typeof body['preset'] === 'string' ? body['preset'].trim() : '';
                if (preset === '') {
                    respondJson(res, { ok: false, error: 'missing provider preset id — send { preset: "<presetId>" }' });
                    return;
                }
                const refresher = refresherOf(preset);
                if (refresher === undefined) {
                    respondJson(res, { ok: false, error: `no ACP provider named ${preset} is mounted` });
                    return;
                }
                const running = inFlight.get(preset);
                if (running !== undefined) {
                    respondJson(res, { ok: false, code: 'busy', error: `a refresh for ${preset} is already running` });
                    return;
                }
                const run = refresher();
                inFlight.set(preset, run);
                let outcome;
                try {
                    outcome = await run;
                }
                catch (error) {
                    outcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
                }
                finally {
                    // Only clear when this run still owns the slot: a re-registered
                    // route (plugin reload) must not be robbed of its entry by a
                    // finishing predecessor.
                    if (inFlight.get(preset) === run)
                        inFlight.delete(preset);
                }
                // codex 的上游清单归 dsh-codex 插件管：如实说明，别越界代管。
                const payload = outcome.ok && outcome.kind === 'reread' && outcome.agent === 'codex'
                    ? { ...outcome, hint: 'codex' }
                    : outcome;
                respondJson(res, payload);
            }
            catch (error) {
                respondJson(res, { ok: false, error: error instanceof Error ? error.message : String(error) });
            }
        },
    }), 'acp-agent-model-refresh: refresh route');
}
/** 读请求体；超过 64 KiB 当作没有（本路由只收一个 preset 字符串）。 */
async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > 64 * 1024)
            return {};
        chunks.push(Buffer.from(chunk));
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (text.trim() === '')
        return {};
    try {
        const parsed = JSON.parse(text);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
            return {};
        return parsed;
    }
    catch {
        return {};
    }
}
/** JSON 应答：no-store（结果归浏览器即时展示，不许任何一环替我们缓存）。 */
function respondJson(res, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body),
    });
    res.end(body);
}
