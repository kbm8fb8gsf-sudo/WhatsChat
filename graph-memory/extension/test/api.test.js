import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApi } from '../api.js';

/** @param {number} status @param {unknown} body */
const response = (status, body) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

describe('createApi', () => {
    it('sends SillyTavern\'s request headers and JSON bodies', async () => {
        const fetch = vi.fn(async () => response(200, { segment: { id: 'x' } }));
        const api = createApi({ headers: () => ({ 'X-CSRF-Token': 't' }), fetch });
        await api.addSegment('chat-0123456789abcdef', { a: 1 });
        const [url, init] = fetch.mock.calls[0];
        expect(url).toBe('/api/plugins/graph-memory/memories/chat-0123456789abcdef/segments');
        expect(init.method).toBe('POST');
        expect(init.headers).toEqual({ 'X-CSRF-Token': 't', 'Content-Type': 'application/json' });
        expect(JSON.parse(init.body)).toEqual({ a: 1 });
    });

    it('encodes chat ids in query strings', async () => {
        const fetch = vi.fn(async () => response(200, {}));
        await createApi({ headers: () => ({}), fetch }).memory('chat-0123456789abcdef', 'A & B #1');
        expect(fetch.mock.calls[0][0]).toBe('/api/plugins/graph-memory/memories/chat-0123456789abcdef?chat=A%20%26%20B%20%231');
    });

    it('surfaces the server\'s error message', async () => {
        const api = createApi({ headers: () => ({}), fetch: async () => response(400, { error: 'Invalid memory id' }) });
        await expect(api.status()).rejects.toThrow('Invalid memory id');
    });

    it('explains a missing server plugin', async () => {
        const api = createApi({ headers: () => ({}), fetch: async () => response(404, 'Not found') });
        const err = await api.status().catch((e) => e);
        expect(err).toBeInstanceOf(ApiError);
        expect(err.message).toMatch(/enableServerPlugins/);
    });

    it('reports network failures and timeouts', async () => {
        await expect(createApi({ headers: () => ({}), fetch: async () => { throw new TypeError('offline'); } }).status()).rejects.toThrow(/Can't reach.*offline/);
        const hang = (/** @type {any} */ _u, /** @type {RequestInit} */ init) => new Promise((_r, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
        await expect(createApi({ headers: () => ({}), fetch: /** @type {any} */ (hang) }).recall('chat-0123456789abcdef', { text: 'x', depth: 1, maxChars: 100 }, 20)).rejects.toThrow(/too long/);
    });
});
