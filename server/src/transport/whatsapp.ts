import { mkdir, rm } from 'node:fs/promises';
import type { BaileysEventMap, proto, WAMessageKey, WAPresence } from 'baileys';
import { DisconnectReason } from 'baileys';
import { createRng, randomSeed, type Rng } from '../core/random.js';
import type { Scheduler, TimerHandle } from '../core/scheduler.js';
import type { Logger } from '../util/logger.js';
import { type BackoffOptions, backoffDelay, DEFAULT_BACKOFF } from './backoff.js';
import type {
    InboundMessage,
    MessageRef,
    MessagingTransport,
    ReplyAddress,
    TransportStatus,
    TypingState,
} from './types.js';
import { TransportUnavailableError } from './types.js';
import { toInboundMessage } from './whatsapp-mapping.js';

/** The parts of a Baileys socket this transport uses, so tests can supply a fake. */
export interface SocketLike {
    ev: { process(handler: (events: Partial<BaileysEventMap>) => void | Promise<void>): () => void };
    user?: { id: string } | undefined;
    sendMessage(jid: string, content: { text: string }): Promise<{ key: WAMessageKey; message?: proto.IMessage | null } | undefined>;
    sendPresenceUpdate(type: WAPresence, toJid?: string): Promise<void>;
    readMessages(keys: WAMessageKey[]): Promise<void>;
    logout(msg?: string): Promise<void>;
    end(error: Error | undefined): Promise<void> | void;
    signalRepository: { lidMapping: { getPNForLID(lid: string): Promise<string | null> } };
}

export interface SocketFactoryArgs {
    authDir: string;
    markOnlineOnConnect: boolean;
    logger: Logger;
    /** Looks up messages we sent, so WhatsApp can retry delivering them. */
    getMessage: (key: WAMessageKey) => Promise<proto.IMessage | undefined>;
}

export type SocketFactory = (args: SocketFactoryArgs) => Promise<{ socket: SocketLike; saveCreds: () => Promise<void> }>;

export interface WhatsAppSettings {
    markOnlineOnConnect: boolean;
    mediaPlaceholders: boolean;
}

export interface WhatsAppTransportOptions {
    authDir: string;
    scheduler: Scheduler;
    logger: Logger;
    settings: () => WhatsAppSettings;
    createSocket: SocketFactory;
    rng?: Rng;
    backoff?: BackoffOptions;
    /** WhatsApp drops "typing…" after about 10 s, so it's re-sent this often. */
    typingRefreshMs?: number;
    /** Safety cap: stop showing "typing…" after this long even if nobody said stop. */
    typingMaxMs?: number;
    /** After this long without activity, go back offline so the phone gets notifications again. */
    onlineLingerMs?: number;
}

interface TypingTimer {
    timer: TimerHandle;
    startedAt: number;
}

const SENT_CACHE_SIZE = 500;

/**
 * WhatsApp via Baileys. The only code in the project that knows about WhatsApp.
 * Every Baileys callback is contained: SillyTavern shuts down on an uncaught exception.
 */
export class WhatsAppTransport implements MessagingTransport {
    readonly kind = 'whatsapp';

    private status: TransportStatus = { state: 'disabled' };
    private socket: SocketLike | null = null;
    private connected = false;
    /** Incremented for every socket, so events from an old socket are ignored. */
    private generation = 0;
    /** Whether we should be connected (and therefore reconnect after a drop). */
    private wanted = false;
    private attempt = 0;
    private reconnectTimer: TimerHandle | null = null;
    private readonly typing = new Map<string, TypingTimer>();
    private online = false;
    private onlineTimer: TimerHandle | null = null;
    private readonly sent = new Map<string, proto.IMessage>();
    private readonly messageHandlers = new Set<(message: InboundMessage) => void>();
    private readonly statusHandlers = new Set<(status: TransportStatus) => void>();

    private readonly scheduler: Scheduler;
    private readonly logger: Logger;
    private readonly rng: Rng;
    private readonly backoff: BackoffOptions;
    private readonly typingRefreshMs: number;
    private readonly typingMaxMs: number;
    private readonly onlineLingerMs: number;

    constructor(private readonly options: WhatsAppTransportOptions) {
        this.scheduler = options.scheduler;
        this.logger = options.logger;
        this.rng = options.rng ?? createRng(randomSeed());
        this.backoff = options.backoff ?? DEFAULT_BACKOFF;
        this.typingRefreshMs = options.typingRefreshMs ?? 8_000;
        this.typingMaxMs = options.typingMaxMs ?? 3 * 60_000;
        this.onlineLingerMs = options.onlineLingerMs ?? 20_000;
    }

    async connect(): Promise<void> {
        if (this.wanted && this.status.state !== 'logged_out' && this.status.state !== 'error') return;
        this.wanted = true;
        this.attempt = 0;
        try {
            // Private: the session folder holds the keys to this WhatsApp account.
            await mkdir(this.options.authDir, { recursive: true, mode: 0o700 });
        } catch (error) {
            this.wanted = false;
            this.setStatus({ state: 'error', error: `Cannot create the session folder: ${describeError(error)}` });
            return;
        }
        await this.open();
    }

    async disconnect(): Promise<void> {
        this.wanted = false;
        const socket = this.detach();
        if (socket) await this.safely('closing the connection', () => socket.end(undefined));
        this.setStatus({ state: 'disabled' });
    }

    async logout(): Promise<void> {
        this.wanted = false;
        const socket = this.detach();
        if (socket) {
            await this.safely('logging out', () => socket.logout());
            await this.safely('closing the connection', () => socket.end(undefined));
        }
        await this.safely('deleting the session', () => rm(this.options.authDir, { recursive: true, force: true }));
        this.setStatus({ state: 'logged_out' });
    }

    onMessage(handler: (message: InboundMessage) => void): () => void {
        this.messageHandlers.add(handler);
        return () => this.messageHandlers.delete(handler);
    }

    onStatus(handler: (status: TransportStatus) => void): () => void {
        this.statusHandlers.add(handler);
        return () => this.statusHandlers.delete(handler);
    }

    getStatus(): TransportStatus {
        return this.status;
    }

    async sendText(to: ReplyAddress, text: string): Promise<void> {
        const socket = this.requireSocket();
        this.stopTypingTimer(to.id);
        const sent = await socket.sendMessage(to.id, { text });
        if (sent?.key.id && sent.message) this.rememberSent(sent.key.id, sent.message);
        this.touchOnline();
    }

    async setTyping(to: ReplyAddress, state: TypingState): Promise<void> {
        const socket = this.requireSocket();
        if (state === 'paused') {
            const wasTyping = this.stopTypingTimer(to.id);
            if (wasTyping) await socket.sendPresenceUpdate('paused', to.id);
            return;
        }
        await this.goOnline(socket);
        await socket.sendPresenceUpdate('composing', to.id);
        if (!this.typing.has(to.id)) this.scheduleTypingRefresh(to.id, this.scheduler.now());
    }

    async markRead(refs: readonly MessageRef[]): Promise<void> {
        if (refs.length === 0) return;
        const socket = this.requireSocket();
        await this.goOnline(socket);
        await socket.readMessages(
            refs.map((ref) => ({
                remoteJid: ref.chatId,
                id: ref.messageId,
                fromMe: false,
                ...(ref.participantId ? { participant: ref.participantId } : {}),
            })),
        );
        this.touchOnline();
    }

    // ---- connection lifecycle ----

    private async open(): Promise<void> {
        this.clearReconnectTimer();
        const generation = ++this.generation;
        const previousError = this.status.error;
        this.setStatus(
            this.attempt > 0
                ? { state: 'reconnecting', attempt: this.attempt, ...(previousError ? { error: previousError } : {}) }
                : { state: 'connecting' },
        );

        let created: Awaited<ReturnType<SocketFactory>>;
        try {
            created = await this.options.createSocket({
                authDir: this.options.authDir,
                markOnlineOnConnect: this.options.settings().markOnlineOnConnect,
                logger: this.logger,
                getMessage: (key) => Promise.resolve(key.id ? this.sent.get(key.id) : undefined),
            });
        } catch (error) {
            if (generation === this.generation && this.wanted) this.scheduleReconnect(error);
            return;
        }

        const { socket, saveCreds } = created;
        if (generation !== this.generation || !this.wanted) {
            // disconnect() or logout() ran while the socket was being created.
            await this.safely('closing a stale connection', () => socket.end(undefined));
            return;
        }
        this.socket = socket;
        socket.ev.process(async (events) => {
            if (generation !== this.generation) return;
            try {
                await this.handleEvents(events, socket, saveCreds);
            } catch (error) {
                this.logger.error('Error handling a WhatsApp event', error);
            }
        });
    }

    private async handleEvents(
        events: Partial<BaileysEventMap>,
        socket: SocketLike,
        saveCreds: () => Promise<void>,
    ): Promise<void> {
        if (events['creds.update']) await this.safely('saving the session', saveCreds);
        const update = events['connection.update'];
        if (update) await this.handleConnectionUpdate(update, socket);
        const upsert = events['messages.upsert'];
        if (upsert?.type === 'notify') {
            for (const raw of upsert.messages) await this.handleIncoming(raw, socket);
        }
    }

    private async handleConnectionUpdate(update: BaileysEventMap['connection.update'], socket: SocketLike): Promise<void> {
        if (update.qr) this.setStatus({ state: 'pairing', pairingCode: update.qr });
        if (update.connection === 'open') {
            this.attempt = 0;
            this.connected = true;
            this.setStatus({ state: 'connected', ...(socket.user ? { self: formatSelf(socket.user.id) } : {}) });
            return;
        }
        if (update.connection !== 'close') return;

        this.detach();
        const code = statusCode(update.lastDisconnect?.error);
        if (!this.wanted) {
            this.setStatus({ state: 'disabled' });
            return;
        }
        if (code === DisconnectReason.loggedOut) {
            this.wanted = false;
            await this.safely('deleting the session', () => rm(this.options.authDir, { recursive: true, force: true }));
            this.setStatus({ state: 'logged_out', error: 'WhatsApp unlinked this device. Connect again to pair.' });
            return;
        }
        if (code === DisconnectReason.connectionReplaced) {
            this.wanted = false;
            this.setStatus({
                state: 'error',
                error: 'Another session using this WhatsApp link took over. Connect again to take it back.',
            });
            return;
        }
        if (code === DisconnectReason.restartRequired) {
            // Normal right after pairing: WhatsApp asks for a fresh connection.
            this.attempt = 0;
            await this.open();
            return;
        }
        this.scheduleReconnect(update.lastDisconnect?.error);
    }

    private async handleIncoming(raw: BaileysEventMap['messages.upsert']['messages'][number], socket: SocketLike): Promise<void> {
        const message = await toInboundMessage(raw, {
            resolvePhoneJid: (lid) => socket.signalRepository.lidMapping.getPNForLID(lid),
            mediaPlaceholders: this.options.settings().mediaPlaceholders,
        });
        if (!message) return;
        for (const handler of this.messageHandlers) {
            try {
                handler(message);
            } catch (error) {
                this.logger.error('Inbound message handler failed', error);
            }
        }
    }

    private scheduleReconnect(error: unknown): void {
        this.attempt++;
        const delay = backoffDelay(this.attempt, this.backoff, this.rng);
        const reason = describeError(error);
        this.logger.warn(`WhatsApp connection lost (${reason}); retrying in ${String(Math.round(delay / 1000))}s`);
        this.setStatus({
            state: 'reconnecting',
            attempt: this.attempt,
            nextRetryAt: this.scheduler.now() + delay,
            error: reason,
        });
        this.reconnectTimer = this.scheduler.setTimeout(() => {
            this.reconnectTimer = null;
            void this.open();
        }, delay);
    }

    /** Forget the current socket and everything tied to it. Returns it so the caller can close it. */
    private detach(): SocketLike | null {
        this.generation++;
        this.clearReconnectTimer();
        for (const id of [...this.typing.keys()]) this.stopTypingTimer(id);
        if (this.onlineTimer) this.scheduler.clearTimeout(this.onlineTimer);
        this.onlineTimer = null;
        this.online = false;
        this.connected = false;
        const socket = this.socket;
        this.socket = null;
        return socket;
    }

    private clearReconnectTimer(): void {
        if (this.reconnectTimer) this.scheduler.clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
    }

    private requireSocket(): SocketLike {
        if (!this.socket || !this.connected) throw new TransportUnavailableError();
        return this.socket;
    }

    // ---- presence ----

    private scheduleTypingRefresh(jid: string, startedAt: number): void {
        const timer = this.scheduler.setTimeout(() => {
            const socket = this.socket;
            if (!socket || !this.connected || this.scheduler.now() - startedAt >= this.typingMaxMs) {
                this.typing.delete(jid);
                if (socket && this.connected) void this.safely('stopping typing', () => socket.sendPresenceUpdate('paused', jid));
                return;
            }
            this.touchOnline();
            void this.safely('refreshing typing', () => socket.sendPresenceUpdate('composing', jid));
            this.scheduleTypingRefresh(jid, startedAt);
        }, this.typingRefreshMs);
        this.typing.set(jid, { timer, startedAt });
    }

    private stopTypingTimer(jid: string): boolean {
        const entry = this.typing.get(jid);
        if (!entry) return false;
        this.scheduler.clearTimeout(entry.timer);
        this.typing.delete(jid);
        return true;
    }

    /** Typing indicators and read receipts only show while we're "online". */
    private async goOnline(socket: SocketLike): Promise<void> {
        if (!this.online) {
            await socket.sendPresenceUpdate('available');
            this.online = true;
        }
        this.touchOnline();
    }

    private touchOnline(): void {
        if (!this.online || this.options.settings().markOnlineOnConnect) return;
        if (this.onlineTimer) this.scheduler.clearTimeout(this.onlineTimer);
        this.onlineTimer = this.scheduler.setTimeout(() => {
            this.onlineTimer = null;
            if (this.typing.size > 0) {
                this.touchOnline();
                return;
            }
            const socket = this.socket;
            this.online = false;
            if (socket && this.connected) void this.safely('going offline', () => socket.sendPresenceUpdate('unavailable'));
        }, this.onlineLingerMs);
    }

    private rememberSent(id: string, message: proto.IMessage): void {
        this.sent.set(id, message);
        if (this.sent.size > SENT_CACHE_SIZE) {
            const oldest = this.sent.keys().next();
            if (!oldest.done) this.sent.delete(oldest.value);
        }
    }

    private setStatus(status: TransportStatus): void {
        this.status = status;
        for (const handler of this.statusHandlers) {
            try {
                handler(status);
            } catch (error) {
                this.logger.error('Status handler failed', error);
            }
        }
    }

    private async safely(action: string, fn: () => unknown): Promise<void> {
        try {
            await fn();
        } catch (error) {
            this.logger.warn(`Error while ${action}`, error);
        }
    }
}

function statusCode(error: unknown): number | undefined {
    if (typeof error !== 'object' || error === null || !('output' in error)) return undefined;
    const output = (error as { output?: { statusCode?: unknown } }).output;
    return typeof output?.statusCode === 'number' ? output.statusCode : undefined;
}

function describeError(error: unknown): string {
    const code = statusCode(error);
    const message = error instanceof Error ? error.message : 'connection closed';
    return code === undefined ? message : `${message} (${String(code)})`;
}

/** "447700900123:5@s.whatsapp.net" → "+447700900123". */
function formatSelf(jid: string): string {
    const user = /^(\d+)/.exec(jid)?.[1];
    return user ? `+${user}` : jid;
}
