// @ts-check
/**
 * Worker mode: this page is the hidden copy of SillyTavern that the server plugin runs in
 * headless Chromium, so WhatsApp replies don't need anyone's browser tab to be open.
 */

import { BatchProcessor } from './batch-processor.js';

/** Set by the server plugin before SillyTavern loads (see background/session.ts). */
const WORKER_FLAG = '__WHATSCHAT_WORKER__';
/** The server plugin waits for this before it reports background replies as running. */
const READY_FLAG = '__WHATSCHAT_WORKER_READY__';

/**
 * @typedef {import('./api-client.js').ApiClient} ApiClient
 * @typedef {import('./st-bridge.js').Bridge} Bridge
 */

/** @param {Record<string, unknown>} [scope] */
export function isBackgroundWorker(scope = /** @type {Record<string, unknown>} */ (globalThis)) {
    return scope[WORKER_FLAG] === true;
}

/**
 * Should the hidden page reload before handling the next batch? It holds its own copy of
 * SillyTavern's settings, characters and lorebooks, so it reloads when a tab reports a change,
 * or after a quiet spell in case something changed that no tab saw. Pure.
 * @param {{ loadedAt: number, lastActivityAt: number, staleAt: number, now: number, idleReloadMs: number }} state
 */
export function needsReload({ loadedAt, lastActivityAt, staleAt, now, idleReloadMs }) {
    if (staleAt > loadedAt) return true;
    return idleReloadMs > 0 && now - Math.max(loadedAt, lastActivityAt) > idleReloadMs;
}

/**
 * @param {{
 *   api: ApiClient,
 *   bridge: Bridge,
 *   reload?: () => void,
 *   now?: () => number,
 *   scope?: Record<string, unknown>,
 * }} deps
 */
export function startWorker(deps) {
    const now = deps.now ?? (() => Date.now());
    const reload = deps.reload ?? (() => location.reload());
    const scope = deps.scope ?? /** @type {Record<string, unknown>} */ (globalThis);
    const loadedAt = now();
    let lastActivityAt = loadedAt;
    let staleAt = 0;
    let idleReloadMs = 5 * 60_000;
    let reloading = false;

    const processor = new BatchProcessor({
        api: deps.api,
        bridge: deps.bridge,
        // Nobody is looking at this page, so there's no chat to go back to.
        settings: () => ({ restorePreviousChat: false }),
        rereadChat: true,
        beforeClaim: () => {
            if (reloading) return false;
            if (!needsReload({ loadedAt, lastActivityAt, staleAt, now: now(), idleReloadMs })) return true;
            // The reloaded page is offered the same batch as soon as it reconnects.
            reloading = true;
            console.info('[WhatsChat] Reloading to pick up changes before replying');
            reload();
            return false;
        },
        afterBatch: () => {
            lastActivityAt = now();
        },
    });

    /** @param {any} config */
    const applyConfig = (config) => {
        const value = config?.['background']?.['idleReloadMs'];
        if (typeof value === 'number') idleReloadMs = value;
    };
    deps.api.getConfig().then(applyConfig, () => undefined);

    deps.api.listen({
        batch: (batch) => {
            processor.offer(batch);
        },
        batchDropped: ({ batchId }) => {
            processor.dropped(batchId);
        },
        config: applyConfig,
        stale: ({ at }) => {
            staleAt = Math.max(staleAt, at);
        },
        connection: (state) => {
            if (state === 'open') scope[READY_FLAG] = true;
        },
    });
    console.info('[WhatsChat] Background replies: hidden page started');
    return processor;
}
