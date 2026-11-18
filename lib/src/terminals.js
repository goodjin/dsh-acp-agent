/**
 * The client-side half of ACP's terminal sub-protocol.
 *
 * Some agents — grok among them — do not run shell commands themselves. They ask
 * the client to, and then poll for the result. A client that serves the first
 * call but not the rest looks like it half-works: the turn finishes, but the tool
 * result is a complaint that a later call could not be served.
 *
 * The spawn step is injected on purpose. DSH rejected this sub-protocol for its
 * own runtime because routing execution to the client forks it into a second
 * backend and bypasses its env scrub and background-task ownership
 * (`reference/deepseek-harness/.agents/notes/archived/feature/
 * 2026-06-18-acp-terminal-and-tool-rendering.md`). Keeping spawn injectable lets
 * a host run the process its own way while still serving an agent that insists
 * on this shape.
 */
import { spawn } from 'node:child_process';
/**
 * Spawn through a plain shell.
 *
 * The command arrives already assembled (`"/bin/bash -lc '...'"`), so it is run
 * as one line rather than re-parsed into argv — splitting it here would break on
 * the quoting the agent chose.
 */
function spawnInShell(spec) {
    const child = spawn(spec.command, {
        shell: true,
        ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(spec.env === undefined ? {} : { env: spec.env }),
    });
    let buffer = '';
    const collect = (chunk) => { buffer += String(chunk); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    let dataCb;
    const notify = (chunk) => { dataCb?.(String(chunk)); };
    child.stdout.on('data', notify);
    child.stderr.on('data', notify);
    return {
        output: () => buffer,
        exited: new Promise(resolve => {
            child.on('close', code => resolve(code ?? 0));
            // A spawn failure (no such binary) must settle, not hang: an unsettled
            // `exited` is exactly the silent stall this whole layer exists to avoid.
            child.on('error', () => resolve(127));
        }),
        kill: () => { child.kill('SIGTERM'); },
        onData: (cb) => { dataCb = cb; },
    };
}
export class TerminalService {
    terminals = new Map();
    nextId = 1;
    options;
    /** Called whenever a terminal produces new output. */
    onOutput;
    /** Called when a terminal process exits. */
    onExit;
    constructor(options = {}) {
        this.options = options;
    }
    /**
     * Start a command, as `terminal/create` expects.
     *
     * Returns as soon as the terminal exists — it does **not** wait for the
     * process. Blocking here would make a long command look like a hung protocol
     * call, and the exit code is what `wait_for_exit` is for.
     */
    async create(spec) {
        const command = this.options.spawn?.(spec) ?? spawnInShell(spec);
        const terminalId = `term-${this.nextId++}`;
        const entry = { command, active: true };
        // Wire streaming output to the onOutput callback.
        if (command.onData !== undefined && this.onOutput !== undefined) {
            const cb = this.onOutput;
            const id = terminalId;
            command.onData((chunk) => { if (entry.active)
                cb(id, chunk); });
        }
        // Wire process exit to the onExit callback.
        if (this.onExit !== undefined) {
            const cb = this.onExit;
            const id = terminalId;
            void command.exited.then(exitCode => cb({ terminalId: id, exitCode }));
        }
        void command.exited.then(exitCode => { entry.exitStatus = { exitCode, signal: null }; });
        this.terminals.set(terminalId, entry);
        // Only a terminal id. ACP's CreateTerminalResponse names no output field,
        // and an extra one makes a strict decoder reject the whole response.
        return { terminalId };
    }
    /** Block until the command ends, as `terminal/wait_for_exit` expects. */
    async waitForExit(terminalId) {
        const entry = this.require(terminalId);
        const exitCode = await entry.command.exited;
        const status = { exitCode, signal: null };
        entry.exitStatus = status;
        return status;
    }
    /** Everything written so far, as `terminal/output` expects. */
    async output(terminalId) {
        const entry = this.require(terminalId);
        return { output: entry.command.output(), exitStatus: entry.exitStatus ?? null, truncated: false };
    }
    async kill(terminalId) {
        this.require(terminalId).command.kill();
        return {};
    }
    async release(terminalId) {
        const entry = this.terminals.get(terminalId);
        if (entry !== undefined)
            entry.active = false;
        this.terminals.delete(terminalId);
        return {};
    }
    require(terminalId) {
        const entry = this.terminals.get(terminalId);
        // Saying "unknown terminal" beats answering as if it succeeded: the agent
        // can then report the failure instead of waiting on output that never comes.
        if (entry === undefined)
            throw new Error(`unknown terminal ${terminalId}`);
        return entry;
    }
}
