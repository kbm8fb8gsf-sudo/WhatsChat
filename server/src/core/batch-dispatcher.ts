import type { InboundMessage, ReplyAddress } from '../transport/types.js';
import type { Logger } from '../util/logger.js';
import type { Scheduler, TimerHandle } from './scheduler.js';

export interface InboundBatch {
    readonly id: string;
    readonly contactId: string;
    /** Address of the most recent message, so replies go where the contact last wrote from. */
    replyTo: ReplyAddress;
    readonly messages: InboundMessage[];
    /** When the debouncer closed the first group of messages in this batch. */
    readonly readyAt: number;
}

export interface DispatcherOptions {
    leaseMs: number;
    maxAgeMs: number;
}

export interface DispatcherEvents {
    /** A batch is waiting for SillyTavern to claim it (also re-sent when it grows or is re-offered). */
    offer(batch: InboundBatch): void;
    /** A batch was dropped without a reply. */
    drop(batch: InboundBatch, reason: DropReason): void;
}

export type DropReason = 'stale' | 'lease-expired' | 'failed' | 'cancelled';

export type ClaimResult =
    | { readonly ok: true; readonly batch: InboundBatch; readonly first: boolean }
    | { readonly ok: false; readonly reason: 'unknown-batch' | 'claimed-by-other' };

export type ReleaseResult = { readonly ok: true; readonly batch: InboundBatch } | { readonly ok: false; readonly reason: 'not-claimed' };

interface Active {
    batch: InboundBatch;
    clientId: string | null;
    leaseTimer: TimerHandle | null;
    /** How many distinct claims this batch has had. */
    claims: number;
}

/** A batch whose claim is lost this many times (tab closed, lease expired) is dropped. */
const MAX_CLAIMS = 2;

/**
 * Hands inbound batches to SillyTavern one at a time, because SillyTavern has a single active
 * chat. The first browser tab to claim the offered batch gets it; the claim is a lease that
 * the tab renews while it works. Messages from a contact whose batch hasn't been claimed yet
 * are merged into it, so the character answers everything at once.
 */
export class BatchDispatcher {
    private readonly queue: InboundBatch[] = [];
    private active: Active | null = null;
    private disposed = false;

    constructor(
        private readonly scheduler: Scheduler,
        private readonly options: () => DispatcherOptions,
        private readonly events: DispatcherEvents,
        private readonly logger: Logger,
        private readonly newId: () => string,
    ) {}

    enqueue(contactId: string, messages: readonly InboundMessage[]): InboundBatch | null {
        const last = messages.at(-1);
        if (this.disposed || !last) return null;

        if (this.active?.batch.contactId === contactId && this.active.clientId === null) {
            this.merge(this.active.batch, messages);
            this.emitOffer(this.active.batch);
            return this.active.batch;
        }
        const queued = this.queue.find((batch) => batch.contactId === contactId);
        if (queued) {
            this.merge(queued, messages);
            return queued;
        }

        const batch: InboundBatch = {
            id: this.newId(),
            contactId,
            replyTo: last.replyTo,
            messages: [...messages],
            readyAt: this.scheduler.now(),
        };
        this.queue.push(batch);
        this.offerNext();
        return batch;
    }

    /** Claim the offered batch, or renew a claim this client already holds. */
    claim(batchId: string, clientId: string): ClaimResult {
        const active = this.active;
        if (active?.batch.id !== batchId) return { ok: false, reason: 'unknown-batch' };
        if (active.clientId !== null && active.clientId !== clientId) return { ok: false, reason: 'claimed-by-other' };

        const first = active.claims === 0;
        if (active.clientId === null) active.claims++;
        active.clientId = clientId;
        this.startLease(active);
        return { ok: true, batch: active.batch, first };
    }

    /** The claimant finished with the batch (replied, or gave up). The next batch is offered. */
    release(batchId: string, clientId: string, outcome: 'done' | 'failed'): ReleaseResult {
        const active = this.active;
        if (active?.batch.id !== batchId || active.clientId !== clientId) return { ok: false, reason: 'not-claimed' };
        this.clearActive();
        if (outcome === 'failed') this.events.drop(active.batch, 'failed');
        this.offerNext();
        return { ok: true, batch: active.batch };
    }

    /** A tab went away. If it held the claim, offer the batch again (or give up if it already was). */
    clientGone(clientId: string): void {
        if (this.active?.clientId !== clientId) return;
        this.reoffer('lease-expired');
    }

    /** The batch currently waiting for a claim, if any. Stale batches are dropped first. */
    pendingOffer(): InboundBatch | undefined {
        if (this.active && this.active.clientId === null && this.isStale(this.active.batch)) {
            const stale = this.active.batch;
            this.clearActive();
            this.events.drop(stale, 'stale');
            this.offerNext();
        }
        return this.active?.clientId === null ? this.active.batch : undefined;
    }

    claimant(batchId: string): string | null {
        return this.active?.batch.id === batchId ? this.active.clientId : null;
    }

    /** Drop every batch for a contact, e.g. after it was removed from the allowlist. */
    cancelContact(contactId: string): void {
        this.cancelWhere((batch) => batch.contactId === contactId);
    }

    cancelAll(): void {
        this.cancelWhere(() => true);
    }

    get size(): number {
        return this.queue.length + (this.active ? 1 : 0);
    }

    /** Stop all timers and forget all batches, without emitting events. */
    dispose(): void {
        this.disposed = true;
        if (this.active?.leaseTimer) this.scheduler.clearTimeout(this.active.leaseTimer);
        this.active = null;
        this.queue.length = 0;
    }

    private cancelWhere(predicate: (batch: InboundBatch) => boolean): void {
        const dropped = this.queue.filter(predicate);
        this.queue.splice(0, this.queue.length, ...this.queue.filter((batch) => !predicate(batch)));
        const active = this.active;
        if (active && predicate(active.batch)) {
            this.clearActive();
            dropped.unshift(active.batch);
        }
        for (const batch of dropped) this.events.drop(batch, 'cancelled');
        this.offerNext();
    }

    private merge(batch: InboundBatch, messages: readonly InboundMessage[]): void {
        batch.messages.push(...messages);
        const last = messages.at(-1);
        if (last) batch.replyTo = last.replyTo;
    }

    private offerNext(): void {
        while (!this.active && !this.disposed) {
            const next = this.queue.shift();
            if (!next) return;
            if (this.isStale(next)) {
                this.events.drop(next, 'stale');
                continue;
            }
            this.active = { batch: next, clientId: null, leaseTimer: null, claims: 0 };
            this.emitOffer(next);
        }
    }

    private emitOffer(batch: InboundBatch): void {
        try {
            this.events.offer(batch);
        } catch (error) {
            this.logger.error('Failed to offer a batch', error);
        }
    }

    private startLease(active: Active): void {
        if (active.leaseTimer) this.scheduler.clearTimeout(active.leaseTimer);
        active.leaseTimer = this.scheduler.setTimeout(() => {
            active.leaseTimer = null;
            if (this.active === active) this.reoffer('lease-expired');
        }, this.options().leaseMs);
    }

    private reoffer(reason: DropReason): void {
        const active = this.active;
        if (!active) return;
        if (active.leaseTimer) this.scheduler.clearTimeout(active.leaseTimer);
        active.leaseTimer = null;
        active.clientId = null;
        if (active.claims >= MAX_CLAIMS) {
            this.logger.warn(`Giving up on batch ${active.batch.id} for ${active.batch.contactId}: ${reason}`);
            this.clearActive();
            this.events.drop(active.batch, reason);
            this.offerNext();
            return;
        }
        this.emitOffer(active.batch);
    }

    private clearActive(): void {
        if (this.active?.leaseTimer) this.scheduler.clearTimeout(this.active.leaseTimer);
        this.active = null;
    }

    private isStale(batch: InboundBatch): boolean {
        return this.scheduler.now() - batch.readyAt > this.options().maxAgeMs;
    }
}
