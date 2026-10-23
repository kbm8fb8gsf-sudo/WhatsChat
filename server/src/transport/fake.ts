import type {
    InboundMessage,
    MessageRef,
    MessagingTransport,
    ReplyAddress,
    TransportStatus,
    TypingState,
} from './types.js';
import { TransportUnavailableError } from './types.js';

export type FakeCall =
    | { readonly kind: 'sendText'; readonly to: string; readonly text: string; readonly at: number }
    | { readonly kind: 'setTyping'; readonly to: string; readonly state: TypingState; readonly at: number }
    | { readonly kind: 'markRead'; readonly ids: readonly string[]; readonly at: number };

/** In-memory transport for tests. Records every outbound call with the time it happened. */
export class FakeTransport implements MessagingTransport {
    readonly kind = 'fake';
    readonly calls: FakeCall[] = [];
    private status: TransportStatus = { state: 'disabled' };
    private readonly messageHandlers = new Set<(message: InboundMessage) => void>();
    private readonly statusHandlers = new Set<(status: TransportStatus) => void>();
    private readonly sendFailures: Error[] = [];
    /** When set, markRead and setTyping reject with this error. */
    presenceError: Error | null = null;
    private counter = 0;

    constructor(private readonly now: () => number = Date.now) {}

    connect(): Promise<void> {
        this.setStatus({ state: 'connected', self: '+15550000000' });
        return Promise.resolve();
    }

    disconnect(): Promise<void> {
        this.setStatus({ state: 'disabled' });
        return Promise.resolve();
    }

    logout(): Promise<void> {
        this.setStatus({ state: 'logged_out' });
        return Promise.resolve();
    }

    onMessage(handler: (message: InboundMessage) => void): () => void {
        this.messageHandlers.add(handler);
        return () => this.messageHandlers.delete(handler);
    }

    onStatus(handler: (status: TransportStatus) => void): () => void {
        this.statusHandlers.add(handler);
        return () => this.statusHandlers.delete(handler);
    }

    sendText(to: ReplyAddress, text: string): Promise<void> {
        const failure = this.sendFailures.shift();
        if (failure) return Promise.reject(failure);
        if (this.status.state !== 'connected') return Promise.reject(new TransportUnavailableError());
        this.calls.push({ kind: 'sendText', to: to.id, text, at: this.now() });
        return Promise.resolve();
    }

    setTyping(to: ReplyAddress, state: TypingState): Promise<void> {
        if (this.presenceError) return Promise.reject(this.presenceError);
        this.calls.push({ kind: 'setTyping', to: to.id, state, at: this.now() });
        return Promise.resolve();
    }

    markRead(refs: readonly MessageRef[]): Promise<void> {
        if (this.presenceError) return Promise.reject(this.presenceError);
        this.calls.push({ kind: 'markRead', ids: refs.map((r) => r.messageId), at: this.now() });
        return Promise.resolve();
    }

    getStatus(): TransportStatus {
        return this.status;
    }

    // ---- test controls ----

    /** Simulate an inbound message from `contactId`. */
    receive(contactId: string, text: string, extra: Partial<InboundMessage> = {}): InboundMessage {
        const id = `msg-${String(++this.counter)}`;
        const message: InboundMessage = {
            id,
            contactId,
            replyTo: { transport: this.kind, id: `${contactId}@fake` },
            ref: { chatId: `${contactId}@fake`, messageId: id },
            text,
            timestamp: this.now(),
            ...extra,
        };
        for (const handler of this.messageHandlers) handler(message);
        return message;
    }

    setStatus(status: TransportStatus): void {
        this.status = status;
        for (const handler of this.statusHandlers) handler(status);
    }

    /** Make the next sendText calls reject with these errors, in order. */
    failNextSends(...errors: Error[]): void {
        this.sendFailures.push(...errors);
    }

    sent(): string[] {
        return this.calls.flatMap((call) => (call.kind === 'sendText' ? [call.text] : []));
    }
}
