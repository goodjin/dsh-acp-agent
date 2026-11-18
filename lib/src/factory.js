/**
 * Reaching a configured external agent: process or socket, per preset.
 *
 * DSH's own approval service is not reachable from here, so permission
 * answering arrives as a port. Keeping it injected rather than importing the
 * runtime package is deliberate — see the service entry for why.
 */
import { AcpClient, GrokServeTransport, StdioAcpTransport, TerminalService, WebSocketAcpTransport, claudeDialect, codexDialect, cursorDialect, doubaoDialect, grokDialect, qoderDialect, stdioArgsFor as acpStdioArgsFor, stdioEnvFor as acpStdioEnvFor, } from "./index.js";
import { cwdForOpen } from "./registry.js";
import { isModelBackedAgent } from "./model-plugins.js";
import { codexProgressProbe, grokProgressProbe, qoderProgressProbe } from "./agent-progress.js";
import { AcpTurnRunner } from "./runner.js";
import { DELEGATION_ROUTE_PATH, name as DELEGATION_ROUTE_ROW_ID } from "./delegation-route.js";
import { fileURLToPath } from 'node:url';
/**
 * 桥接进程的绝对路径。
 *
 * 它由外部 agent 拉起，工作目录不可知——相对路径会指到一个不存在的文件，
 * MCP 客户端只会报「起不来」。从本包位置解析，装到哪都能找到。
 */
const BRIDGE_SCRIPT_PATH = fileURLToPath(new URL('../bridge/dsh-acp-mcp-bridge.mjs', import.meta.url));
/**
 * 建会话时挂给外部 agent 的 MCP 服务器列表。
 *
 * 挂载条件一损俱损：宿主会话 id、委派服务、令牌、origin 缺任何一样都回
 * 空数组——外部 agent 看到的世界与不挂载时一模一样，而不是拿到一个必然
 * 失败的 delegate 工具。令牌绝不现场生成：回调路由校验的是路由行配置的
 * 那一枚，两处各配各的会让回调永远 401。
 */
function delegationMcpServers(surface, dshSessionId) {
    if (surface === undefined || dshSessionId === undefined)
        return [];
    if (!surface.servicePresent())
        return [];
    const token = surface.token();
    if (token === undefined) {
        // 唯一要说话的降级：服务在场说明这台宿主想要委派，令牌没配是配置错，
        // 静默不挂会让「delegate 怎么不见了」变成无迹可寻的谜。
        process.stderr.write('[acp-agent] 委派服务在场但回调路由行未配置 token，本次会话不挂委派 MCP（要在 profile 里给 '
            + DELEGATION_ROUTE_ROW_ID + ' 行配 token；不生成临时令牌——与路由行不一致的令牌会让回调永远 401）\n');
        return [];
    }
    const origin = surface.origin();
    if (origin === undefined)
        return [];
    return [{
            name: 'dsh-delegation',
            // 桥接是 `node <file>` 形式：command 是宿主自己的 node，args[0] 是桥接脚本。
            command: process.execPath,
            args: [BRIDGE_SCRIPT_PATH],
            env: [
                // 桌面宿主下 process.execPath 是 Electron 二进制，不带这个变量时它会当成
                // 「再起一个 App 实例」而不是当 node 跑，桥接进程起不来、委派整条静默消失。
                // 纯 node 宿主会忽略这个变量，所以一处写法两种宿主都对。
                { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
                { name: 'DSH_DELEGATION_URL', value: `${origin}${DELEGATION_ROUTE_PATH}` },
                // 桥接进程拿宿主会话 id 去回调路由定位父会话（委派服务据此取父 agent）。
                { name: 'DSH_DELEGATION_SESSION', value: dshSessionId },
                { name: 'DSH_DELEGATION_TOKEN', value: token },
            ],
        }];
}
/** Which frame dialect an agent speaks. Unknown agents are not ours. */
const DIALECTS = {
    grok: grokDialect,
    claude: claudeDialect,
    codex: codexDialect,
    cursor: cursorDialect,
    doubao: doubaoDialect,
    qoder: qoderDialect,
};
/**
 * 外部 agent 在回合中途长时间不吐 ACP 帧时，读它自己的日志判断是否还在
 * 干活（2026-10-27 codex 压缩上下文；2026-10-28 qoder 长工具执行——模型
 * 请求期间思考帧照常流，不发帧的是工具在跑的那段；同一天 grok 自动压缩
 * 上下文——它把压缩事件包在方言不收的私有方法里，帧里看不见）。
 * 只给接了这种日志信号的 agent 接这层：codex 读 ~/.codex/logs_2.sqlite，
 * qoder 读 <config>/logs/sessions/.../segments/*.jsonl，grok 读
 * $GROK_HOME/sessions/<项目>/<sessionId>/updates.jsonl。别的 agent 没有
 * 这个库，接上也只会是空操作。
 *
 * 开连接的两条路径（独占与共享）都用这一处选型：共享连接上探针按会话 id
 * 读数，读者各记各的游标，不会互相串。
 */
function progressProbeFor(agent) {
    switch (agent) {
        case 'codex': return codexProgressProbe();
        case 'qoder': return qoderProgressProbe();
        case 'grok': return grokProgressProbe();
        default: return undefined;
    }
}
/**
 * The argv one stdio preset is spawned with.
 *
 * The preset's own `args` wins outright: it names a command line the deployment
 * chose, and half-appending a default to it would produce an invocation nobody
 * asked for. Everything else falls back to what the agent needs to speak ACP at
 * all — see `stdioArgsFor` for why cursor is not simply spawned bare.
 * @param preset - the configured preset about to be spawned.
 * @returns the arguments, empty when the binary is the service itself.
 */
export function stdioArgsFor(preset) {
    return preset.args ?? acpStdioArgsFor(preset.agent);
}
/**
 * A transport whose death reaches every listener, not only the last one.
 *
 * The real transports hold a single death slot: each `onDeath` registration
 * replaces the previous handler. The AcpClient owns that slot the moment it is
 * constructed, so a second listener registered afterwards would silently steal
 * the client's — in-flight turns would then wait forever on a dead connection
 * while only the registry heard about the death. Fanning out from one
 * underlying registration is what keeps both listeners live.
 */
class DeathFanoutTransport {
    inner;
    listeners = new Set();
    wired = false;
    constructor(inner) {
        this.inner = inner;
    }
    send(line) { this.inner.send(line); }
    onLine(handler) { this.inner.onLine(handler); }
    onDeath(handler) {
        this.listeners.add(handler);
        if (this.wired)
            return;
        this.wired = true;
        // Copied before iterating: a listener that registers another one during
        // death must not be half-covered by this loop.
        this.inner.onDeath(reason => {
            for (const listener of [...this.listeners])
                listener(reason);
        });
    }
    close() { this.inner.close(); }
    lastFrameAt() { return this.inner.lastFrameAt(); }
    lastDiagnosticAt() { return this.inner.lastDiagnosticAt(); }
    stderrTail() { return this.inner.stderrTail(); }
}
export function makeSessionFactory(config, deps) {
    return {
        dialectFor: (_presetId, preset) => DIALECTS[preset.agent ?? ''],
        open: async (presetId, options) => {
            const preset = config.presets[presetId];
            if (preset === undefined)
                throw new Error(`acp dispatch: no preset named ${presetId}`);
            // 模型行在 DSH 自己的循环里回答，不是要被拉起的进程。名单只有一处
            // （model-plugins 的那张表）——在第二个地方列一遍，就会有一行漏掉，
            // 漏掉的那行会真的去 spawn 一个空命令，报错还看不懂。
            if (isModelBackedAgent(preset.agent)) {
                throw new Error(`${String(preset.agent)} answers as a model inside the native loop; it is not opened as an ACP session`);
            }
            // Refuse before any child starts. An omitted directory would otherwise
            // inherit this process's directory, which is not the session's workspace.
            const cwd = cwdForOpen(options.cwd);
            // A host launched from the Qoder IDE exports SDK-entrypoint variables
            // that make the CLI refuse to start headless; the helper strips them for
            // that agent and returns undefined (inherit) for the rest.
            const childEnv = acpStdioEnvFor(preset.agent);
            // grok is reached over a `grok agent serve` WebSocket this transport starts
            // and owns (random port + secret, ready-wait, kill on close) — unlike the
            // stdio agents, whose command spawns itself. A preset that names a static
            // url keeps the plain WebSocket path; tests inject their own transport.
            const raw = deps.transport?.(preset) ?? (preset.url !== undefined
                ? new WebSocketAcpTransport({ url: preset.url })
                : preset.agent === 'grok'
                    ? await GrokServeTransport.create({
                        command: preset.command ?? 'grok',
                        cwd,
                    })
                    : new StdioAcpTransport({
                        command: preset.command ?? '',
                        args: stdioArgsFor(preset),
                        cwd,
                        ...(childEnv === undefined ? {} : { env: childEnv }),
                    }));
            // The client and the registry's death watcher both listen; the fanout is
            // what lets them without one stealing the other's slot.
            const transport = new DeathFanoutTransport(raw);
            const dialect = DIALECTS[preset.agent ?? ''] ?? grokDialect;
            const client = new AcpClient(transport, dialect);
            // grok delegates shell execution to the client. Without this the agent
            // waits for a terminal that never appears, and the turn hangs silently.
            const terminalService = new TerminalService();
            client.terminals = terminalService;
            terminalService.onOutput = (terminalId, data) => {
                client.onTerminalOutput?.(terminalId, data);
            };
            terminalService.onExit = (info) => {
                client.onTerminalExit?.(info.terminalId, info.exitCode);
            };
            client.onPermissionRequest = async (request) => await deps.answerPermission(request);
            // Cursor sends two blocking custom methods that stall the turn if left
            // unanswered. Answer them with a benign outcome so the agent proceeds;
            // any other unknown method still falls through to the default error.
            // The ask hook sits in front of that auto-answer when the host can put
            // the question to a human — the client hands the question over and the
            // user's answer returns in cursor's answered envelope. The request names
            // this opener's DSH session when the frame itself does not, because the
            // host resolves the live agent — and with it the conversation the
            // question card belongs to — by session.
            //
            // The documented notification methods (`cursor/update_todos`,
            // `cursor/task`, `cursor/generate_image`) arrive as JSON-RPC REQUESTS on
            // cursor 2026.10.01 (measured 2026-10-21: `cursor/task` carries an id and
            // blocks until answered). They are fire-and-forget by contract, so an
            // empty result acknowledges them without claiming an outcome; one that
            // really is a notification needs no reply and stays unreplied.
            if (preset.agent === 'cursor') {
                if (deps.answerAskQuestion !== undefined) {
                    client.onAskQuestion = async (request) => await deps.answerAskQuestion(request.sessionId === undefined && options.dshSessionId !== undefined
                        ? { ...request, sessionId: options.dshSessionId }
                        : request);
                }
                client.onExtensionRequest = frame => {
                    if (typeof frame.id !== 'number')
                        return false;
                    if (frame.method === 'cursor/ask_question') {
                        client.reply(frame.id, { outcome: { outcome: 'skipped' } });
                        return true;
                    }
                    if (frame.method === 'cursor/create_plan') {
                        client.reply(frame.id, { outcome: { outcome: 'cancelled' } });
                        return true;
                    }
                    if (frame.method === 'cursor/task'
                        || frame.method === 'cursor/update_todos'
                        || frame.method === 'cursor/generate_image') {
                        client.reply(frame.id, {});
                        return true;
                    }
                    return false;
                };
            }
            // The dialect lets the runner write each tool card as its first frame
            // arrives; without it the runner would keep writing everything at turn
            // end. The same dialect reads the reply's model list, which rides to the
            // catalog keyed by the preset that opened.
            const runner = new AcpTurnRunner(adaptClient(client, dialect), {
                ...options,
                cwd,
                dialect,
                mcpServers: delegationMcpServers(deps.delegation, options.dshSessionId),
                // 软接管开关是预设配置字段，网关路径的调用方不传它——在这里从预设读。
                ...(preset.delegationHint === true ? { delegationHint: true } : {}),
                ...(deps.onRuntimeModels === undefined ? {} : { onModels: models => { deps.onRuntimeModels(presetId, models); } }),
                ...(deps.resumeOf === undefined ? {} : { resumeOf: dshSessionId => deps.resumeOf(presetId, dshSessionId) }),
                ...(deps.onExternalSession === undefined ? {} : { onExternalSession: (dshSessionId, externalSessionId) => { deps.onExternalSession(presetId, dshSessionId, externalSessionId); } }),
                ...(deps.subagents === undefined ? {} : { subagents: deps.subagents }),
            });
            // 外部 agent 自己的日志进度信号（选型见 progressProbeFor）。
            const progressProbe = progressProbeFor(preset.agent);
            return {
                run: async (decision, turn) => await runner.run(decision, turn),
                // The segmented path, passed through with its `first` marker untouched:
                // the registry's binding hands it to the dispatch, which iterates one
                // external turn across several step calls.
                runSteps: (decision, turn, at) => runner.runSteps(decision, turn, at),
                // Drops the connection itself, not just the runner's bookkeeping: a
                // runner that forgets its session id would otherwise hand back the
                // same conversation.
                close: () => {
                    progressProbe?.close();
                    client.close();
                },
                onDead: handler => { transport.onDeath(handler); },
                diagnostics: () => {
                    const lastStatus = runner.lastStatusSnapshot();
                    return {
                        lastFrameAt: transport.lastFrameAt(),
                        lastDiagnosticAt: transport.lastDiagnosticAt(),
                        stderrTail: transport.stderrTail(),
                        // 外部 agent 自己的子代理/后台任务还开着几个：网关的总上限据此让路。
                        liveDelegatedRuns: runner.liveDelegatedRuns(),
                        toolDeadline: () => runner.openToolDeadline(),
                        // 最后上报的状态与日志层进度：超时消息的解释与「没帧也算活着」的依据。
                        ...(lastStatus === undefined ? {} : { lastStatus }),
                        ...(progressProbe === undefined ? {} : {
                            progress: () => {
                                const external = runner.externalSessionId();
                                return external === undefined ? undefined : progressProbe.read(external);
                            },
                        }),
                    };
                },
            };
        },
        /**
         * Open a shared agent process: spawn transport, create client, and return
         * a handle that can serve multiple DSH sessions.
         *
         * The ACP handshake (initialize + initialized + optional authenticate) is
         * performed lazily on the first openSession call, so this method returns
         * immediately after spawning the transport.
         */
        openShared: async (presetId) => {
            const preset = config.presets[presetId];
            if (preset === undefined)
                throw new Error(`acp dispatch: no preset named ${presetId}`);
            // 模型行在 DSH 自己的循环里回答，不是要被拉起的进程。名单只有一处
            // （model-plugins 的那张表）——在第二个地方列一遍，就会有一行漏掉，
            // 漏掉的那行会真的去 spawn 一个空命令，报错还看不懂。
            if (isModelBackedAgent(preset.agent)) {
                throw new Error(`${String(preset.agent)} answers as a model inside the native loop; it is not opened as an ACP session`);
            }
            // Spawn transport using a neutral cwd (session-specific cwd is set per session/new)
            const childEnv = acpStdioEnvFor(preset.agent);
            const raw = deps.transport?.(preset) ?? (preset.url !== undefined
                ? new WebSocketAcpTransport({ url: preset.url })
                : preset.agent === 'grok'
                    ? await GrokServeTransport.create({
                        command: preset.command ?? 'grok',
                        cwd: process.cwd(),
                    })
                    : new StdioAcpTransport({
                        command: preset.command ?? '',
                        args: stdioArgsFor(preset),
                        cwd: process.cwd(),
                        ...(childEnv === undefined ? {} : { env: childEnv }),
                    }));
            const transport = new DeathFanoutTransport(raw);
            const dialect = DIALECTS[preset.agent ?? ''] ?? grokDialect;
            const client = new AcpClient(transport, dialect);
            const terminalService = new TerminalService();
            client.terminals = terminalService;
            client.onPermissionRequest = async (request) => await deps.answerPermission(request);
            if (preset.agent === 'cursor') {
                if (deps.answerAskQuestion !== undefined) {
                    client.onAskQuestion = async (request) => await deps.answerAskQuestion(request);
                }
                client.onExtensionRequest = frame => {
                    if (typeof frame.id !== 'number')
                        return false;
                    if (frame.method === 'cursor/ask_question') {
                        client.reply(frame.id, { outcome: { outcome: 'skipped' } });
                        return true;
                    }
                    if (frame.method === 'cursor/create_plan') {
                        client.reply(frame.id, { outcome: { outcome: 'cancelled' } });
                        return true;
                    }
                    if (frame.method === 'cursor/task'
                        || frame.method === 'cursor/update_todos'
                        || frame.method === 'cursor/generate_image') {
                        client.reply(frame.id, {});
                        return true;
                    }
                    return false;
                };
            }
            const routes = new Set();
            const bySession = new Map();
            const replyOwner = new Map();
            /**
             * 尚未被认领的会话帧。子会话的首帧可能先于父会话处理出生帧到达（接管
             * 路径的泵是按段驱动的），先存着，认领时按序补投。每会话有界：一直无人
             * 认领的 id 不能把内存撑大。
             */
            const heldFrames = new Map();
            const HELD_FRAMES_LIMIT = 200;
            const deliver = (route, frame, at, stamp = true) => {
                if (stamp)
                    route.lastFrameAt = at;
                for (const handler of route.deliver) {
                    try {
                        handler(frame);
                    }
                    catch {
                        // 一个观察者出事不能带走这条连接上的其他会话。
                    }
                }
            };
            const claim = (route, sessionId) => {
                if (route.claimed.has(sessionId))
                    return;
                route.claimed.add(sessionId);
                bySession.set(sessionId, route);
                const held = heldFrames.get(sessionId);
                if (held === undefined)
                    return;
                heldFrames.delete(sessionId);
                const at = Date.now();
                for (const frame of held)
                    deliver(route, frame, at);
            };
            const disposeRoute = (route) => {
                routes.delete(route);
                for (const sessionId of route.claimed) {
                    if (bySession.get(sessionId) === route)
                        bySession.delete(sessionId);
                }
                for (const id of route.pending) {
                    if (replyOwner.get(id) === route)
                        replyOwner.delete(id);
                }
                route.claimed.clear();
                route.pending.clear();
                route.deliver.clear();
                route.terminalOutput.clear();
                route.terminalExit.clear();
            };
            // 帧归位：回执给请求者；带会话 id 的给该会话的所有者（没人认领就先存着
            // 等认领——子会话首帧可能先到）；不带会话 id 的通知是全局的，广播。
            client.onFrame(frame => {
                const at = Date.now();
                if (typeof frame.id === 'number' && frame.method === undefined) {
                    const route = replyOwner.get(frame.id);
                    if (route === undefined)
                        return;
                    replyOwner.delete(frame.id);
                    route.pending.delete(frame.id);
                    if (route.openingId === frame.id) {
                        route.openingId = undefined;
                        const sessionId = frame.result?.sessionId;
                        if (typeof sessionId === 'string')
                            claim(route, sessionId);
                    }
                    deliver(route, frame, at);
                    return;
                }
                const params = (frame.params ?? {});
                if (typeof params.sessionId !== 'string') {
                    // 不带会话 id 的通知是全局的（握手、代理自己的信令），广播给每个
                    // 会话，但不点亮它们的进展信标——谁在动，只有带 id 的帧说得清。
                    for (const route of [...routes])
                        deliver(route, frame, at, false);
                    return;
                }
                const owner = bySession.get(params.sessionId);
                if (owner !== undefined) {
                    deliver(owner, frame, at);
                    return;
                }
                const held = heldFrames.get(params.sessionId);
                if (held === undefined)
                    heldFrames.set(params.sessionId, [frame]);
                else {
                    held.push(frame);
                    if (held.length > HELD_FRAMES_LIMIT)
                        held.shift();
                }
            });
            // 终端输出按 terminal/create 上写明的会话归位（配对表在 AcpClient 里）。
            // 代理没写会话、而连接上开着不止一个会话时宁可不投：猜错会把一段命令
            // 输出追加到另一个会话的工具卡上。代理自己的 tool_call_update 仍会把
            // 结果送到，丢的只是实时流。
            const terminalRoutes = (terminalId) => {
                const owner = client.sessionOfTerminal(terminalId);
                if (owner !== undefined) {
                    const route = bySession.get(owner);
                    return route === undefined ? [] : [route];
                }
                return routes.size === 1 ? [...routes] : [];
            };
            terminalService.onOutput = (terminalId, data) => {
                for (const route of terminalRoutes(terminalId)) {
                    for (const handler of route.terminalOutput) {
                        try {
                            handler(terminalId, data);
                        }
                        catch {
                            // 同上：一条输出投递失败不带走其他会话。
                        }
                    }
                }
            };
            terminalService.onExit = ({ terminalId, exitCode }) => {
                for (const route of terminalRoutes(terminalId)) {
                    for (const handler of route.terminalExit) {
                        try {
                            handler(terminalId, exitCode);
                        }
                        catch {
                            // 同上。
                        }
                    }
                }
            };
            // Track per-session death handlers so transport death propagates to all
            const sessionDeathHandlers = new Map();
            // Track per-session runners on this shared agent
            const sessionRunners = new Map();
            /** DSH 会话 → 它在共享连接上的分流表。 */
            const routeByDsh = new Map();
            let alive = true;
            // 日志层的进度信号：一条连接一个探针，按 ACP 会话 id 各读各的游标。
            const progressProbe = progressProbeFor(preset.agent);
            const sharedAgent = {
                get alive() { return alive; },
                openSession: async (opts) => {
                    const route = {
                        claimed: new Set(),
                        deliver: new Set(),
                        terminalOutput: new Set(),
                        terminalExit: new Set(),
                        pending: new Set(),
                        lastFrameAt: Date.now(),
                        openingId: undefined,
                    };
                    routes.add(route);
                    const port = adaptClient(client, dialect, {
                        request: (method, params) => {
                            // session/resume / session/load 的目标 id 发请求时就知道；先认领，
                            // 回执之前到达的帧也不会被当成无人认领。cursor 的 load 回执甚至
                            // 不带 sessionId，事后再认领就没有 id 可用。
                            if (method === 'session/resume' || method === 'session/load') {
                                const target = params?.sessionId;
                                if (typeof target === 'string')
                                    claim(route, target);
                            }
                            const { id, reply } = client.requestWithId(method, params);
                            replyOwner.set(id, route);
                            route.pending.add(id);
                            if (method === 'session/new')
                                route.openingId = id;
                            return reply;
                        },
                        onFrame: handler => { route.deliver.add(handler); },
                        onTerminalOutput: handler => { route.terminalOutput.add(handler); },
                        onTerminalExit: handler => { route.terminalExit.add(handler); },
                        claimSession: sessionId => { claim(route, sessionId); },
                    });
                    const runner = new AcpTurnRunner(port, {
                        cwd: opts.cwd,
                        dshSessionId: opts.dshSessionId,
                        dialect: opts.dialect,
                        mcpServers: delegationMcpServers(deps.delegation, opts.dshSessionId),
                        // 同 open 路径：开关从预设配置读，接管会话与网关会话一个待遇。
                        ...(preset.delegationHint === true ? { delegationHint: true } : {}),
                        ...(opts.modeId === undefined ? {} : { modeId: opts.modeId }),
                        ...(opts.modelId === undefined ? {} : { modelId: opts.modelId }),
                        ...(opts.openTimeoutMs === undefined ? {} : { openTimeoutMs: opts.openTimeoutMs }),
                        ...(opts.primer === undefined ? {} : { primer: opts.primer }),
                        ...(opts.replay === undefined ? {} : { replay: opts.replay }),
                        ...(opts.resumeOf === undefined ? {} : { resumeOf: opts.resumeOf }),
                        ...(deps.onExternalSession === undefined ? {} : { onExternalSession: (dshSessionId, externalSessionId) => { deps.onExternalSession(presetId, dshSessionId, externalSessionId); } }),
                        ...(deps.subagents === undefined ? {} : { subagents: deps.subagents }),
                        ...(deps.onRuntimeModels === undefined ? {} : { onModels: (models) => { deps.onRuntimeModels(presetId, models); } }),
                        ...(opts.stopsTurns && opts.abort !== undefined ? { abort: opts.abort } : {}),
                    });
                    const acpSession = {
                        run: async (decision, turn) => await runner.run(decision, turn),
                        runSteps: (decision, turn, at) => runner.runSteps(decision, turn, at),
                        close: () => {
                            sessionRunners.delete(opts.dshSessionId);
                            sessionDeathHandlers.delete(opts.dshSessionId);
                            routeByDsh.delete(opts.dshSessionId);
                            disposeRoute(route);
                            // When the last session on this shared agent leaves, kill the
                            // transport to avoid leaking a process for an idle preset.
                            if (sessionRunners.size === 0 && alive) {
                                alive = false;
                                progressProbe?.close();
                                transport.close();
                            }
                        },
                        onDead: handler => {
                            sessionDeathHandlers.set(opts.dshSessionId, handler);
                        },
                        diagnostics: () => {
                            const lastStatus = runner.lastStatusSnapshot();
                            return {
                                // 这条会话自己的信标：同一连接上别的会话有帧，不代表这条在动。
                                lastFrameAt: route.lastFrameAt,
                                lastDiagnosticAt: transport.lastDiagnosticAt(),
                                stderrTail: transport.stderrTail(),
                                liveDelegatedRuns: runner.liveDelegatedRuns(),
                                toolDeadline: () => runner.openToolDeadline(),
                                ...(lastStatus === undefined ? {} : { lastStatus }),
                                ...(progressProbe === undefined ? {} : {
                                    progress: () => {
                                        const external = runner.externalSessionId();
                                        return external === undefined ? undefined : progressProbe.read(external);
                                    },
                                }),
                            };
                        },
                    };
                    sessionRunners.set(opts.dshSessionId, acpSession);
                    routeByDsh.set(opts.dshSessionId, route);
                    return acpSession;
                },
                kill: (reason) => {
                    if (!alive)
                        return;
                    alive = false;
                    progressProbe?.close();
                    transport.close();
                    for (const route of [...routes])
                        disposeRoute(route);
                    for (const handler of sessionDeathHandlers.values())
                        handler(reason);
                    sessionDeathHandlers.clear();
                    sessionRunners.clear();
                    routeByDsh.clear();
                },
                dropSession: (dshSessionId) => {
                    sessionRunners.delete(dshSessionId);
                    sessionDeathHandlers.delete(dshSessionId);
                    const route = routeByDsh.get(dshSessionId);
                    if (route !== undefined) {
                        routeByDsh.delete(dshSessionId);
                        disposeRoute(route);
                    }
                },
                sessionIds: () => Array.from(sessionRunners.keys()),
            };
            // Watch for transport death — propagate to all sessions with the actual reason
            transport.onDeath(reason => {
                if (!alive)
                    return;
                alive = false;
                progressProbe?.close();
                for (const route of [...routes])
                    disposeRoute(route);
                for (const handler of sessionDeathHandlers.values())
                    handler(reason);
                sessionDeathHandlers.clear();
                sessionRunners.clear();
                routeByDsh.clear();
            });
            return sharedAgent;
        },
    };
}
/**
 * Present the ACP client as the incremental frame port the runner expects.
 *
 * The runner installs one handler at construction; every inbound frame then
 * reaches it as it lands, which is what lets text reach the UI while the agent
 * is still working.
 */
export function adaptClient(client, dialect, overrides) {
    const request = overrides?.request ?? ((method, params) => client.request(method, params));
    return {
        request,
        notify: (method, params) => { client.notify(method, params); },
        onFrame: overrides?.onFrame ?? (handler => { client.onFrame(frame => { handler(frame); }); }),
        onTerminalOutput: overrides?.onTerminalOutput ?? (handler => { client.onTerminalOutput = handler; }),
        onTerminalExit: overrides?.onTerminalExit ?? (handler => { client.onTerminalExit = handler; }),
        ...(overrides?.claimSession === undefined ? {} : { claimSession: overrides.claimSession }),
        // Cursor must authenticate (after an interactive `agent login`) before
        // session/new; qoder derives its own method id (CN and international builds
        // differ) from the initialize reply and authenticates only when
        // session/new refuses. The runner owns WHEN; this owns WHAT to send.
        ...(dialect.authenticateMethodId === undefined && dialect.authenticateMethodIdFrom === undefined
            ? {}
            : {
                authenticate: (initializeResult) => {
                    const methodId = dialect.authenticateMethodId ?? dialect.authenticateMethodIdFrom?.(initializeResult);
                    return methodId === undefined
                        ? Promise.resolve(undefined)
                        : request('authenticate', { methodId });
                },
            }),
    };
}
