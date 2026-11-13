import { promises as fs } from 'node:fs';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphCache } from '../render.js';
import { GRAPH_PAGE_CSP, registerRoutes, userOf } from '../routes.js';
import { MemoryStore } from '../store.js';
import { silentLogger } from '../util.js';
import { tempDir } from './helpers.js';

const SCOPE = 'chat-0123456789abcdef';
const BUILD = { state: 'idle', builtAt: null, nodes: 0, edges: 0, communities: 0, html: false, error: null };

describe('routes', () => {
    /** @type {import('node:http').Server} */
    let server;
    /** @type {string} */
    let base;
    /** @type {MemoryStore} */
    let store;
    /** @type {any} */
    let graphify;
    let user = 'alice';

    beforeEach(async () => {
        user = 'alice';
        store = new MemoryStore(await tempDir());
        graphify = {
            runtime: vi.fn(async () => ({ ok: true, graphifyVersion: '0.9.108', mcp: true, tried: [] })),
            buildInfo: vi.fn(async () => BUILD),
            scheduleBuild: vi.fn(async () => ({ ...BUILD, nodes: 1 })),
            query: vi.fn(async () => null),
        };
        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            /** @type {any} */ (req).user = { profile: { handle: user } };
            next();
        });
        const router = express.Router();
        registerRoutes(router, { store, graphify, graphs: new GraphCache(), logger: silentLogger, version: '0.1.0' });
        app.use('/api/plugins/graph-memory', router);
        server = app.listen(0);
        await new Promise((r) => server.once('listening', r));
        const addr = /** @type {import('node:net').AddressInfo} */ (server.address());
        base = `http://127.0.0.1:${addr.port}/api/plugins/graph-memory`;
    });

    afterEach(() => server.close());

    /** @param {string} method @param {string} p @param {unknown} [body] */
    async function call(method, p, body) {
        const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
        const text = await res.text();
        let json = null;
        try {
            json = JSON.parse(text);
        } catch {
            // html or text
        }
        return { status: res.status, json, text, type: res.headers.get('content-type'), csp: res.headers.get('content-security-policy') };
    }

    const segment = (from = 0, to = 4) => ({
        chatId: 'chat A', chatLabel: 'A', scopeLabel: 'Seraphina: A', from, to, fingerprint: 'fp', transcript: '[#0] S: hi',
        entities: [{ name: 'Kai', kind: 'person', description: 'Traveller' }, { name: 'Seraphina' }],
        relations: [{ source: 'Seraphina', relation: 'healed', target: 'Kai' }],
    });

    it('reports status', async () => {
        const r = await call('GET', '/status');
        expect(r.json).toEqual({ version: '0.1.0', graphify: { ok: true, graphifyVersion: '0.9.108', mcp: true, tried: [] } });
        await call('POST', '/status/refresh', {});
        expect(graphify.runtime).toHaveBeenLastCalledWith({ refresh: true });
    });

    it('stores segments, schedules a build and reports coverage', async () => {
        const r = await call('POST', `/memories/${SCOPE}/segments`, segment());
        expect(r.status).toBe(200);
        expect(r.json.segment).toMatchObject({ from: 0, to: 4, entities: 2, relations: 1 });
        expect(graphify.scheduleBuild).toHaveBeenCalledWith('alice', SCOPE);
        const info = await call('GET', `/memories/${SCOPE}?chat=${encodeURIComponent('chat A')}`);
        expect(info.json.segments).toEqual([expect.objectContaining({ from: 0, to: 4, fingerprint: 'fp' })]);
        expect(info.json.meta.label).toBe('Seraphina: A');
        const entities = await call('GET', `/memories/${SCOPE}/entities?limit=1`);
        expect(entities.json.entities).toHaveLength(1);
        expect((await call('GET', '/memories')).json.memories).toHaveLength(1);
    });

    it('keeps each SillyTavern user\'s memories separate', async () => {
        await call('POST', `/memories/${SCOPE}/segments`, segment());
        user = 'bob';
        expect((await call('GET', '/memories')).json.memories).toEqual([]);
        expect(userOf(/** @type {any} */ ({ user: { profile: { handle: '../evil' } } }))).toBe('default-user');
    });

    it('validates input', async () => {
        expect((await call('POST', '/memories/not-a-scope/segments', segment())).status).toBe(400);
        expect((await call('POST', `/memories/${SCOPE}/segments`, { ...segment(), to: 0 })).status).toBe(400);
        expect((await call('POST', `/memories/${SCOPE}/forget`, {})).status).toBe(400);
    });

    it('forgets segments and rebuilds', async () => {
        const { json } = await call('POST', `/memories/${SCOPE}/segments`, segment());
        graphify.scheduleBuild.mockClear();
        expect((await call('POST', `/memories/${SCOPE}/forget`, { chatId: 'chat A', ids: [json.segment.id] })).json).toEqual({ removed: 1 });
        expect(graphify.scheduleBuild).toHaveBeenCalledWith('alice', SCOPE, 500);
        expect((await call('POST', `/memories/${SCOPE}/forget`, { chatId: 'chat A' })).json).toEqual({ removed: 0 });
        expect((await call('POST', `/memories/${SCOPE}/rebuild`, {})).json.build.nodes).toBe(1);
    });

    it('recalls: graphify picks the entities, the server writes the notes', async () => {
        const file = store.graphFile('alice', SCOPE);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, JSON.stringify({
            nodes: [{ id: 'kai', label: 'Kai', attributes: { kind: 'person', description: 'Traveller' } }, { id: 'seraphina', label: 'Seraphina', attributes: {} }],
            links: [{ source: 'seraphina', target: 'kai', relation: 'healed' }],
        }));
        graphify.query.mockResolvedValue({ engine: 'mcp', text: 'Graph: …\n\nNODE Kai [src=a loc=b community=0]\nNODE Seraphina [src=a loc=b community=0]\nEDGE Seraphina --healed [EXTRACTED]--> Kai' });
        const r = await call('POST', `/memories/${SCOPE}/recall`, { text: 'How is Kai?', depth: 3, maxChars: 900, debug: true });
        expect(r.json).toMatchObject({
            memory: '• Kai (person): Traveller\n• Seraphina\n   – Seraphina healed Kai',
            entities: ['Kai', 'Seraphina'],
            engine: 'mcp',
        });
        expect(r.json.raw).toContain('NODE Kai');
        expect(graphify.query).toHaveBeenCalledWith('alice', SCOPE, 'How is Kai?', { depth: 3, tokenBudget: 600 });
    });

    it('recalls nothing for empty text or an empty memory', async () => {
        expect((await call('POST', `/memories/${SCOPE}/recall`, { text: '  ' })).json.memory).toBe('');
        expect((await call('POST', `/memories/${SCOPE}/recall`, { text: 'hi' })).json).toMatchObject({ memory: '', engine: null });
    });

    it('turns failures into a 500 with the message', async () => {
        graphify.query.mockRejectedValue(new Error('graphify was not found'));
        const r = await call('POST', `/memories/${SCOPE}/recall`, { text: 'hi' });
        expect(r.status).toBe(500);
        expect(r.json.error).toBe('graphify was not found');
    });

    it('serves graphify\'s picture and deletes memories', async () => {
        expect((await call('GET', `/memories/${SCOPE}/graph.html`)).status).toBe(404);
        const file = store.htmlFile('alice', SCOPE);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, '<html>graph</html>');
        const r = await call('GET', `/memories/${SCOPE}/graph.html`);
        expect(r.text).toBe('<html>graph</html>');
        expect(r.type).toMatch(/text\/html/);
        expect(r.csp).toBe(GRAPH_PAGE_CSP);
        expect(r.csp).toMatch(/^sandbox allow-scripts allow-popups;/);
        expect((await call('DELETE', `/memories/${SCOPE}`)).json).toEqual({ ok: true });
        expect((await call('GET', `/memories/${SCOPE}/graph.html`)).status).toBe(404);
    });
});
