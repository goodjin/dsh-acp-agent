/**
 * Line-oriented transport for ACP agents that speak JSON-RPC over stdio.
 *
 * Kept behind an interface so the client can be tested without a child process;
 * the grok agent needs a WebSocket instead, which is the other side of the same
 * interface.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createConnection, createServer } from 'node:net';
/**
 * One transport's activity record: frame progress and stderr diagnostics,
 * counted separately so a chatty-but-wedged agent is still recognizable as
 * silent (see `lastDiagnosticAt` for why the split exists).
 */
export class ActivityBeacon {
    frameAt;
    diagnosticAt;
    tail = [];
    constructor() {
        const now = Date.now();
        this.frameAt = now;
        this.diagnosticAt = now;
    }
    /** A frame arrived from the agent: progress. */
    frame() {
        this.frameAt = Date.now();
    }
    /** A stderr line arrived: diagnostics, not progress. */
    diagnostic(line) {
        this.diagnosticAt = Date.now();
        this.tail.push(line);
        // Bounded: a chatty agent must not turn a crash into a memory leak.
        if (this.tail.length > 20)
            this.tail.shift();
    }
    lastFrameAt() {
        return this.frameAt;
    }
    lastDiagnosticAt() {
        return this.diagnosticAt;
    }
    stderrTail() {
        return [...this.tail];
    }
}
/**
 * Split a byte stream into lines.
 *
 * ACP stdio is newline-delimited JSON, but one frame can be split across chunks,
 * so this buffers rather than splitting each chunk blindly.
 */
function lineSplitter(onLine) {
    let buffer = '';
    return chunk => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, index).trim();
            buffer = buffer.slice(index + 1);
            if (line.length > 0)
                onLine(line);
        }
    };
}
/** ACP over a child process's stdin/stdout, as codex and claude both speak it. */
export class StdioAcpTransport {
    child;
    /** Frames and stderr lines, counted apart (see ActivityBeacon for why). */
    beacon = new ActivityBeacon();
    handler = () => { };
    death = () => { };
    options;
    constructor(options) {
        this.options = options;
        // Spawned here rather than in a field initializer: with class fields, the
        // initializers run before the constructor assigns `this.options`, so a
        // field initializer would dereference an undefined options.
        this.child = nodeSpawn(this.options.command, [...(this.options.args ?? [])], {
            ...(this.options.cwd === undefined ? {} : { cwd: this.options.cwd }),
            stdio: ['pipe', 'pipe', 'pipe'],
            ...(this.options.env === undefined ? {} : { env: this.options.env }),
        });
        // Typed as possibly-null because spawn's stdio is a union; asking for
        // pipes above is what makes them present.
        const stdout = this.child.stdout;
        const stderr = this.child.stderr;
        const stdin = this.child.stdin;
        if (stdout === null || stderr === null || stdin === null) {
            throw new Error(`acp agent ${this.options.command} did not start with pipes`);
        }
        stdout.setEncoding('utf8');
        stdout.on('data', lineSplitter(line => {
            this.beacon.frame();
            this.handler(line);
        }));
        stderr.setEncoding('utf8');
        stderr.on('data', chunk => {
            for (const line of chunk.split('\n')) {
                const trimmed = line.trim();
                if (trimmed.length === 0)
                    continue;
                this.beacon.diagnostic(trimmed);
                this.options.onDiagnostic?.(trimmed);
            }
        });
        this.child.on('error', error => {
            this.death(`acp agent ${this.options.command} could not run: ${error.message}`);
        });
        this.child.on('exit', (code, signal) => {
            const said = this.beacon.stderrTail().slice(-3).join(' / ');
            this.death(`acp agent ${this.options.command} exited (code=${code ?? 'none'} signal=${signal ?? 'none'})`
                + (said.length === 0 ? '' : `: ${said}`));
        });
    }
    lastFrameAt() {
        return this.beacon.lastFrameAt();
    }
    lastDiagnosticAt() {
        return this.beacon.lastDiagnosticAt();
    }
    stderrTail() {
        return this.beacon.stderrTail();
    }
    onDeath(handler) {
        this.death = handler;
    }
    send(line) {
        this.child.stdin?.write(`${line}\n`);
    }
    onLine(handler) {
        this.handler = handler;
    }
    close() {
        this.child.kill('SIGTERM');
    }
}
/**
 * The URL a `grok agent serve` expects.
 *
 * Grok carries its secret in the query as `server-key` and has **no
 * Authorization header** — neither is visible from the agent's code and both
 * have to be right or the handshake is refused. A bind with no port falls back
 * to grok's default.
 */
export function grokWebSocketUrl(bind, secret) {
    const hostPort = bind.includes(':') ? bind : `${bind}:2419`;
    return `ws://${hostPort}/ws?server-key=${encodeURIComponent(secret)}`;
}
/** ACP over a WebSocket, which is how grok is reached. */
export class WebSocketAcpTransport {
    handler = () => { };
    death = () => { };
    beacon = new ActivityBeacon();
    socket;
    ready = false;
    pending = [];
    constructor(options) {
        this.socket = options.createSocket?.(options.url) ?? openBrowserWebSocket(options.url);
        this.socket.onOpen(() => {
            this.ready = true;
            // Flushed in order: a WebSocket is ordered, so reordering here would be
            // a protocol error the agent would reject with no useful detail.
            for (const line of this.pending)
                this.socket.send(line);
            this.pending.length = 0;
        });
    }
    send(line) {
        // A WebSocket connects asynchronously and throws on a premature send. The
        // first thing a client does is write `initialize` immediately after
        // opening, so without this queue the very first request throws.
        if (this.ready)
            this.socket.send(line);
        else
            this.pending.push(line);
    }
    onLine(handler) {
        this.handler = handler;
        this.socket.onMessage(line => {
            this.beacon.frame();
            this.handler(line);
        });
    }
    onDeath(handler) {
        this.death = handler;
        this.socket.onDeath(reason => this.death(reason));
    }
    lastFrameAt() {
        return this.beacon.lastFrameAt();
    }
    /** A socket carries no stderr channel; the constructor stamp stands. */
    lastDiagnosticAt() {
        return this.beacon.lastDiagnosticAt();
    }
    stderrTail() {
        return [];
    }
    close() {
        this.socket.close();
    }
}
/** Open the platform WebSocket and adapt its events to `SocketLike`. */
function openBrowserWebSocket(url) {
    const socket = new WebSocket(url);
    return {
        send: data => socket.send(data),
        close: () => socket.close(),
        onOpen: handler => { socket.onopen = () => handler(); },
        onMessage: handler => {
            socket.onmessage = event => handler(String(event.data));
        },
        // A refused handshake and a dropped socket both used to arrive here as an
        // empty frame, which parsed to nothing and was dropped in silence: the turn
        // then waited forever on a connection that was already gone.
        onDeath: handler => {
            socket.onerror = () => handler('acp agent connection errored');
            socket.onclose = event => handler(`acp agent connection closed${event.reason === '' ? '' : `: ${event.reason}`}`);
        },
    };
}
/** A 24-byte secret, so the server-key is not guessable from a public build. */
function randomSecret() {
    return randomBytes(24).toString('hex');
}
/** Ask the OS for a free port, then release it for grok to take. */
function pickFreePort() {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            const port = typeof address === 'object' && address !== null ? address.port : 0;
            server.close(() => resolve(port));
        });
    });
}
/**
 * Wait until the serve process is actually accepting connections on `port`.
 *
 * A WebSocket constructed a moment too early gets a refused connect and dies,
 * which from the client's side looks like a grok that went silent — so the port
 * has to be listening before the dial. A TCP connect is the honest signal here;
 * the real protocol handshake still happens afterwards, over the WebSocket.
 */
function waitForPort(bind, port, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
        const attempt = () => {
            const socket = createConnection({ host: bind, port });
            socket.once('connect', () => { socket.destroy(); resolve(); });
            socket.once('error', () => {
                socket.destroy();
                if (Date.now() >= deadline) {
                    reject(new Error(`grok agent serve did not accept a connection on ${bind}:${port} within ${timeoutMs}ms`));
                }
                else {
                    setTimeout(attempt, 100);
                }
            });
        };
        attempt();
    });
}
/**
 * grok reached over a `grok agent serve` this transport starts and owns.
 *
 * Every frame method delegates to the inner WebSocket once it is up; the serve
 * process is the part that is different, so it is spawned here and killed on
 * close. A death of either the process or the socket reaches the session, the
 * same as for a stdio agent.
 */
export class GrokServeTransport {
    child;
    inner;
    /** The serve process's stderr: diagnostics, never frames. */
    beacon;
    handler = () => { };
    death = () => { };
    closed = false;
    constructor(child, inner, beacon) {
        this.child = child;
        this.inner = inner;
        this.beacon = beacon;
        child.on('error', error => this.die(`acp agent grok could not run: ${error.message}`));
        child.on('exit', (code, signal) => this.die(`acp agent grok exited (code=${code ?? 'none'} signal=${signal ?? 'none'})`
            + (this.beacon.stderrTail().length === 0 ? '' : `: ${this.beacon.stderrTail().slice(-3).join(' / ')}`)));
        inner.onDeath(reason => this.die(reason));
    }
    /** Spawn the serve process, wait for it, and dial it. */
    static async create(options) {
        const bind = options.bind ?? '127.0.0.1';
        const port = await (options.pickPort?.() ?? pickFreePort());
        const secret = randomSecret();
        const args = ['agent', 'serve', '--bind', `${bind}:${port}`, '--secret', secret, ...(options.args ?? [])];
        const spawn = options.spawn ?? nodeSpawn;
        const child = spawn(options.command, args, {
            ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
            ...(options.env === undefined ? {} : { env: options.env }),
        });
        const onDiagnostic = options.onDiagnostic;
        // Always read stderr — the beacon keeps the tail even when nobody asked for
        // the live lines, so a stall that ends the turn can still quote them.
        const beacon = new ActivityBeacon();
        if (child.stderr !== null) {
            child.stderr.setEncoding('utf8');
            child.stderr.on('data', chunk => {
                for (const line of chunk.split('\n')) {
                    const trimmed = line.trim();
                    if (trimmed.length === 0)
                        continue;
                    beacon.diagnostic(trimmed);
                    onDiagnostic?.(trimmed);
                }
            });
        }
        await (options.waitUntilReady?.(bind, port) ?? waitForPort(bind, port, options.readyTimeoutMs ?? 30_000));
        const url = grokWebSocketUrl(`${bind}:${port}`, secret);
        const inner = new WebSocketAcpTransport({
            url,
            ...(options.createSocket === undefined ? {} : { createSocket: options.createSocket }),
        });
        return new GrokServeTransport(child, inner, beacon);
    }
    /** A death already reported (our own close) must not reach the session. */
    die(reason) {
        if (this.closed)
            return;
        this.death(reason);
    }
    send(line) {
        this.inner.send(line);
    }
    onLine(handler) {
        this.inner.onLine(handler);
    }
    onDeath(handler) {
        this.death = handler;
    }
    /** Frames ride the inner WebSocket, so its stamp is the truthful one. */
    lastFrameAt() {
        return this.inner.lastFrameAt();
    }
    lastDiagnosticAt() {
        return this.beacon.lastDiagnosticAt();
    }
    stderrTail() {
        return this.beacon.stderrTail();
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        this.inner.close();
        this.child.kill('SIGTERM');
    }
}
