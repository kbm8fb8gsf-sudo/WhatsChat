// @ts-check
/**
 * Turns offered batches into SillyTavern replies, one at a time (SillyTavern has a single
 * active chat): claim → wait until idle → open the mapped chat → add the user message →
 * inject the note → generate → post the reply → restore the previous chat.
 */

/**
 * @typedef {import('./st-bridge.js').Bridge} Bridge
 * @typedef {import('./api-client.js').ApiClient} ApiClient
 * @typedef {import('./api-client.js').BatchView} BatchView
 */

export class BatchProcessor {
    /**
     * @param {{
     *   api: Pick<ApiClient, 'claim' | 'reply' | 'fail'>,
     *   bridge: Bridge,
     *   settings: () => { restorePreviousChat: boolean },
     *   beforeClaim?: (batch: BatchView) => boolean | Promise<boolean>,
     *   rereadChat?: boolean,
     *   afterBatch?: () => void,
     *   renewMs?: number,
     *   setIntervalImpl?: (callback: () => void, ms: number) => unknown,
     *   clearIntervalImpl?: (handle: unknown) => void,
     * }} options
     */
    constructor(options) {
        this.api = options.api;
        this.bridge = options.bridge;
        this.settings = options.settings;
        /** Return false to leave a batch unclaimed (e.g. because the page is about to reload). */
        this.beforeClaim = options.beforeClaim ?? (() => true);
        this.afterBatch = options.afterBatch ?? (() => undefined);
        /** Re-read the chat from disk before writing to it (the hidden copy's chat can be stale). */
        this.rereadChat = options.rereadChat ?? false;
        this.renewMs = options.renewMs ?? 30_000;
        this.setIntervalImpl = options.setIntervalImpl ?? ((callback, ms) => setInterval(callback, ms));
        this.clearIntervalImpl =
            options.clearIntervalImpl ?? ((handle) => clearInterval(/** @type {number} */ (handle)));
        /** @type {Map<string, BatchView>} Offered batches waiting their turn, in arrival order. */
        this.waiting = new Map();
        /** @type {string | null} */
        this.current = null;
        /** @type {Promise<void>} */
        this.idle = Promise.resolve();
        this.running = false;
    }

    /**
     * A batch was offered (or re-offered with more messages).
     * @param {BatchView} batch
     */
    offer(batch) {
        if (batch.id === this.current) return;
        this.waiting.set(batch.id, batch);
        this.kick();
    }

    /**
     * The server dropped a batch; forget it if it hasn't started.
     * @param {string} batchId
     */
    dropped(batchId) {
        this.waiting.delete(batchId);
    }

    /** Resolves when nothing is being processed. For tests. */
    whenIdle() {
        return this.idle;
    }

    kick() {
        if (this.running) return;
        this.running = true;
        this.idle = this.drain().finally(() => {
            this.running = false;
        });
    }

    async drain() {
        for (;;) {
            const next = this.waiting.values().next();
            if (next.done) return;
            this.waiting.delete(next.value.id);
            this.current = next.value.id;
            if (!(await this.beforeClaim(next.value))) {
                this.current = null;
                return;
            }
            try {
                await this.process(next.value);
            } catch (error) {
                console.error('[WhatsChat] Unexpected error while handling a batch', error);
            } finally {
                this.current = null;
                this.afterBatch();
            }
        }
    }

    /** @param {BatchView} offered */
    async process(offered) {
        const claim = await this.api.claim(offered.id);
        if (!claim.ok) return; // another tab took it, or it's gone
        const batch = claim.batch;
        const who = batch.contactLabel || batch.pushName || batch.contactId;
        const renew = this.setIntervalImpl(() => {
            this.api.claim(batch.id).catch(() => undefined);
        }, this.renewMs);
        const previous = this.bridge.getActiveChat();
        /** @type {string | undefined} */
        let chatFile;

        try {
            await this.bridge.waitUntilIdle();
            const opened = await this.bridge.openChat({
                characterAvatar: batch.characterAvatar,
                chatFile: batch.chatFile,
            });
            chatFile = opened.chatFile;
            if (this.rereadChat) await this.bridge.reloadOpenChat();
            await this.bridge.addUserMessage(batch.text);
            if (batch.note) this.bridge.setNote(batch.note);
            let text;
            try {
                text = await this.bridge.generateReply();
            } finally {
                this.bridge.clearNote();
            }
            const result = await this.api.reply(batch.id, {
                text,
                chatFile: opened.chatFile,
                characterName: opened.characterName,
                userName: this.bridge.userName(),
            });
            if (!result.ok) {
                this.bridge.notify(`The reply to ${who} wasn't sent (${describeReason(result.reason)}).`, 'warning');
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.bridge.notify(`Couldn't reply to ${who}: ${message}`, 'error');
            await this.api.fail(batch.id, message, chatFile).catch(() => undefined);
        } finally {
            this.clearIntervalImpl(renew);
            if (this.settings().restorePreviousChat) {
                try {
                    await this.bridge.restoreChat(previous);
                } catch (error) {
                    console.warn('[WhatsChat] Could not go back to the previous chat', error);
                }
            }
        }
    }
}

/** @param {string} reason */
function describeReason(reason) {
    switch (reason) {
        case 'empty-reply':
            return 'it was empty after removing narration and formatting';
        case 'contact-removed':
            return 'the contact was removed or disabled';
        case 'not-claimed':
            return 'it took too long and was handed back';
        default:
            return reason;
    }
}
