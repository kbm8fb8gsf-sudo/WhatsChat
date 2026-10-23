import { resolveNote, resolvePacing } from '../config/resolve.js';
import type { Config, ContactConfig, Pacing } from '../config/schema.js';
import type { SaveResult } from '../config/store.js';
import type { InboundMessage, MessagingTransport, ReplyAddress, TransportStatus } from '../transport/types.js';
import type { Logger } from '../util/logger.js';
import { BatchDispatcher, type DropReason, type InboundBatch } from './batch-dispatcher.js';
import { splitBubbles } from './bubble-splitter.js';
import { ContactQueue, type TimedTask } from './contact-queue.js';
import { findContact, routeInbound } from './contact-router.js';
import { Debouncer } from './debouncer.js';
import { joinBatchText } from './inbound-text.js';
import { planDelivery, planRead } from './pacing.js';
import type { Rng } from './random.js';
import { cleanReply } from './reply-cleaner.js';
import { type Scheduler, sleep } from './scheduler.js';

export interface ConfigSource {
    get(): Config;
    update(updater: (draft: Config) => void): Promise<SaveResult>;
    onChange(listener: (next: Config, previous: Config) => void): () => void;
}

export interface BridgeServiceDeps {
    transport: MessagingTransport;
    config: ConfigSource;
    scheduler: Scheduler;
    rng: Rng;
    logger: Logger;
    newId: () => string;
    /** Delays between send retries. The number of entries is the number of retries. */
    sendRetryDelaysMs?: readonly number[];
    /** How long exit() waits for queued sends before giving up. */
    flushTimeoutMs?: number;
}

/** What the SillyTavern extension needs to handle one batch. */
export interface BatchView {
    readonly id: string;
    readonly contactId: string;
    readonly contactLabel: string;
    readonly pushName: string | null;
    readonly characterAvatar: string;
    readonly chatFile: string | null;
    /** The contact's messages joined into one user message, with macros neutralised if configured. */
    readonly text: string;
    /** Realistic-text system note to inject while generating, or null. */
    readonly note: string | null;
    readonly messageCount: number;
    readonly receivedAt: number;
}

export interface BridgeStatus {
    readonly enabled: boolean;
    readonly transportKind: string;
    readonly transport: TransportStatus;
    readonly pendingBatches: number;
    readonly queuedTasks: number;
}

export type BridgeEvent =
    | { readonly type: 'status'; readonly status: BridgeStatus }
    | { readonly type: 'batch'; readonly batch: BatchView }
    | { readonly type: 'batch-dropped'; readonly batchId: string; readonly contactId: string; readonly reason: DropReason }
    /** SillyTavern wrote to this chat on WhatsApp's behalf; other tabs showing it should reload it. */
    | { readonly type: 'chat-updated'; readonly characterAvatar: string; readonly chatFile: string };

export interface ReplyInput {
    readonly text: string;
    /** The chat the reply was generated in. Saved to the contact if it had none yet. */
    readonly chatFile?: string | undefined;
    readonly characterName?: string | undefined;
    readonly userName?: string | undefined;
}

export type ClaimResponse =
    | { readonly ok: true; readonly batch: BatchView }
    | { readonly ok: false; readonly reason: 'unknown-batch' | 'claimed-by-other' | 'contact-removed' };

export type ReplyResponse =
    | { readonly ok: true; readonly bubbles: number }
    | { readonly ok: false; readonly reason: 'not-claimed' | 'contact-removed' | 'empty-reply' };

export type FailResponse = { readonly ok: true } | { readonly ok: false; readonly reason: 'not-claimed' };

interface BatchRecord {
    readonly typingFrom: number;
    readonly pacing: Pacing;
}

const PAUSED_TAG = 'typing-paused';

/**
 * Wires a transport to SillyTavern: inbound messages → allowlist → debouncer → dispatcher →
 * (extension claims and generates) → reply → cleaner → splitter → pacing → per-contact queue
 * → transport.
 */
export class BridgeService {
    private readonly transport: MessagingTransport;
    private readonly config: ConfigSource;
    private readonly scheduler: Scheduler;
    private readonly rng: Rng;
    private readonly logger: Logger;
    private readonly retryDelays: readonly number[];
    private readonly flushTimeoutMs: number;

    private readonly debouncer: Debouncer<InboundMessage>;
    private readonly dispatcher: BatchDispatcher;
    private readonly queue: ContactQueue;
    private readonly records = new Map<string, BatchRecord>();
    private readonly listeners = new Set<(event: BridgeEvent) => void>();
    private readonly ignoredLogged = new Set<string>();
    private readonly unsubscribers: (() => void)[] = [];
    private started = false;
    private closed = false;

    constructor(deps: BridgeServiceDeps) {
        this.transport = deps.transport;
        this.config = deps.config;
        this.scheduler = deps.scheduler;
        this.rng = deps.rng;
        this.logger = deps.logger;
        this.retryDelays = deps.sendRetryDelaysMs ?? [2_000, 5_000, 15_000];
        this.flushTimeoutMs = deps.flushTimeoutMs ?? 5_000;

        this.queue = new ContactQueue(this.scheduler, this.logger);
        this.debouncer = new Debouncer<InboundMessage>(
            this.scheduler,
            () => this.config.get().inbound,
            (contactId, messages) => {
                this.dispatcher.enqueue(contactId, messages);
                this.emitStatus();
            },
            this.logger,
        );
        this.dispatcher = new BatchDispatcher(
            this.scheduler,
            () => this.config.get().dispatch,
            {
                offer: (batch) => {
                    this.offer(batch);
                },
                drop: (batch, reason) => {
                    this.onDrop(batch, reason);
                },
            },
            this.logger,
            deps.newId,
        );
    }

    /** Subscribe to the transport and config, and connect if the bridge is enabled. */
    start(): void {
        if (this.started || this.closed) return;
        this.started = true;
        this.unsubscribers.push(
            this.transport.onMessage((message) => {
                this.handleInbound(message);
            }),
            this.transport.onStatus(() => {
                this.emitStatus();
            }),
            this.config.onChange((next, previous) => {
                this.onConfigChange(next, previous);
            }),
        );
        if (this.config.get().enabled) this.connectTransport();
    }

    onEvent(listener: (event: BridgeEvent) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    status(): BridgeStatus {
        return {
            enabled: this.config.get().enabled,
            transportKind: this.transport.kind,
            transport: this.transport.getStatus(),
            pendingBatches: this.dispatcher.size,
            queuedTasks: this.queue.pending(),
        };
    }

    /** The batch waiting to be claimed, for a newly connected extension tab. */
    pendingOffer(): BatchView | undefined {
        const batch = this.dispatcher.pendingOffer();
        if (!batch) return undefined;
        const view = this.view(batch);
        if (view) return view;
        this.dispatcher.cancelContact(batch.contactId);
        return this.pendingOffer();
    }

    claim(batchId: string, clientId: string): ClaimResponse {
        const result = this.dispatcher.claim(batchId, clientId);
        if (!result.ok) return result;
        const config = this.config.get();
        const contact = findContact(config, result.batch.contactId);
        const view = contact ? this.view(result.batch) : null;
        if (!contact || !view) {
            this.dispatcher.release(batchId, clientId, 'failed');
            return { ok: false, reason: 'contact-removed' };
        }
        if (result.first) this.planReadAndTyping(result.batch, contact, config);
        return { ok: true, batch: view };
    }

    reply(batchId: string, clientId: string, input: ReplyInput): ReplyResponse {
        if (this.dispatcher.claimant(batchId) !== clientId) return { ok: false, reason: 'not-claimed' };
        const config = this.config.get();
        const released = this.dispatcher.release(batchId, clientId, 'done');
        if (!released.ok) return { ok: false, reason: 'not-claimed' };
        const batch = released.batch;
        const record = this.records.get(batch.id);
        this.records.delete(batch.id);

        const contact = findContact(config, batch.contactId);
        if (!contact?.enabled) {
            this.stopTyping(batch);
            return { ok: false, reason: 'contact-removed' };
        }
        if (input.chatFile && !contact.chatFile) this.rememberChatFile(contact.id, input.chatFile);
        const chatFile = input.chatFile ?? contact.chatFile;
        if (chatFile) this.emit({ type: 'chat-updated', characterAvatar: contact.characterAvatar, chatFile });

        const names = [input.characterName, input.userName].filter((n): n is string => typeof n === 'string');
        const cleaned = cleanReply(input.text, { ...config.cleaner, names });
        const pacing = record?.pacing ?? resolvePacing(config, contact);
        const bubbles = cleaned === '' ? [] : pacing.split ? splitBubbles(cleaned, config.splitter) : [cleaned];
        if (bubbles.length === 0) {
            this.logger.warn(`The reply for ${contact.id} was empty after cleaning; nothing was sent`);
            this.stopTyping(batch);
            this.emitStatus();
            return { ok: false, reason: 'empty-reply' };
        }

        const now = this.scheduler.now();
        const steps = planDelivery({ typingFrom: record?.typingFrom ?? now, replyAt: now, bubbles, pacing, rng: this.rng });
        const replyTo = batch.replyTo;
        const tasks = steps.map((step): TimedTask => {
            const text = bubbles[step.bubble] ?? '';
            return step.kind === 'send'
                ? {
                      at: step.at,
                      label: `send bubble ${String(step.bubble + 1)}/${String(bubbles.length)}`,
                      essential: true,
                      tag: batch.id,
                      run: () => this.sendWithRetry(replyTo, text),
                  }
                : {
                      at: step.at,
                      label: `typing bubble ${String(step.bubble + 1)}`,
                      essential: false,
                      tag: batch.id,
                      run: () => this.bestEffort('typing', () => this.transport.setTyping(replyTo, 'typing')),
                  };
        });
        this.queue.schedule(batch.contactId, tasks);
        this.emitStatus();
        return { ok: true, bubbles: bubbles.length };
    }

    /** The extension couldn't produce a reply. The batch is dropped. */
    fail(batchId: string, clientId: string, reason: string, chatFile?: string): FailResponse {
        const claimant = this.dispatcher.claimant(batchId);
        if (claimant !== clientId) return { ok: false, reason: 'not-claimed' };
        this.logger.warn(`SillyTavern could not reply to batch ${batchId}: ${reason}`);
        const released = this.dispatcher.release(batchId, clientId, 'failed');
        // The contact's message may already be in the chat even though no reply was written.
        const contact = released.ok ? findContact(this.config.get(), released.batch.contactId) : undefined;
        if (contact && chatFile) this.emit({ type: 'chat-updated', characterAvatar: contact.characterAvatar, chatFile });
        this.emitStatus();
        return { ok: true };
    }

    /** An extension tab disconnected. */
    clientGone(clientId: string): void {
        this.dispatcher.clientGone(clientId);
    }

    /** Enable the bridge (persisted) and connect. */
    async connect(): Promise<void> {
        if (this.config.get().enabled) {
            this.connectTransport();
            return;
        }
        await this.config.update((draft) => {
            draft.enabled = true;
        });
    }

    /** Disable the bridge (persisted) and disconnect, keeping the session. */
    async disconnect(): Promise<void> {
        if (!this.config.get().enabled) return;
        await this.config.update((draft) => {
            draft.enabled = false;
        });
    }

    /** Unlink the device, delete the session and disable the bridge. */
    async logout(): Promise<void> {
        this.dropEverything();
        await this.transport.logout();
        await this.disconnect();
        this.emitStatus();
    }

    /** exit(): send what's queued (briefly), cancel the rest, close the connection, clear timers. */
    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
        this.debouncer.cancelAll();
        this.dispatcher.dispose();
        this.records.clear();
        await this.queue.flush(this.flushTimeoutMs);
        try {
            await this.transport.disconnect();
        } catch (error) {
            this.logger.error('Error while disconnecting', error);
        }
        this.listeners.clear();
    }

    // ---- internals ----

    private handleInbound(message: InboundMessage): void {
        if (this.closed) return;
        const decision = routeInbound(this.config.get(), message.contactId);
        if (decision.kind === 'ignore') {
            this.logIgnored(message, decision.reason);
            return;
        }
        this.debouncer.push(decision.contact.id, message);
    }

    private logIgnored(message: InboundMessage, reason: string): void {
        if (reason !== 'not-allowlisted') {
            this.logger.debug(`Ignored a message from ${message.contactId}: ${reason}`);
            return;
        }
        if (this.ignoredLogged.has(message.contactId)) return;
        if (this.ignoredLogged.size < 1_000) this.ignoredLogged.add(message.contactId);
        this.logger.info(`Ignored a message from ${message.contactId}: not on the allowlist`);
    }

    private offer(batch: InboundBatch): void {
        const view = this.view(batch);
        if (!view) {
            this.dispatcher.cancelContact(batch.contactId);
            return;
        }
        this.emit({ type: 'batch', batch: view });
        this.emitStatus();
    }

    private view(batch: InboundBatch): BatchView | null {
        const config = this.config.get();
        const contact = findContact(config, batch.contactId);
        if (!contact) return null;
        const first = batch.messages[0];
        const last = batch.messages.at(-1);
        return {
            id: batch.id,
            contactId: contact.id,
            contactLabel: contact.label,
            pushName: last?.pushName ?? null,
            characterAvatar: contact.characterAvatar,
            chatFile: contact.chatFile ?? null,
            text: joinBatchText(
                batch.messages.map((m) => m.text),
                config.inbound,
            ),
            note: resolveNote(config, contact),
            messageCount: batch.messages.length,
            receivedAt: first?.timestamp ?? batch.readyAt,
        };
    }

    private planReadAndTyping(batch: InboundBatch, contact: ContactConfig, config: Config): void {
        const pacing = resolvePacing(config, contact);
        const plan = planRead({ batchReadyAt: batch.readyAt, claimedAt: this.scheduler.now(), pacing, rng: this.rng });
        this.records.set(batch.id, { typingFrom: plan.typingFrom, pacing });
        const refs = batch.messages.map((m) => m.ref);
        const replyTo = batch.replyTo;
        const tasks: TimedTask[] = [
            { at: plan.readAt, label: 'mark read', essential: false, tag: batch.id, run: () => this.bestEffort('mark read', () => this.transport.markRead(refs)) },
        ];
        if (pacing.showTyping) {
            tasks.push({
                at: plan.typingFrom,
                label: 'typing bubble 1',
                essential: false,
                tag: batch.id,
                run: () => this.bestEffort('typing', () => this.transport.setTyping(replyTo, 'typing')),
            });
        }
        this.queue.schedule(batch.contactId, tasks);
    }

    private onDrop(batch: InboundBatch, reason: DropReason): void {
        this.records.delete(batch.id);
        this.stopTyping(batch);
        if (reason === 'stale') this.logger.info(`Dropped a batch from ${batch.contactId}: it was too old`);
        this.emit({ type: 'batch-dropped', batchId: batch.id, contactId: batch.contactId, reason });
        this.emitStatus();
    }

    /** Cancel a batch's pending read/typing and make sure no typing indicator is left showing. */
    private stopTyping(batch: InboundBatch): void {
        this.queue.cancel(batch.contactId, (task) => task.tag === batch.id && !task.essential);
        if (this.transport.getStatus().state !== 'connected') return;
        const replyTo = batch.replyTo;
        this.queue.schedule(batch.contactId, [
            {
                at: 0,
                label: 'typing paused',
                essential: false,
                tag: PAUSED_TAG,
                run: () => this.bestEffort('stop typing', () => this.transport.setTyping(replyTo, 'paused')),
            },
        ]);
    }

    /** Read receipts and typing are cosmetic: a failure is logged but never cancels the reply. */
    private async bestEffort(action: string, fn: () => Promise<void>): Promise<void> {
        try {
            await fn();
        } catch (error) {
            this.logger.debug(`Could not ${action}`, error);
        }
    }

    private async sendWithRetry(to: ReplyAddress, text: string): Promise<void> {
        for (let attempt = 0; ; attempt++) {
            try {
                await this.transport.sendText(to, text);
                return;
            } catch (error) {
                const delay = this.retryDelays[attempt];
                if (delay === undefined || this.closed) throw error;
                this.logger.warn(`Sending failed, retrying in ${String(Math.round(delay / 1000))}s`, error);
                await sleep(this.scheduler, delay);
            }
        }
    }

    private rememberChatFile(contactId: string, chatFile: string): void {
        this.config
            .update((draft) => {
                const contact = draft.contacts.find((c) => c.id === contactId);
                if (contact && !contact.chatFile) contact.chatFile = chatFile;
            })
            .then((result) => {
                if (!result.ok) this.logger.error(`Could not save the chat for ${contactId}`, result.issues);
            })
            .catch((error: unknown) => {
                this.logger.error(`Could not save the chat for ${contactId}`, error);
            });
    }

    private onConfigChange(next: Config, previous: Config): void {
        if (next.enabled && !previous.enabled) this.connectTransport();
        if (!next.enabled && previous.enabled) {
            this.dropEverything();
            if (this.transport.getStatus().state !== 'logged_out') {
                this.transport.disconnect().catch((error: unknown) => {
                    this.logger.error('Error while disconnecting', error);
                });
            }
        }
        for (const old of previous.contacts) {
            const current = next.contacts.find((c) => c.id === old.id);
            if (!current?.enabled) {
                this.debouncer.cancel(old.id);
                this.dispatcher.cancelContact(old.id);
                this.queue.cancel(old.id);
            }
        }
        this.emitStatus();
    }

    private dropEverything(): void {
        this.debouncer.cancelAll();
        this.dispatcher.cancelAll();
        this.queue.cancelAll();
        this.records.clear();
    }

    private connectTransport(): void {
        this.transport.connect().catch((error: unknown) => {
            this.logger.error('Could not connect', error);
        });
    }

    private emitStatus(): void {
        this.emit({ type: 'status', status: this.status() });
    }

    private emit(event: BridgeEvent): void {
        for (const listener of this.listeners) {
            try {
                listener(event);
            } catch (error) {
                this.logger.error('Event listener failed', error);
            }
        }
    }
}
