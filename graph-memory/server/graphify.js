// @ts-check
/**
 * Everything that runs graphify:
 *  - builds: `gm_bridge.py build <memory>` turns extraction.json into graphify-out/graph.json
 *    (debounced per memory, one build at a time so a busy server isn't swamped);
 *  - queries: graphify's MCP server (`query_graph`), or the `graphify query` command when the
 *    MCP extra isn't installed. Both return the same text, which render.js turns into notes.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { McpClient, toolText } from './mcp-client.js';
import { BRIDGE_SCRIPT, describeFailure, lastJsonLine, locateGraphify, pythonArgs, run } from './runtime.js';
import { errorMessage, exists, readJson, silentLogger, writeJsonAtomic } from './util.js';

/**
 * @typedef {import('./runtime.js').GraphifyRuntime} GraphifyRuntime
 * @typedef {import('./store.js').MemoryStore} MemoryStore
 */

/**
 * @typedef {object} BuildInfo
 * @property {'idle' | 'pending' | 'building'} state
 * @property {string | null} builtAt
 * @property {number} nodes
 * @property {number} edges
 * @property {number} communities
 * @property {boolean} html
 * @property {string | null} error
 */

/**
 * @typedef {object} ServiceOptions
 * @property {MemoryStore} store
 * @property {string} workDir                where graphify's MCP server runs
 * @property {import('./util.js').Logger} [logger]
 * @property {string} [configuredPython]
 * @property {(opts: { configured?: string | undefined }) => Promise<GraphifyRuntime>} [locate]
 * @property {typeof run} [run]
 * @property {(opts: import('./mcp-client.js').McpClientOptions) => Pick<McpClient, 'callTool' | 'close'>} [createMcp]
 * @property {number} [buildDelayMs]
 * @property {number} [buildTimeoutMs]
 * @property {number} [queryTimeoutMs]
 */

export class GraphifyService {
    /** @param {ServiceOptions} options */
    constructor(options) {
        this.store = options.store;
        this.workDir = options.workDir;
        this.logger = options.logger ?? silentLogger;
        this.configuredPython = options.configuredPython;
        this.locate = options.locate ?? locateGraphify;
        this.runFn = options.run ?? run;
        this.createMcp = options.createMcp ?? ((opts) => new McpClient(opts));
        this.buildDelayMs = options.buildDelayMs ?? 2500;
        this.buildTimeoutMs = options.buildTimeoutMs ?? 180_000;
        this.queryTimeoutMs = options.queryTimeoutMs ?? 15_000;
        /** @type {Promise<GraphifyRuntime> | null} */
        this.runtimePromise = null;
        /** @type {Pick<McpClient, 'callTool' | 'close'> | null} */
        this.mcp = null;
        /** @type {Map<string, { user: string, scope: string, timer: NodeJS.Timeout | null, state: BuildInfo['state'], dirty: boolean, waiters: ((info: BuildInfo) => void)[] }>} */
        this.builds = new Map();
        /** @type {Promise<unknown>} */
        this.buildQueue = Promise.resolve();
        this.closed = false;
    }

    /**
     * @param {{ refresh?: boolean }} [opts]
     * @returns {Promise<GraphifyRuntime>}
     */
    runtime(opts = {}) {
        if (opts.refresh || !this.runtimePromise) {
            if (opts.refresh) this.resetMcp();
            this.runtimePromise = this.locate({ configured: this.configuredPython }).then((rt) => {
                if (rt.ok) this.logger.info(`Using graphify ${rt.graphifyVersion} (${rt.python}${rt.mcp ? ', MCP server available' : ', no MCP extra: using the CLI'}).`);
                else this.logger.warn(rt.error ?? 'graphify not found');
                return rt;
            });
        }
        return this.runtimePromise;
    }

    resetMcp() {
        this.mcp?.close();
        this.mcp = null;
    }

    // ---------- builds ----------

    /**
     * @param {string} user
     * @param {string} scope
     */
    buildKey(user, scope) {
        return `${user}/${scope}`;
    }

    /**
     * Rebuilds the graph a little later, so a burst of new facts causes one build.
     * @param {string} user
     * @param {string} scope
     * @param {number} [delayMs]
     * @returns {Promise<BuildInfo>} settles when the build that includes this change finishes
     */
    scheduleBuild(user, scope, delayMs = this.buildDelayMs) {
        const key = this.buildKey(user, scope);
        let entry = this.builds.get(key);
        if (!entry) {
            entry = { user, scope, timer: null, state: 'idle', dirty: false, waiters: [] };
            this.builds.set(key, entry);
        }
        const e = entry;
        const done = new Promise((resolve) => e.waiters.push(resolve));
        if (e.state === 'building') {
            e.dirty = true;
            return /** @type {Promise<BuildInfo>} */ (done);
        }
        e.state = 'pending';
        if (e.timer) clearTimeout(e.timer);
        e.timer = setTimeout(() => {
            e.timer = null;
            this.enqueueBuild(key);
        }, delayMs);
        return /** @type {Promise<BuildInfo>} */ (done);
    }

    /** @param {string} key */
    enqueueBuild(key) {
        this.buildQueue = this.buildQueue.then(() => this.runBuild(key)).catch((err) => {
            this.logger.error(`Build failed: ${errorMessage(err)}`);
        });
    }

    /** @param {string} key */
    async runBuild(key) {
        const entry = this.builds.get(key);
        if (!entry || this.closed) return;
        entry.state = 'building';
        entry.dirty = false;
        const waiters = entry.waiters.splice(0);
        /** @type {BuildInfo} */
        let info;
        try {
            info = await this.build(entry.user, entry.scope);
        } catch (err) {
            info = { ...(await this.buildInfo(entry.user, entry.scope)), state: 'idle', error: errorMessage(err) };
        }
        if (entry.dirty && !this.closed) {
            // More facts arrived while building: build again; their waiters get that result.
            entry.state = 'pending';
            this.enqueueBuild(key);
        } else {
            entry.state = 'idle';
            if (entry.waiters.length === 0) this.builds.delete(key);
        }
        for (const w of waiters) w(info);
    }

    /**
     * Merges the memory's slices and has graphify build, cluster and draw the graph.
     * @param {string} user
     * @param {string} scope
     * @returns {Promise<BuildInfo>}
     */
    async build(user, scope) {
        const dir = this.store.dir(user, scope);
        const statusFile = path.join(dir, 'build.json');
        /** @type {BuildInfo} */
        const previous = await this.buildInfo(user, scope);
        const rt = await this.runtime();
        if (!rt.ok || !rt.python) {
            const info = { ...previous, state: /** @type {const} */ ('idle'), error: rt.error ?? 'graphify was not found.' };
            await writeJsonAtomic(statusFile, info);
            return info;
        }
        await this.store.writeExtraction(user, scope);
        const started = Date.now();
        const result = await this.runFn(rt.python, pythonArgs(rt.python, [BRIDGE_SCRIPT, 'build', dir]), { timeoutMs: this.buildTimeoutMs, cwd: dir });
        const json = lastJsonLine(result);
        /** @type {BuildInfo} */
        let info;
        if (result.code === 0 && json?.ok) {
            info = {
                state: 'idle',
                builtAt: new Date().toISOString(),
                nodes: Number(json.nodes) || 0,
                edges: Number(json.edges) || 0,
                communities: Number(json.communities) || 0,
                html: Boolean(json.html),
                error: null,
            };
            this.logger.info(`Memory ${scope}: graphify built ${info.nodes} entities, ${info.edges} links in ${Date.now() - started} ms.`);
        } else {
            info = { ...previous, state: 'idle', error: describeFailure(result, 'graphify build') };
            this.logger.warn(`Memory ${scope}: build failed: ${info.error}`);
        }
        await writeJsonAtomic(statusFile, info);
        return info;
    }

    /**
     * @param {string} user
     * @param {string} scope
     * @returns {Promise<BuildInfo>}
     */
    async buildInfo(user, scope) {
        const saved = await readJson(path.join(this.store.dir(user, scope), 'build.json'), null);
        const live = this.builds.get(this.buildKey(user, scope));
        return {
            state: live?.state ?? 'idle',
            builtAt: saved?.builtAt ?? null,
            nodes: saved?.nodes ?? 0,
            edges: saved?.edges ?? 0,
            communities: saved?.communities ?? 0,
            html: saved?.html ?? false,
            error: saved?.error ?? null,
        };
    }

    // ---------- queries ----------

    /**
     * Asks graphify which remembered entities matter for `question`.
     * @param {string} user
     * @param {string} scope
     * @param {string} question
     * @param {{ depth: number, tokenBudget: number }} opts
     * @returns {Promise<{ text: string, engine: 'mcp' | 'cli' } | null>} null when nothing is remembered yet
     */
    async query(user, scope, question, opts) {
        const graphFile = this.store.graphFile(user, scope);
        if (!(await exists(graphFile))) return null;
        const rt = await this.runtime();
        if (!rt.ok || !rt.python) throw new Error(rt.error ?? 'graphify was not found.');
        const depth = Math.min(6, Math.max(1, Math.round(opts.depth)));
        const tokenBudget = Math.min(20_000, Math.max(100, Math.round(opts.tokenBudget)));

        if (rt.mcp) {
            try {
                const text = await this.queryMcp(rt.python, this.store.dir(user, scope), question, depth, tokenBudget);
                return { text, engine: 'mcp' };
            } catch (err) {
                this.logger.warn(`MCP query failed, using the graphify command instead: ${errorMessage(err)}`);
            }
        }
        const text = await this.queryCli(rt.python, graphFile, question, depth, tokenBudget);
        return { text, engine: 'cli' };
    }

    /**
     * @param {string} python
     * @param {string} projectDir
     * @param {string} question
     * @param {number} depth
     * @param {number} tokenBudget
     */
    async queryMcp(python, projectDir, question, depth, tokenBudget) {
        if (!this.mcp) {
            await fs.mkdir(this.workDir, { recursive: true });
            this.mcp = this.createMcp({
                command: python,
                args: pythonArgs(python, ['-m', 'graphify.serve']),
                cwd: this.workDir,
                logger: this.logger,
                env: { GRAPHIFY_QUERY_LOG_DISABLE: '1' },
            });
        }
        const result = await this.mcp.callTool('query_graph', {
            question,
            project_path: projectDir,
            mode: 'bfs',
            depth,
            token_budget: tokenBudget,
            demote_docs: false,
        }, this.queryTimeoutMs);
        const text = toolText(result);
        if (result.isError || text.startsWith('Error executing')) {
            if (/graph\.json not found/i.test(text)) return '';
            throw new Error(text || 'query_graph failed');
        }
        return text;
    }

    /**
     * @param {string} python
     * @param {string} graphFile
     * @param {string} question
     * @param {number} depth
     * @param {number} tokenBudget
     */
    async queryCli(python, graphFile, question, depth, tokenBudget) {
        const result = await this.runFn(
            python,
            pythonArgs(python, ['-m', 'graphify', 'query', question, '--graph', graphFile, '--budget', String(tokenBudget), '--depth', String(depth)]),
            { timeoutMs: this.queryTimeoutMs, cwd: path.dirname(path.dirname(graphFile)), env: { GRAPHIFY_QUERY_LOG_DISABLE: '1' } },
        );
        // 0 = answer, 3 = ambiguous name (candidates listed), 4 = nothing matched.
        if (result.code === 0 || result.code === 3) return result.stdout;
        if (result.code === 4) return '';
        throw new Error(describeFailure(result, 'graphify query'));
    }

    close() {
        this.closed = true;
        for (const entry of this.builds.values()) {
            if (entry.timer) clearTimeout(entry.timer);
        }
        this.resetMcp();
    }
}
