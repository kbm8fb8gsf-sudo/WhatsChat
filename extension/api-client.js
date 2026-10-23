// @ts-check
/**
 * Talks to the WhatsChat server plugin: REST calls plus the event stream.
 */

export const API_BASE = '/api/plugins/whatschat';

/**
 * @typedef {object} BatchView
 * @property {string} id
 * @property {string} contactId
 * @property {string} contactLabel
 * @property {string | null} pushName
 * @property {string} characterAvatar
 * @property {string | null} chatFile
 * @property {string} text
 * @property {string | null} note
 * @property {number} messageCount
 * @property {number} receivedAt
 */

/**
 * @typedef {object} TransportStatus
 * @property {'disabled' | 'connecting' | 'pairing' | 'connected' | 'reconnecting' | 'logged_out' | 'error'} state
 * @property {string} [pairingCode]
 * @property {string} [self]
 * @property {number} [attempt]
 * @property {number} [nextRetryAt]
 * @property {string} [error]
 */

/**
 * @typedef {object} BridgeStatus
 * @property {boolean} enabled
 * @property {string} transportKind
 * @property {TransportStatus} transport
 * @property {number} pendingBatches
 * @property {number} queuedTasks
 */

/**
 * @typedef {object} StreamHandlers
 * @property {(status: BridgeStatus) => void} [status]
 * @property {(batch: BatchView) => void} [batch]
 * @property {(dropped: { batchId: string, contactId: string, reason: string }) => void} [batchDropped]
 * @property {(config: any) => void} [config]
 * @property {(state: 'open' | 'reconnecting') => void} [connection]
 */

export class ApiError extends Error {
    /**
     * @param {number} status
     * @param {unknown} body
     */
    constructor(status, body) {
        super(describeError(status, body));
        this.name = 'ApiError';
        this.status = status;
        this.body = body;
    }
}

/**
 * @typedef {{
 *   addEventListener(type: string, listener: (event: MessageEvent) => void): void,
 *   close(): void,
 *   readyState: number,
 *   onerror: ((event: Event) => void) | null,
 *   onopen: ((event: Event) => void) | null,
 * }} EventSourceLike
 */

export class ApiClient {
    /**
     * @param {{
     *   headers: () => Record<string, string>,
     *   fetchImpl?: typeof fetch,
     *   createEventSource?: (url: string) => EventSourceLike,
     *   clientId?: string,
     *   base?: string,
     *   setTimeoutImpl?: (callback: () => void, ms: number) => unknown,
     * }} options
     */
    constructor(options) {
        this.headers = options.headers;
        this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
        this.createEventSource = options.createEventSource ?? ((url) => new EventSource(url));
        /** This tab's id. It survives stream reconnects, so a brief drop doesn't lose a claim. */
        this.clientId = options.clientId ?? crypto.randomUUID();
        this.base = options.base ?? API_BASE;
        this.setTimeoutImpl = options.setTimeoutImpl ?? ((callback, ms) => setTimeout(callback, ms));
    }

    /**
     * @param {string} method
     * @param {string} path
     * @param {unknown} [body]
     * @param {number[]} [acceptedStatuses] Non-2xx statuses whose JSON body is a normal answer.
     * @returns {Promise<any>}
     */
    async request(method, path, body, acceptedStatuses = []) {
        /** @type {RequestInit} */
        const init = { method, headers: { ...this.headers(), 'Content-Type': 'application/json' } };
        if (body !== undefined) init.body = JSON.stringify(body);
        const response = await this.fetchImpl(`${this.base}${path}`, init);
        /** @type {unknown} */
        let json = null;
        try {
            json = await response.json();
        } catch {
            // Not JSON (e.g. SillyTavern's 404 page when the plugin isn't loaded).
        }
        if (!response.ok && !acceptedStatuses.includes(response.status)) throw new ApiError(response.status, json);
        return json;
    }

    /** @returns {Promise<BridgeStatus>} */
    status() {
        return this.request('GET', '/status');
    }

    /** @returns {Promise<{ qr: string | null }>} */
    qr() {
        return this.request('GET', '/qr');
    }

    getConfig() {
        return this.request('GET', '/config');
    }

    /** @param {unknown} config */
    saveConfig(config) {
        return this.request('PUT', '/config', config);
    }

    connect() {
        return this.request('POST', '/connect');
    }

    disconnect() {
        return this.request('POST', '/disconnect');
    }

    logout() {
        return this.request('POST', '/logout');
    }

    /**
     * Claim (or renew a claim on) a batch.
     * @param {string} batchId
     * @returns {Promise<{ ok: true, batch: BatchView } | { ok: false, reason: string }>}
     */
    claim(batchId) {
        return this.request('POST', `/batches/${encodeURIComponent(batchId)}/claim`, { clientId: this.clientId }, [409]);
    }

    /**
     * @param {string} batchId
     * @param {{ text: string, chatFile?: string, characterName?: string, userName?: string }} reply
     * @returns {Promise<{ ok: true, bubbles: number } | { ok: false, reason: string }>}
     */
    reply(batchId, reply) {
        return this.request(
            'POST',
            `/batches/${encodeURIComponent(batchId)}/reply`,
            { clientId: this.clientId, ...reply },
            [409, 422],
        );
    }

    /**
     * @param {string} batchId
     * @param {string} reason
     */
    fail(batchId, reason) {
        return this.request(
            'POST',
            `/batches/${encodeURIComponent(batchId)}/fail`,
            { clientId: this.clientId, reason: reason.slice(0, 2_000) },
            [409],
        );
    }

    /**
     * Subscribe to the event stream. Reconnects (with backoff) if the stream is closed for
     * good, e.g. while SillyTavern restarts. Returns a function that stops listening.
     * @param {StreamHandlers} handlers
     * @returns {() => void}
     */
    listen(handlers) {
        let stopped = false;
        /** @type {EventSourceLike | null} */
        let source = null;
        let retryMs = 2_000;
        const url = `${this.base}/events?clientId=${encodeURIComponent(this.clientId)}`;

        /** @param {string} type @param {(data: any) => void} [handler] */
        const on = (type, handler) => {
            source?.addEventListener(type, (event) => {
                if (!handler) return;
                try {
                    handler(JSON.parse(event.data));
                } catch (error) {
                    console.error(`[WhatsChat] Bad "${type}" event`, error);
                }
            });
        };

        const open = () => {
            if (stopped) return;
            source = this.createEventSource(url);
            source.onopen = () => {
                retryMs = 2_000;
                handlers.connection?.('open');
            };
            source.onerror = () => {
                handlers.connection?.('reconnecting');
                // CLOSED (2) means the browser gave up (e.g. an HTTP error); otherwise it retries itself.
                if (source?.readyState === 2) {
                    source.close();
                    this.setTimeoutImpl(open, retryMs);
                    retryMs = Math.min(retryMs * 2, 60_000);
                }
            };
            on('status', handlers.status);
            on('batch', handlers.batch);
            on('batch-dropped', handlers.batchDropped);
            on('config', handlers.config);
        };

        open();
        return () => {
            stopped = true;
            source?.close();
        };
    }
}

/**
 * @param {number} status
 * @param {unknown} body
 */
function describeError(status, body) {
    if (status === 404) return 'The WhatsChat server plugin is not running';
    if (body && typeof body === 'object') {
        const issues = 'issues' in body && Array.isArray(body.issues) ? body.issues.join('; ') : '';
        const error = 'error' in body ? String(body.error) : '';
        if (issues || error) return [error, issues].filter(Boolean).join(': ');
    }
    return `Request failed (${String(status)})`;
}
