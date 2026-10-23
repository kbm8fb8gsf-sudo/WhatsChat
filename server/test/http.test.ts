import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPlugin, type PluginHandle } from '../src/plugin.js';
import { FakeTransport } from '../src/transport/fake.js';
import { silentLogger } from '../src/util/logger.js';
import { SseClient } from './sse-client.js';

const ALICE = '+447700900123';
const BASE_CONFIG = {
    enabled: true,
    contacts: [{ id: ALICE, characterAvatar: 'Seraphina.png', chatFile: 'chat-1' }],
    realistic: { preset: 'off' },
    inbound: { quietMs: 0 },
};

let dir: string;
let server: Server;
let base: string;
let plugin: PluginHandle;
let transport: FakeTransport;
const clients: SseClient[] = [];

async function startPlugin(): Promise<void> {
    const router = express.Router();
    plugin = await createPlugin(router, {
        dataDir: dir,
        logger: silentLogger,
        createTransport: () => (transport = new FakeTransport()),
        clientGraceMs: 100,
    });
    const app = express();
    app.use(express.json());
    app.use('/api/plugins/whatschat', router);
    server = app.listen(0);
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/api/plugins/whatschat`;
}

async function api(method: string, route: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const init: RequestInit = { method, headers: { 'Content-Type': 'application/json' } };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await fetch(`${base}${route}`, init);
    return { status: res.status, json: await res.json() };
}

async function events(requestedId?: string): Promise<{ client: SseClient; clientId: string }> {
    const query = requestedId ? `?clientId=${requestedId}` : '';
    const client = await SseClient.open(`${base}/events${query}`);
    clients.push(client);
    const hello = await client.next('hello');
    return { client, clientId: (hello.data as { clientId: string }).clientId };
}

beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'whatschat-http-'));
    await startPlugin();
    await api('PUT', '/config', BASE_CONFIG);
});

afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    await plugin.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
});

describe('HTTP API', () => {
    it('serves status', async () => {
        const { status, json } = await api('GET', '/status');
        expect(status).toBe(200);
        expect(json).toMatchObject({ enabled: true, transportKind: 'fake', transport: { state: 'connected' } });
    });

    it('gets and validates config', async () => {
        const got = await api('GET', '/config');
        expect(got.json).toMatchObject({ enabled: true, contacts: [{ id: ALICE }] });

        const bad = await api('PUT', '/config', { contacts: [{ id: '07700', characterAvatar: 'x.png' }] });
        expect(bad.status).toBe(400);
        expect((bad.json as { issues: string[] }).issues[0]).toMatch(/^contacts\.0\.id:/);

        const again = await api('GET', '/config');
        expect(again.json).toEqual(got.json);
    });

    it('persists config across restarts', async () => {
        await plugin.close();
        await new Promise((resolve) => server.close(resolve));
        await startPlugin();
        const { json } = await api('GET', '/config');
        expect(json).toMatchObject({ enabled: true, contacts: [{ id: ALICE, chatFile: 'chat-1' }] });
    });

    it('connects and disconnects', async () => {
        const off = await api('POST', '/disconnect');
        expect(off.json).toMatchObject({ enabled: false, transport: { state: 'disabled' } });
        const on = await api('POST', '/connect');
        expect(on.json).toMatchObject({ enabled: true, transport: { state: 'connected' } });
    });

    it('renders the pairing code as a QR image only while pairing', async () => {
        expect((await api('GET', '/qr')).json).toEqual({ qr: null });
        transport.setStatus({ state: 'pairing', pairingCode: '2@abc,def,ghi' });
        const { json } = await api('GET', '/qr');
        expect((json as { qr: string }).qr).toMatch(/^data:image\/png;base64,/);
    });

    it('rejects malformed batch requests', async () => {
        expect((await api('POST', '/batches/x/claim', {})).status).toBe(400);
        expect((await api('POST', '/batches/x/claim', { clientId: 'nobody' })).status).toBe(409);
        expect((await api('POST', '/batches/x/reply', { clientId: 'nobody', text: 'hi' })).status).toBe(409);
    });
});

describe('event stream and batch flow', () => {
    it('sends hello and status on connect, with streaming-safe headers', async () => {
        const { client } = await events();
        expect(client.response?.headers.get('content-type')).toMatch(/^text\/event-stream/);
        expect(client.response?.headers.get('cache-control')).toContain('no-transform');
        expect((await client.next('status')).data).toMatchObject({ enabled: true });
    });

    it('delivers a batch, accepts a claim and sends the reply', async () => {
        const { client, clientId } = await events();
        transport.receive(ALICE, 'hello?');
        const offer = await client.next('batch');
        const batch = offer.data as { id: string; text: string; characterAvatar: string };
        expect(batch).toMatchObject({ text: 'hello?', characterAvatar: 'Seraphina.png' });

        const claim = await api('POST', `/batches/${batch.id}/claim`, { clientId });
        expect(claim.status).toBe(200);
        expect(claim.json).toMatchObject({ ok: true, batch: { id: batch.id } });

        const reply = await api('POST', `/batches/${batch.id}/reply`, {
            clientId,
            text: 'Seraphina: hi there',
            characterName: 'Seraphina',
        });
        expect(reply).toEqual({ status: 202, json: { ok: true, bubbles: 1 } });
        await waitFor(() => transport.sent().length === 1);
        expect(transport.sent()).toEqual(['hi there']);
    });

    it('lets only one tab claim, and re-offers when that tab closes', async () => {
        const first = await events();
        const second = await events();
        transport.receive(ALICE, 'hi');
        const batch = (await first.client.next('batch')).data as { id: string };
        await second.client.next('batch');

        expect((await api('POST', `/batches/${batch.id}/claim`, { clientId: first.clientId })).status).toBe(200);
        expect((await api('POST', `/batches/${batch.id}/claim`, { clientId: second.clientId })).status).toBe(409);

        first.client.close();
        const reoffer = await second.client.next('batch');
        expect((reoffer.data as { id: string }).id).toBe(batch.id);
        expect((await api('POST', `/batches/${batch.id}/claim`, { clientId: second.clientId })).status).toBe(200);
    });

    it('keeps a claim when the same tab reconnects within the grace period', async () => {
        const tab = await events('tab-0000-aaaa');
        expect(tab.clientId).toBe('tab-0000-aaaa');
        const other = await events();
        transport.receive(ALICE, 'hi');
        const batch = (await tab.client.next('batch')).data as { id: string };
        expect((await api('POST', `/batches/${batch.id}/claim`, { clientId: tab.clientId })).status).toBe(200);

        tab.client.close();
        const back = await events('tab-0000-aaaa');
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(other.client.all('batch').length).toBe(1);
        const reply = await api('POST', `/batches/${batch.id}/reply`, { clientId: back.clientId, text: 'still here' });
        expect(reply.status).toBe(202);
    });

    it('ignores client ids that do not look like ids', async () => {
        const { clientId } = await events('bad id!');
        expect(clientId).not.toBe('bad id!');
    });

    it('replays the pending batch to a tab that connects later', async () => {
        transport.receive(ALICE, 'are you awake?');
        await waitFor(() => plugin.service.status().pendingBatches === 1);
        const { client } = await events();
        expect((await client.next('batch')).data).toMatchObject({ text: 'are you awake?' });
    });

    it('reports failures as dropped batches', async () => {
        const { client, clientId } = await events();
        transport.receive(ALICE, 'hi');
        const batch = (await client.next('batch')).data as { id: string };
        await api('POST', `/batches/${batch.id}/claim`, { clientId });
        const failed = await api('POST', `/batches/${batch.id}/fail`, { clientId, reason: 'API offline' });
        expect(failed.status).toBe(200);
        expect((await client.next('batch-dropped')).data).toEqual({
            batchId: batch.id,
            contactId: ALICE,
            reason: 'failed',
        });
    });

    it('broadcasts config changes', async () => {
        const { client } = await events();
        await api('PUT', '/config', { ...BASE_CONFIG, realistic: { preset: 'quick' } });
        expect((await client.next('config')).data).toMatchObject({ realistic: { preset: 'quick' } });
    });

    it('ends every stream on close and refuses new ones', async () => {
        const { client } = await events();
        await plugin.close();
        await waitFor(() => client.ended);
        const late = await fetch(`${base}/events`);
        expect(late.status).toBe(503);
    });
});

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
    const start = Date.now();
    while (!condition()) {
        if (Date.now() - start > timeoutMs) throw new Error('Timed out');
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}
