// @ts-check
import { describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError } from '../api-client.js';

/**
 * @param {number} status
 * @param {unknown} body
 */
function respond(status, body) {
    return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
}

class FakeEventSource {
    /** @type {FakeEventSource[]} */
    static instances = [];
    /** @param {string} url */
    constructor(url) {
        this.url = url;
        this.readyState = 0;
        /** @type {Record<string, ((event: MessageEvent) => void)[]>} */
        this.listeners = {};
        /** @type {((event: Event) => void) | null} */
        this.onerror = null;
        /** @type {((event: Event) => void) | null} */
        this.onopen = null;
        this.closed = false;
        FakeEventSource.instances.push(this);
    }
    /** @param {string} type @param {(event: MessageEvent) => void} listener */
    addEventListener(type, listener) {
        (this.listeners[type] ??= []).push(listener);
    }
    close() {
        this.closed = true;
        this.readyState = 2;
    }
    /** @param {string} type @param {unknown} data */
    emit(type, data) {
        for (const listener of this.listeners[type] ?? []) listener(new MessageEvent(type, { data: JSON.stringify(data) }));
    }
}

/** @param {(input: string, init?: RequestInit) => Promise<Response>} fetchImpl */
function client(fetchImpl, extra = {}) {
    return new ApiClient({
        headers: () => ({ 'X-CSRF-Token': 'csrf' }),
        fetchImpl: /** @type {typeof fetch} */ (/** @type {unknown} */ (fetchImpl)),
        clientId: 'tab-1234-5678',
        createEventSource: (url) => new FakeEventSource(url),
        ...extra,
    });
}

describe('ApiClient requests', () => {
    it('sends JSON with SillyTavern\u2019s CSRF header to the plugin prefix', async () => {
        const fetchImpl = vi.fn(() => respond(200, { enabled: true }));
        await client(fetchImpl).saveConfig({ enabled: true });
        expect(fetchImpl).toHaveBeenCalledWith('/api/plugins/whatschat/config', {
            method: 'PUT',
            headers: { 'X-CSRF-Token': 'csrf', 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: true }),
        });
    });

    it('turns validation errors into readable messages', async () => {
        const api = client(() => respond(400, { error: 'Invalid config', issues: ['contacts.0.id: bad'] }));
        await expect(api.saveConfig({})).rejects.toThrow('Invalid config: contacts.0.id: bad');
        await expect(api.saveConfig({})).rejects.toBeInstanceOf(ApiError);
    });

    it('says plainly when the plugin is not running', async () => {
        const api = client(() => Promise.resolve(new Response('Not found', { status: 404 })));
        await expect(api.status()).rejects.toThrow('server plugin is not running');
    });

    it('treats a lost claim as an answer, not an error', async () => {
        const fetchImpl = vi.fn(() => respond(409, { ok: false, reason: 'claimed-by-other' }));
        const api = client(fetchImpl);
        expect(await api.claim('b/1')).toEqual({ ok: false, reason: 'claimed-by-other' });
        expect(fetchImpl).toHaveBeenCalledWith(
            '/api/plugins/whatschat/batches/b%2F1/claim',
            expect.objectContaining({ body: JSON.stringify({ clientId: 'tab-1234-5678' }) }),
        );
    });

    it('includes the client id in replies and failures', async () => {
        const fetchImpl = vi.fn(() => respond(202, { ok: true, bubbles: 2 }));
        const api = client(fetchImpl);
        await api.reply('b1', { text: 'hi', chatFile: 'c' });
        expect(fetchImpl).toHaveBeenLastCalledWith(
            '/api/plugins/whatschat/batches/b1/reply',
            expect.objectContaining({ body: JSON.stringify({ clientId: 'tab-1234-5678', text: 'hi', chatFile: 'c' }) }),
        );
        await api.fail('b1', 'x'.repeat(5_000));
        const body = JSON.parse(String(/** @type {any} */ (fetchImpl.mock.calls.at(-1))[1].body));
        expect(body.reason.length).toBe(2_000);
    });
});

describe('ApiClient.listen', () => {
    it('opens the stream with this tab\u2019s id and dispatches events', () => {
        FakeEventSource.instances = [];
        const handlers = { status: vi.fn(), batch: vi.fn(), batchDropped: vi.fn(), config: vi.fn(), connection: vi.fn() };
        const stop = client(vi.fn()).listen(handlers);
        const source = FakeEventSource.instances[0];
        if (!source) throw new Error('no stream');
        expect(source.url).toBe('/api/plugins/whatschat/events?clientId=tab-1234-5678');

        source.onopen?.(new Event('open'));
        source.emit('status', { enabled: true });
        source.emit('batch', { id: 'b1' });
        source.emit('batch-dropped', { batchId: 'b1' });
        source.emit('config', { enabled: false });
        expect(handlers.connection).toHaveBeenCalledWith('open');
        expect(handlers.status).toHaveBeenCalledWith({ enabled: true });
        expect(handlers.batch).toHaveBeenCalledWith({ id: 'b1' });
        expect(handlers.batchDropped).toHaveBeenCalledWith({ batchId: 'b1' });
        expect(handlers.config).toHaveBeenCalledWith({ enabled: false });

        stop();
        expect(source.closed).toBe(true);
    });

    it('reopens with backoff when the browser gives up on the stream', () => {
        FakeEventSource.instances = [];
        /** @type {[() => void, number][]} */
        const timers = [];
        const api = client(vi.fn(), { setTimeoutImpl: (/** @type {() => void} */ fn, /** @type {number} */ ms) => timers.push([fn, ms]) });
        const connection = vi.fn();
        api.listen({ connection });

        const first = FakeEventSource.instances[0];
        if (!first) throw new Error('no stream');
        first.readyState = 0; // still retrying by itself
        first.onerror?.(new Event('error'));
        expect(timers).toEqual([]);

        first.readyState = 2;
        first.onerror?.(new Event('error'));
        expect(connection).toHaveBeenCalledWith('reconnecting');
        expect(timers.map(([, ms]) => ms)).toEqual([2_000]);
        timers[0]?.[0]();
        expect(FakeEventSource.instances.length).toBe(2);

        const second = FakeEventSource.instances[1];
        if (!second) throw new Error('no stream');
        second.readyState = 2;
        second.onerror?.(new Event('error'));
        expect(timers.map(([, ms]) => ms)).toEqual([2_000, 4_000]);
    });
});
