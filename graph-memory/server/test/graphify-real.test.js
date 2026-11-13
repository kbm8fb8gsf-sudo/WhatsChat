/**
 * End-to-end against a real graphify install. Runs only when GRAPH_MEMORY_TEST_PYTHON names
 * a Python that has graphify ("graphifyy[mcp]") installed, e.g.
 *   GRAPH_MEMORY_TEST_PYTHON=~/.local/share/uv/tools/graphifyy/bin/python npm test
 */
import { promises as fs } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { GraphifyService } from '../graphify.js';
import { GraphCache, labelsToIds, parseGraphifyLabels, renderMemory } from '../render.js';
import { locateGraphify } from '../runtime.js';
import { MemoryStore } from '../store.js';
import { silentLogger } from '../util.js';
import { tempDir } from './helpers.js';

const PYTHON = process.env.GRAPH_MEMORY_TEST_PYTHON;
const USER = 'default-user';
const SCOPE = 'chat-0123456789abcdef';

describe.skipIf(!PYTHON)('with real graphify', () => {
    /** @type {GraphifyService} */
    let service;

    afterAll(() => service?.close());

    it('builds a graph, answers through MCP and the CLI, and forgets', async () => {
        const root = await tempDir();
        const store = new MemoryStore(root);
        service = new GraphifyService({
            store, workDir: `${root}/mcp`, logger: silentLogger, configuredPython: PYTHON, buildDelayMs: 0,
            locate: (o) => locateGraphify({ ...o, env: { PATH: '' } }),
        });
        const rt = await service.runtime();
        expect(rt.ok).toBe(true);

        const base = { chatId: 'c', chatLabel: 'Forest', scopeLabel: 'Seraphina: Forest', fingerprint: 'f' };
        await store.addSegment(USER, SCOPE, {
            ...base, from: 0, to: 8, transcript: '[#0] …',
            entities: [
                { name: 'Seraphina', kind: 'character', description: 'Guardian of Eldoria Forest.', aliases: [] },
                { name: 'Kai', kind: 'person', description: 'A wounded traveller.', aliases: ['the traveller'] },
            ],
            relations: [{ source: 'Seraphina', relation: 'healed', target: 'Kai', detail: 'wolf bite' }],
        });
        await store.addSegment(USER, SCOPE, {
            ...base, from: 8, to: 16, transcript: '[#8] …',
            entities: [{ name: 'Silver Amulet', kind: 'item', description: 'Glows near danger.', aliases: [] }],
            relations: [
                { source: 'the traveller', relation: 'gave_gift_to', target: 'Seraphina', detail: 'the amulet' },
                { source: 'Kai', relation: 'owned', target: 'Silver Amulet', detail: '' },
            ],
        });
        const build = await service.scheduleBuild(USER, SCOPE, 0);
        expect(build).toMatchObject({ error: null, nodes: 3, edges: 3 });
        expect(build.html).toBe(true);

        const graphs = new GraphCache();
        const answer = await service.query(USER, SCOPE, 'Does Seraphina still wear the amulet?', { depth: 2, tokenBudget: 800 });
        expect(answer?.engine).toBe(rt.mcp ? 'mcp' : 'cli');
        const graph = await graphs.load(store.graphFile(USER, SCOPE));
        if (!graph || !answer) throw new Error('no graph');
        const ids = labelsToIds(graph, parseGraphifyLabels(answer.text));
        expect(ids).toEqual(expect.arrayContaining(['seraphina', 'silver_amulet', 'kai']));
        const memory = renderMemory(graph, ids, { maxChars: 2000 }).text;
        expect(memory).toContain('Kai gave gift to Seraphina (the amulet)');
        expect(memory).toContain('Seraphina healed Kai (wolf bite)');

        const cli = await service.queryCli(/** @type {string} */ (rt.python), store.graphFile(USER, SCOPE), 'amulet', 2, 500);
        expect(parseGraphifyLabels(cli)).toContain('Silver Amulet');
        expect(await service.queryCli(/** @type {string} */ (rt.python), store.graphFile(USER, SCOPE), 'zzzz qqqq', 2, 500)).toBe('');

        await store.forget(USER, SCOPE, 'c', null);
        const empty = await service.scheduleBuild(USER, SCOPE, 0);
        expect(empty.nodes).toBe(0);
        await expect(fs.access(store.graphFile(USER, SCOPE))).rejects.toThrow();
        expect(await service.query(USER, SCOPE, 'amulet', { depth: 2, tokenBudget: 500 })).toBeNull();
    }, 120_000);
});
