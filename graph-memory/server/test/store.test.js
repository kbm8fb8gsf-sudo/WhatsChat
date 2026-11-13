import { promises as fs } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { chatKey, MemoryStore } from '../store.js';
import { tempDir } from './helpers.js';

const SCOPE = 'chat-0123456789abcdef';
const USER = 'default-user';

/** @param {number} from @param {number} to @param {Partial<import('../normalize.js').SegmentInput>} [over] */
const input = (from, to, over = {}) => ({
    chatId: 'Seraphina - 2026-11-13',
    chatLabel: 'Forest',
    scopeLabel: 'Seraphina: Forest',
    from,
    to,
    fingerprint: `fp${from}`,
    transcript: `[#${from}] Seraphina: hello`,
    entities: [{ name: `E${from}`, kind: 'thing', description: '', aliases: [] }],
    relations: [],
    ...over,
});

describe('MemoryStore', () => {
    /** @type {MemoryStore} */
    let store;
    /** @type {string} */
    let root;
    let clock = 0;

    beforeEach(async () => {
        root = await tempDir();
        clock = 0;
        store = new MemoryStore(root, () => new Date(Date.UTC(2026, 0, 1, 0, 0, clock++)));
    });

    it('stores a segment with its transcript and metadata', async () => {
        const seg = await store.addSegment(USER, SCOPE, input(0, 8));
        const dir = store.dir(USER, SCOPE);
        expect(seg.id).toBe(`${chatKey('Seraphina - 2026-11-13')}_000000_000008`);
        const md = await fs.readFile(path.join(dir, seg.sourceFile), 'utf8');
        expect(md).toBe('# Forest: messages #0–#7\n\n[#0] Seraphina: hello\n');
        expect(await store.meta(USER, SCOPE)).toMatchObject({ scope: SCOPE, label: 'Seraphina: Forest' });
        const stat = await fs.stat(path.join(dir, 'segments', `${seg.id}.json`));
        if (process.platform !== 'win32') expect(stat.mode & 0o077).toBe(0);
    });

    it('lists a chat\'s segments in order', async () => {
        await store.addSegment(USER, SCOPE, input(8, 16));
        await store.addSegment(USER, SCOPE, input(0, 8));
        await store.addSegment(USER, SCOPE, input(0, 4, { chatId: 'other chat' }));
        const segs = await store.chatSegments(USER, SCOPE, 'Seraphina - 2026-11-13');
        expect(segs.map((s) => [s.from, s.to, s.fingerprint])).toEqual([[0, 8, 'fp0'], [8, 16, 'fp8']]);
    });

    it('replaces overlapping segments of the same chat only', async () => {
        await store.addSegment(USER, SCOPE, input(0, 8));
        await store.addSegment(USER, SCOPE, input(8, 16));
        await store.addSegment(USER, SCOPE, input(0, 8, { chatId: 'other chat' }));
        await store.addSegment(USER, SCOPE, input(4, 12));
        const segs = await store.chatSegments(USER, SCOPE, 'Seraphina - 2026-11-13');
        expect(segs.map((s) => [s.from, s.to])).toEqual([[4, 12]]);
        expect(await store.chatSegments(USER, SCOPE, 'other chat')).toHaveLength(1);
        const corpus = await fs.readdir(path.join(store.dir(USER, SCOPE), 'corpus'));
        expect(corpus).toHaveLength(2);
    });

    it('forgets chosen segments or a whole chat', async () => {
        const a = await store.addSegment(USER, SCOPE, input(0, 8));
        await store.addSegment(USER, SCOPE, input(8, 16));
        await store.addSegment(USER, SCOPE, input(0, 8, { chatId: 'other chat' }));
        expect(await store.forget(USER, SCOPE, 'Seraphina - 2026-11-13', [a.id])).toBe(1);
        expect((await store.chatSegments(USER, SCOPE, 'Seraphina - 2026-11-13')).map((s) => s.from)).toEqual([8]);
        expect(await store.forget(USER, SCOPE, 'Seraphina - 2026-11-13', null)).toBe(1);
        expect(await store.segments(USER, SCOPE)).toHaveLength(1);
    });

    it('writes the merged extraction for graphify', async () => {
        await store.addSegment(USER, SCOPE, input(0, 8, { relations: [{ source: 'E0', relation: 'knows', target: 'Kai', detail: '' }] }));
        const res = await store.writeExtraction(USER, SCOPE);
        expect(res).toMatchObject({ nodes: 2, edges: 1 });
        const data = JSON.parse(await fs.readFile(res.file, 'utf8'));
        expect(data.nodes.map((/** @type {any} */ n) => n.id).sort()).toEqual(['e0', 'kai']);
        expect(data.hyperedges).toEqual([]);
    });

    it('lists memories newest first and deletes them', async () => {
        await store.addSegment(USER, SCOPE, input(0, 8));
        await store.addSegment(USER, 'char-0123456789abcdef', input(0, 8, { scopeLabel: 'Seraphina' }));
        const list = await store.list(USER);
        expect(list.map((m) => [m.scope, m.segments])).toEqual([['char-0123456789abcdef', 1], [SCOPE, 1]]);
        await store.deleteScope(USER, SCOPE);
        expect((await store.list(USER)).map((m) => m.scope)).toEqual(['char-0123456789abcdef']);
    });

    it('keeps users apart', async () => {
        await store.addSegment('alice', SCOPE, input(0, 8));
        expect(await store.segments('bob', SCOPE)).toEqual([]);
    });

    it('rejects ids that could escape the data folder', () => {
        expect(() => store.dir(USER, '../../etc')).toThrow();
        expect(() => store.dir('../x', SCOPE)).toThrow();
        expect(() => store.dir('Bob', SCOPE)).toThrow();
    });

    it('serialises concurrent writes to one memory', async () => {
        await Promise.all([0, 4, 8, 12].map((from) => store.addSegment(USER, SCOPE, input(from, from + 6))));
        const segs = await store.chatSegments(USER, SCOPE, 'Seraphina - 2026-11-13');
        // Each newer slice replaced the one it overlapped; none may overlap now.
        for (let i = 1; i < segs.length; i++) expect(segs[i].from).toBeGreaterThanOrEqual(segs[i - 1].to);
    });
});
