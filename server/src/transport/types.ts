/**
 * The only boundary between the bridge and a messaging network. Core logic depends on this
 * interface alone, so another network (e.g. iMessage via BlueBubbles) can be added by writing
 * one more implementation.
 */

/** Where to send a reply. Opaque to core logic. */
export interface ReplyAddress {
    readonly transport: string;
    readonly id: string;
}

/** Identifies one inbound message, for read receipts. Opaque to core logic. */
export interface MessageRef {
    readonly chatId: string;
    readonly messageId: string;
    readonly participantId?: string;
}

export interface InboundMessage {
    readonly id: string;
    /** Canonical contact id: "+<E.164 digits>" or "lid:<digits>". */
    readonly contactId: string;
    readonly replyTo: ReplyAddress;
    readonly ref: MessageRef;
    /** The sender's own display name, if the network provides one. */
    readonly pushName?: string;
    readonly text: string;
    /** Milliseconds since the epoch. */
    readonly timestamp: number;
}

export type TransportState =
    | 'disabled'
    | 'connecting'
    | 'pairing'
    | 'connected'
    | 'reconnecting'
    | 'logged_out'
    | 'error';

export interface TransportStatus {
    readonly state: TransportState;
    /** Raw pairing payload (WhatsApp: the QR code contents) while state is "pairing". */
    readonly pairingCode?: string;
    /** Our own account, once connected. */
    readonly self?: string;
    readonly attempt?: number;
    readonly nextRetryAt?: number;
    readonly error?: string;
}

export type TypingState = 'typing' | 'paused';

export interface MessagingTransport {
    readonly kind: string;
    connect(): Promise<void>;
    /** Close the connection but keep the session, so the next connect needs no pairing. */
    disconnect(): Promise<void>;
    /** Unlink this device and delete the stored session. */
    logout(): Promise<void>;
    /** Subscribe to inbound 1:1 text messages. Returns an unsubscribe function. */
    onMessage(handler: (message: InboundMessage) => void): () => void;
    onStatus(handler: (status: TransportStatus) => void): () => void;
    /** Rejects with TransportUnavailableError when not connected. Ends any typing indicator. */
    sendText(to: ReplyAddress, text: string): Promise<void>;
    /** "typing" stays on (refreshed as the network requires) until "paused" or a sendText. */
    setTyping(to: ReplyAddress, state: TypingState): Promise<void>;
    markRead(refs: readonly MessageRef[]): Promise<void>;
    getStatus(): TransportStatus;
}

export class TransportUnavailableError extends Error {
    constructor(message = 'The messaging connection is not available') {
        super(message);
        this.name = 'TransportUnavailableError';
    }
}
