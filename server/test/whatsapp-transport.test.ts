import { Boom } from '@hapi/boom';
import type { BaileysEventMap, WAMessageKey } from 'baileys';
import { DisconnectReason } from 'baileys';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { createRng } from '../src/core/random.js';
import { systemScheduler } from '../src/core/scheduler.js';
import type { InboundMessage, TransportStatus } from '../src/transport/types.js';
import { TransportUnavailableError } from '../src/transport/types.js';
import { type SocketFactoryArgs, type SocketLike, WhatsAppTransport } from '../src/transport/whatsapp.js';
import { silentLogger } from '../src/util/logger.js';

const PN = '447700900123@s.whatsapp.net';
const TO = { transport: 'whatsapp', id: PN };

class FakeSocket implements SocketLike {
    private readonly handlers: ((events: Partial<BaileysEventMap>) => void | Promise<void>)[] = [];
    readonly presence: string[] = [];
    user = { id: '447700900999:4@s.whatsapp.net' };
    ev = {
        process: (handler: (events: Partial<BaileysEventMap>) => void | Promise<void>) => {
            this.handlers.push(handler);
            return () => undefined;
        },
    };
    sendMessage = vi.fn((jid: string, content: { text: string }) =>
        Promise.resolve({ key: { id: `sent-${content.text}`, remoteJid: jid }, message: { conversation: content.text } }),
    );
    sendPresenceUpdate = vi.fn((type: string, jid?: string) => {
        this.presence.push(jid ? `${type}:${jid}` : type);
        return Promise.resolve();
    });
    readMessages = vi.fn<(keys: WAMessageKey[]) => Promise<void>>(() => Promise.resolve());
    logout = vi.fn(() => Promise.resolve());
    end = vi.fn(() => Promise.resolve());
    signalRepository = { lidMapping: { getPNForLID: vi.fn(() => Promise.resolve<string | null>(null)) } };

    async emit(events: Partial<BaileysEventMap>): Promise<void> {
        for (const handler of this.handlers) await handler(events);
    }

    open(): Promise<void> {
        return this.emit({ 'connection.update': { connection: 'open' } });
    }

    close(statusCode: number): Promise<void> {
        return this.emit({
            'connection.update': {
                connection: 'close',
                lastDisconnect: { error: new Boom('closed', { statusCode }), date: new Date() },
            },
        });
    }
}

let dir: string;
let authDir: string;
let sockets: FakeSocket[];
let factoryArgs: SocketFactoryArgs[];
let saveCreds: Mock<() => Promise<void>>;
let factoryError: Error | null;
let transport: WhatsAppTransport;
let statuses: TransportStatus[];
let inbound: InboundMessage[];
let settings: { markOnlineOnConnect: boolean; mediaPlaceholders: boolean };

beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'whatschat-wa-'));
    authDir = path.join(dir, 'auth');
    sockets = [];
    factoryArgs = [];
    factoryError = null;
    saveCreds = vi.fn<() => Promise<void>>(() => Promise.resolve());
    settings = { markOnlineOnConnect: false, mediaPlaceholders: true };
    vi.useFakeTimers({ now: 0, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    transport = new WhatsAppTransport({
        authDir,
        scheduler: systemScheduler,
        logger: silentLogger,
        settings: () => settings,
        rng: createRng(1),
        backoff: { baseMs: 1_000, factor: 2, maxMs: 60_000, jitter: 0 },
        createSocket: (args) => {
            factoryArgs.push(args);
            if (factoryError) return Promise.reject(factoryError);
            const socket = new FakeSocket();
            sockets.push(socket);
            return Promise.resolve({ socket, saveCreds });
        },
    });
    statuses = [];
    inbound = [];
    transport.onStatus((s) => statuses.push(s));
    transport.onMessage((m) => inbound.push(m));
});

afterEach(async () => {
    await transport.disconnect();
    vi.useRealTimers();
    await rm(dir, { recursive: true, force: true });
});

function socket(index = -1): FakeSocket {
    const s = sockets.at(index);
    if (!s) throw new Error('no socket');
    return s;
}

async function connected(): Promise<FakeSocket> {
    await transport.connect();
    await socket().open();
    return socket();
}

describe('WhatsAppTransport connection', () => {
    it('goes through connecting, pairing and connected, creating a private session folder', async () => {
        await transport.connect();
        expect(statuses.map((s) => s.state)).toEqual(['connecting']);
        expect(((await stat(authDir)).mode & 0o777).toString(8)).toBe('700');
        expect(factoryArgs[0]).toMatchObject({ authDir, markOnlineOnConnect: false });

        await socket().emit({ 'connection.update': { qr: '2@abc' } });
        expect(transport.getStatus()).toEqual({ state: 'pairing', pairingCode: '2@abc' });

        await socket().open();
        expect(transport.getStatus()).toEqual({ state: 'connected', self: '+447700900999' });
    });

    it('saves credentials when they change', async () => {
        const s = await connected();
        await s.emit({ 'creds.update': {} });
        expect(saveCreds).toHaveBeenCalledOnce();
    });

    it('reconnects with backoff after a dropped connection, ignoring the old socket', async () => {
        const first = await connected();
        await first.close(DisconnectReason.connectionLost);
        expect(transport.getStatus()).toMatchObject({ state: 'reconnecting', attempt: 1, nextRetryAt: 1_000 });

        await vi.advanceTimersByTimeAsync(999);
        expect(sockets.length).toBe(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(sockets.length).toBe(2);
        // The reason stays visible while retrying.
        expect(transport.getStatus()).toEqual({ state: 'reconnecting', attempt: 1, error: 'closed (408)' });

        await first.emit({ 'messages.upsert': { type: 'notify', messages: [textMessage('stale')] } });
        expect(inbound).toEqual([]);

        await socket().close(DisconnectReason.connectionClosed);
        expect(transport.getStatus()).toMatchObject({ attempt: 2, nextRetryAt: 1_000 + 2_000 });
        await vi.advanceTimersByTimeAsync(2_000);
        await socket().open();
        expect(transport.getStatus().state).toBe('connected');
    });

    it('retries when the socket cannot even be created', async () => {
        factoryError = new Error('no network');
        await transport.connect();
        expect(transport.getStatus()).toMatchObject({ state: 'reconnecting', attempt: 1, error: 'no network' });
        factoryError = null;
        await vi.advanceTimersByTimeAsync(1_000);
        expect(sockets.length).toBe(1);
    });

    it('reopens immediately when WhatsApp asks for a restart after pairing', async () => {
        await transport.connect();
        await socket().close(DisconnectReason.restartRequired);
        expect(sockets.length).toBe(2);
        expect(transport.getStatus().state).toBe('connecting');
    });

    it('stops and deletes the session when the phone unlinks the device', async () => {
        const s = await connected();
        await writeFile(path.join(authDir, 'creds.json'), '{}');
        await s.close(DisconnectReason.loggedOut);
        expect(transport.getStatus().state).toBe('logged_out');
        await expect(stat(authDir)).rejects.toThrow();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(sockets.length).toBe(1);
    });

    it('does not fight another session that replaced this one', async () => {
        const s = await connected();
        await s.close(DisconnectReason.connectionReplaced);
        expect(transport.getStatus().state).toBe('error');
        await vi.advanceTimersByTimeAsync(60_000);
        expect(sockets.length).toBe(1);
    });

    it('disconnect closes the socket, keeps the session and never reconnects', async () => {
        const s = await connected();
        await writeFile(path.join(authDir, 'creds.json'), '{}');
        await transport.disconnect();
        expect(s.end).toHaveBeenCalledOnce();
        expect(transport.getStatus().state).toBe('disabled');
        await s.close(DisconnectReason.connectionClosed);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(sockets.length).toBe(1);
        await expect(stat(path.join(authDir, 'creds.json'))).resolves.toBeDefined();
    });

    it('logout unlinks the device and deletes the session', async () => {
        const s = await connected();
        await writeFile(path.join(authDir, 'creds.json'), '{}');
        await transport.logout();
        expect(s.logout).toHaveBeenCalledOnce();
        expect(transport.getStatus().state).toBe('logged_out');
        await expect(stat(authDir)).rejects.toThrow();
    });

    it('connect after logout pairs again', async () => {
        await connected();
        await transport.logout();
        await transport.connect();
        expect(sockets.length).toBe(2);
    });
});

describe('WhatsAppTransport messages', () => {
    it('emits 1:1 text messages and resolves LIDs to phone numbers', async () => {
        const s = await connected();
        s.signalRepository.lidMapping.getPNForLID.mockResolvedValue(PN);
        await s.emit({
            'messages.upsert': {
                type: 'notify',
                messages: [textMessage('hi'), textMessage('via lid', '555@lid'), textMessage('mine', PN, true)],
            },
        });
        expect(inbound.map((m) => [m.contactId, m.text, m.replyTo.id])).toEqual([
            ['+447700900123', 'hi', PN],
            ['+447700900123', 'via lid', '555@lid'],
        ]);
    });

    it('ignores history appends', async () => {
        const s = await connected();
        await s.emit({ 'messages.upsert': { type: 'append', messages: [textMessage('old')] } });
        expect(inbound).toEqual([]);
    });

    it('contains errors thrown by a message handler', async () => {
        const s = await connected();
        transport.onMessage(() => {
            throw new Error('handler broke');
        });
        await expect(
            s.emit({ 'messages.upsert': { type: 'notify', messages: [textMessage('hi')] } }),
        ).resolves.toBeUndefined();
        expect(inbound.length).toBe(1);
    });

    it('refuses to send while not connected', async () => {
        await expect(transport.sendText(TO, 'hi')).rejects.toBeInstanceOf(TransportUnavailableError);
        await transport.connect();
        await expect(transport.sendText(TO, 'hi')).rejects.toBeInstanceOf(TransportUnavailableError);
    });

    it('sends text and can hand it back for a delivery retry', async () => {
        const s = await connected();
        await transport.sendText(TO, 'hello');
        expect(s.sendMessage).toHaveBeenCalledWith(PN, { text: 'hello' });
        const getMessage = factoryArgs[0]?.getMessage;
        expect(await getMessage?.({ id: 'sent-hello' })).toEqual({ conversation: 'hello' });
        expect(await getMessage?.({ id: 'unknown' })).toBeUndefined();
    });

    it('marks messages read after going online', async () => {
        const s = await connected();
        await transport.markRead([{ chatId: PN, messageId: 'A' }]);
        expect(s.presence).toEqual(['available']);
        expect(s.readMessages).toHaveBeenCalledWith([{ remoteJid: PN, id: 'A', fromMe: false }]);
    });
});

describe('WhatsAppTransport presence', () => {
    it('keeps "typing\u2026" alive until a message is sent', async () => {
        const s = await connected();
        await transport.setTyping(TO, 'typing');
        expect(s.presence).toEqual(['available', `composing:${PN}`]);
        await vi.advanceTimersByTimeAsync(8_000);
        await vi.advanceTimersByTimeAsync(8_000);
        expect(s.presence.filter((p) => p.startsWith('composing')).length).toBe(3);
        await transport.sendText(TO, 'done');
        await vi.advanceTimersByTimeAsync(16_000);
        expect(s.presence.filter((p) => p.startsWith('composing')).length).toBe(3);
    });

    it('sends paused only if it was typing', async () => {
        const s = await connected();
        await transport.setTyping(TO, 'paused');
        expect(s.presence).toEqual([]);
        await transport.setTyping(TO, 'typing');
        await transport.setTyping(TO, 'paused');
        expect(s.presence.at(-1)).toBe(`paused:${PN}`);
    });

    it('stops typing on its own after the safety cap', async () => {
        const s = await connected();
        await transport.setTyping(TO, 'typing');
        await vi.advanceTimersByTimeAsync(3 * 60_000 + 8_000);
        expect(s.presence).toContain(`paused:${PN}`);
        const count = s.presence.length;
        await vi.advanceTimersByTimeAsync(60_000);
        expect(s.presence.slice(count).filter((p) => p.startsWith('composing'))).toEqual([]);
    });

    it('goes back offline after a quiet spell so the phone gets notifications', async () => {
        const s = await connected();
        await transport.markRead([{ chatId: PN, messageId: 'A' }]);
        await vi.advanceTimersByTimeAsync(19_999);
        expect(s.presence).toEqual(['available']);
        await vi.advanceTimersByTimeAsync(1);
        expect(s.presence).toEqual(['available', 'unavailable']);
    });

    it('stays online when configured to', async () => {
        settings.markOnlineOnConnect = true;
        const s = await connected();
        await transport.markRead([{ chatId: PN, messageId: 'A' }]);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(s.presence).toEqual(['available']);
    });

    it('clears every timer on disconnect', async () => {
        await connected();
        await transport.setTyping(TO, 'typing');
        await transport.disconnect();
        expect(vi.getTimerCount()).toBe(0);
    });
});

function textMessage(text: string, jid = PN, fromMe = false): BaileysEventMap['messages.upsert']['messages'][number] {
    return {
        key: { remoteJid: jid, id: `id-${text}`, fromMe },
        messageTimestamp: 1_760_000_000,
        message: { conversation: text },
    };
}
