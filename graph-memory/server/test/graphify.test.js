import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { GraphifyService } from '../graphify.js';
import { MemoryStore } from '../store.js';
import { tempDir } from './helpers.js';

const USER = 'default-user';
const SCOPE = 'chat-0123456789abcdef';
const OK_RT = { ok: true, python: '/py', graphifyVersion: '0.9.108', mcp: true, tried: [], checkedAt: '' };

/** @param {Partial<import('../runtime.js').RunResult>} r */
const result = (r) => ({ code: 0, stdout: '', stderr: '', timedOut: false, ...r });

async function setup(overrides = {}) {
    const root = await tempDir();
    const store = new MemoryStore(root);
    await store.addSegment(USER, SCOPE, {
        chatId: 'c', chatLabel: 'c', scopeLabel: 's', from: 0, to: 2, fingerprint: 'f', transcript: 't',
        entities: [{ name: 'Kai', kind: 'person', description: '', aliases: [] }], relations: [],
    });
    const run = vi.fn(async () => result({ stdout: '{"ok": true, "nodes": 1, "edges": 0, "communities": 1, "html": true}\n' }));
    const locate = vi.fn(async () => OK_RT);
    const mcp = { callTool: vi.fn(), close: vi.fn() };
    const service = new GraphifyService({
        store, workDir: path.join(root, 'mcp'), run, locate, createMcp: () => mcp, buildDelayMs: 10, ...overrides,
    });
    return { root, store, run, locate, mcp, service };
}

describe('GraphifyService builds', () => {
    it('writes the extraction, runs the bridge and records the result', async () => {
        const { store, run, service } = await setup();
        const info = await service.scheduleBuild(USER, SCOPE);
        expect(info).toMatchObject({ state: 'idle', nodes: 1, edges: 0, communities: 1, html: true, error: null });
        const [python, args] = run.mock.calls[0];
        expect(python).toBe('/py');
        expect(args.slice(1)).toEqual(['build', store.dir(USER, SCOPE)]);
        expect(args[0]).toMatch(/gm_bridge\.py$/);
        const extraction = JSON.parse(await fs.readFile(path.join(store.dir(USER, SCOPE), 'extraction.json'), 'utf8'));
        expect(extraction.nodes[0].id).toBe('kai');
        expect(await service.buildInfo(USER, SCOPE)).toMatchObject({ nodes: 1, builtAt: expect.any(String) });
    });

    it('coalesces a burst of changes into one build', async () => {
        const { run, service } = await setup();
        const all = await Promise.all([service.scheduleBuild(USER, SCOPE), service.scheduleBuild(USER, SCOPE), service.scheduleBuild(USER, SCOPE)]);
        expect(run).toHaveBeenCalledTimes(1);
        expect(all.every((i) => i.nodes === 1)).toBe(true);
    });

    it('builds again when facts arrive during a build', async () => {
        /** @type {() => void} */
        let release = () => {};
        const run = vi.fn()
            .mockImplementationOnce(() => new Promise((r) => {
                release = () => r(result({ stdout: '{"ok":true,"nodes":1,"edges":0,"communities":1,"html":false}' }));
            }))
            .mockImplementation(async () => result({ stdout: '{"ok":true,"nodes":2,"edges":1,"communities":1,"html":false}' }));
        const { service } = await setup({ run });
        const first = service.scheduleBuild(USER, SCOPE, 0);
        await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
        expect((await service.buildInfo(USER, SCOPE)).state).toBe('building');
        const second = service.scheduleBuild(USER, SCOPE, 0);
        release();
        expect((await first).nodes).toBe(1);
        expect((await second).nodes).toBe(2);
        expect(run).toHaveBeenCalledTimes(2);
    });

    it('keeps the previous counts and records the error when a build fails', async () => {
        const run = vi.fn()
            .mockResolvedValueOnce(result({ stdout: '{"ok":true,"nodes":3,"edges":2,"communities":1,"html":true}' }))
            .mockResolvedValueOnce(result({ code: 1, stdout: '{"ok":false,"error":"ValueError: bad"}' }));
        const { service } = await setup({ run });
        await service.scheduleBuild(USER, SCOPE, 0);
        const info = await service.scheduleBuild(USER, SCOPE, 0);
        expect(info).toMatchObject({ nodes: 3, edges: 2, error: 'ValueError: bad' });
    });

    it('records a clear error when graphify is missing', async () => {
        const { service, run } = await setup({ locate: async () => ({ ok: false, error: 'graphify was not found', tried: [], checkedAt: '' }) });
        const info = await service.scheduleBuild(USER, SCOPE, 0);
        expect(info.error).toBe('graphify was not found');
        expect(run).not.toHaveBeenCalled();
    });
});

describe('GraphifyService queries', () => {
    /** @param {Awaited<ReturnType<typeof setup>>} ctx */
    async function withGraph(ctx) {
        const file = ctx.store.graphFile(USER, SCOPE);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, '{"nodes":[],"links":[]}');
        return file;
    }

    it('returns null before anything is remembered', async () => {
        const ctx = await setup();
        expect(await ctx.service.query(USER, SCOPE, 'q', { depth: 2, tokenBudget: 500 })).toBeNull();
        expect(ctx.locate).not.toHaveBeenCalled();
    });

    it('asks graphify\'s MCP server with the memory folder as project_path', async () => {
        const ctx = await setup();
        await withGraph(ctx);
        ctx.mcp.callTool.mockResolvedValue({ content: [{ type: 'text', text: 'NODE Kai [src=x]' }] });
        const out = await ctx.service.query(USER, SCOPE, 'Kai?', { depth: 9, tokenBudget: 50 });
        expect(out).toEqual({ text: 'NODE Kai [src=x]', engine: 'mcp' });
        expect(ctx.mcp.callTool).toHaveBeenCalledWith('query_graph', {
            question: 'Kai?', project_path: ctx.store.dir(USER, SCOPE), mode: 'bfs', depth: 6, token_budget: 100, demote_docs: false,
        }, 15000);
    });

    it('treats graphify\'s "graph.json not found" as empty', async () => {
        const ctx = await setup();
        await withGraph(ctx);
        ctx.mcp.callTool.mockResolvedValue({ content: [{ type: 'text', text: 'Error executing query_graph: graph.json not found: /x' }] });
        expect(await ctx.service.query(USER, SCOPE, 'q', { depth: 2, tokenBudget: 500 })).toEqual({ text: '', engine: 'mcp' });
    });

    it('falls back to the graphify command when the MCP server fails', async () => {
        const ctx = await setup();
        const file = await withGraph(ctx);
        ctx.mcp.callTool.mockRejectedValue(new Error('crashed'));
        ctx.run.mockResolvedValue(result({ stdout: 'NODE Kai [src=x]\n' }));
        const out = await ctx.service.query(USER, SCOPE, 'Kai?', { depth: 2, tokenBudget: 500 });
        expect(out).toEqual({ text: 'NODE Kai [src=x]\n', engine: 'cli' });
        expect(ctx.run.mock.calls.at(-1)?.[1]).toEqual(['-m', 'graphify', 'query', 'Kai?', '--graph', file, '--budget', '500', '--depth', '2']);
    });

    it('uses the command directly without the MCP extra, mapping its exit codes', async () => {
        const ctx = await setup({ locate: async () => ({ ...OK_RT, mcp: false }) });
        await withGraph(ctx);
        ctx.run.mockResolvedValueOnce(result({ code: 4, stdout: 'No matching nodes found.' }));
        expect(await ctx.service.query(USER, SCOPE, 'q', { depth: 2, tokenBudget: 500 })).toEqual({ text: '', engine: 'cli' });
        ctx.run.mockResolvedValueOnce(result({ code: 2, stderr: 'Traceback\nKeyError: x' }));
        await expect(ctx.service.query(USER, SCOPE, 'q', { depth: 2, tokenBudget: 500 })).rejects.toThrow(/KeyError/);
        expect(ctx.mcp.callTool).not.toHaveBeenCalled();
    });

    it('re-detects graphify on refresh and restarts the MCP server', async () => {
        const ctx = await setup();
        await ctx.service.runtime();
        await withGraph(ctx);
        ctx.mcp.callTool.mockResolvedValue({ content: [] });
        await ctx.service.query(USER, SCOPE, 'q', { depth: 2, tokenBudget: 500 });
        await ctx.service.runtime({ refresh: true });
        expect(ctx.locate).toHaveBeenCalledTimes(2);
        expect(ctx.mcp.close).toHaveBeenCalled();
    });
});
