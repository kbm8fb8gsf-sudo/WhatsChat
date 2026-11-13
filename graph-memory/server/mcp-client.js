// @ts-check
/**
 * A small Model Context Protocol client for graphify's MCP server
 * (`python -m graphify.serve`), speaking JSON-RPC 2.0 over the child's stdin/stdout,
 * one JSON message per line.
 *
 * One long-lived server answers every memory: graphify's tools take a `project_path`
 * argument and keep a warm, auto-reloading copy of each project's graph.json. The process
 * is started on first use and restarted on the next call if it dies.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { errorMessage, silentLogger } from './util.js';

export const MCP_PROTOCOL_VERSION = '2025-06-18';
const MAX_LINE = 16 * 1024 * 1024;

/**
 * @typedef {object} ToolResult
 * @property {{ type: string, text?: string }[]} content
 * @property {boolean} [isError]
 */

/**
 * @typedef {object} McpClientOptions
 * @property {string} command
 * @property {string[]} args
 * @property {string} [cwd]
 * @property {NodeJS.ProcessEnv} [env]
 * @property {import('./util.js').Logger} [logger]
 * @property {number} [startTimeoutMs]
 * @property {number} [restartDelayMs]  minimum time between two starts after a crash
 * @property {typeof nodeSpawn} [spawn]
 * @property {() => number} [now]
 */

export class McpClient {
    /** @param {McpClientOptions} options */
    constructor(options) {
        this.options = options;
        this.logger = options.logger ?? silentLogger;
        this.spawn = options.spawn ?? nodeSpawn;
        this.now = options.now ?? Date.now;
        /** @type {import('node:child_process').ChildProcess | null} */
        this.child = null;
        /** @type {Promise<void> | null} */
        this.ready = null;
        this.nextId = 1;
        /** @type {Map<number, { resolve: (v: any) => void, reject: (e: Error) => void, timer: NodeJS.Timeout }>} */
        this.pending = new Map();
        this.buffer = '';
        /** @type {number | null} */
        this.lastStart = null;
        this.stderrTail = '';
        /** @type {{ name?: string, version?: string } | null} */
        this.serverInfo = null;
        this.closed = false;
    }

    get running() {
        return this.child !== null;
    }

    /** Starts the server if needed and completes the MCP handshake. */
    async start() {
        if (this.closed) throw new Error('MCP client is closed');
        if (this.ready) return this.ready;
        const wait = this.lastStart === null ? 0 : this.lastStart + (this.options.restartDelayMs ?? 5000) - this.now();
        if (wait > 0) {
            throw new Error(`graphify's MCP server stopped; retrying in ${Math.ceil(wait / 1000)} s. ${this.stderrTail}`.trim());
        }
        this.lastStart = this.now();
        this.ready = this.launch().catch((err) => {
            this.kill();
            throw err;
        });
        return this.ready;
    }

    async launch() {
        const { command, args, cwd, env } = this.options;
        const child = this.spawn(command, args, {
            cwd,
            env: { ...process.env, ...env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });
        this.child = child;
        this.buffer = '';
        this.stderrTail = '';
        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        child.stdout?.on('data', (chunk) => {
            if (this.child === child) this.onData(String(chunk));
        });
        child.stderr?.on('data', (chunk) => {
            if (this.child === child) this.stderrTail = (this.stderrTail + String(chunk)).slice(-2000);
        });
        child.on('error', (err) => this.onExit(child, `could not start: ${errorMessage(err)}`));
        child.on('exit', (code, signal) => this.onExit(child, `exited (${signal ?? code})`));
        child.stdin?.on('error', () => {});

        const result = await this.request('initialize', {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'sillytavern-graph-memory', version: '0.1.0' },
        }, this.options.startTimeoutMs ?? 30_000);
        this.serverInfo = result?.serverInfo ?? null;
        this.notify('notifications/initialized', {});
        this.logger.info(`Connected to graphify's MCP server ${this.serverInfo?.version ?? ''}`.trim());
    }

    /** @param {string} chunk */
    onData(chunk) {
        this.buffer += chunk;
        if (this.buffer.length > MAX_LINE && !this.buffer.includes('\n')) {
            this.logger.warn('Dropping an oversized message from graphify.');
            this.buffer = '';
            return;
        }
        let nl;
        while ((nl = this.buffer.indexOf('\n')) >= 0) {
            const line = this.buffer.slice(0, nl).trim();
            this.buffer = this.buffer.slice(nl + 1);
            if (line) this.onLine(line);
        }
    }

    /** @param {string} line */
    onLine(line) {
        let msg;
        try {
            msg = JSON.parse(line);
        } catch {
            return; // not protocol traffic (a stray print); ignore it
        }
        if (!msg || typeof msg !== 'object') return;
        if ('method' in msg) {
            // A request from the server (e.g. ping). Answer so it never waits on us.
            if ('id' in msg) {
                if (msg.method === 'ping') this.send({ jsonrpc: '2.0', id: msg.id, result: {} });
                else this.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
            }
            return;
        }
        const entry = typeof msg.id === 'number' ? this.pending.get(msg.id) : undefined;
        if (!entry) return;
        this.pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.error) entry.reject(new Error(`graphify: ${msg.error.message ?? 'error'}`));
        else entry.resolve(msg.result);
    }

    /**
     * @param {import('node:child_process').ChildProcess} child
     * @param {string} reason
     */
    onExit(child, reason) {
        if (this.child !== child) return; // an older process we already replaced
        this.child = null;
        this.ready = null;
        const detail = this.stderrTail.trim().split('\n').slice(-3).join(' ');
        const err = new Error(`graphify's MCP server ${reason}${detail ? `: ${detail}` : ''}`);
        if (!this.closed) this.logger.warn(err.message);
        for (const [, entry] of this.pending) {
            clearTimeout(entry.timer);
            entry.reject(err);
        }
        this.pending.clear();
    }

    /** @param {object} msg */
    send(msg) {
        this.child?.stdin?.write(JSON.stringify(msg) + '\n');
    }

    /**
     * @param {string} method
     * @param {object} params
     */
    notify(method, params) {
        this.send({ jsonrpc: '2.0', method, params });
    }

    /**
     * @param {string} method
     * @param {object} params
     * @param {number} timeoutMs
     * @returns {Promise<any>}
     */
    request(method, params, timeoutMs) {
        if (!this.child) return Promise.reject(new Error("graphify's MCP server is not running"));
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`graphify did not answer ${method} within ${Math.round(timeoutMs / 1000)} s`));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            this.send({ jsonrpc: '2.0', id, method, params });
        });
    }

    /**
     * @param {string} name
     * @param {Record<string, unknown>} args
     * @param {number} [timeoutMs]
     * @returns {Promise<ToolResult>}
     */
    async callTool(name, args, timeoutMs = 10_000) {
        await this.start();
        return this.request('tools/call', { name, arguments: args }, timeoutMs);
    }

    kill() {
        const child = this.child;
        this.child = null;
        this.ready = null;
        for (const [, entry] of this.pending) {
            clearTimeout(entry.timer);
            entry.reject(new Error("graphify's MCP server was stopped"));
        }
        this.pending.clear();
        if (child && child.exitCode === null) {
            try {
                child.stdin?.end();
                child.kill();
            } catch {
                // already gone
            }
        }
    }

    close() {
        this.closed = true;
        for (const [, entry] of this.pending) {
            clearTimeout(entry.timer);
            entry.reject(new Error('closed'));
        }
        this.pending.clear();
        this.kill();
    }
}

/**
 * @param {ToolResult} result
 * @returns {string}
 */
export function toolText(result) {
    return (result?.content ?? [])
        .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text)
        .join('\n');
}
