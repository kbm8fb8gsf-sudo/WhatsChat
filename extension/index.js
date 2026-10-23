// @ts-check
/**
 * WhatsChat UI extension entry point. SillyTavern loads this as an ES module and calls the
 * exported `onActivate` hook named in manifest.json.
 *
 * The extension is deliberately thin: it shows the settings panel, listens to the server
 * plugin's event stream, and drives SillyTavern to answer each batch of WhatsApp messages.
 * In the hidden background copy of SillyTavern it runs in worker mode instead (worker.js).
 */

import { ApiClient } from './api-client.js';
import { BatchProcessor } from './batch-processor.js';
import { SettingsPanel } from './settings-ui.js';
import { createBridge } from './st-bridge.js';
import { isBackgroundWorker, startWorker } from './worker.js';

/** Wait this long after the last change before telling the hidden copy, so bursts send one message. */
const STALE_DEBOUNCE_MS = 2_000;

let activated = false;

/** Manifest `activate` hook. */
export async function onActivate() {
    if (activated) return;
    activated = true;

    const bridge = createBridge();
    if (isBackgroundWorker()) {
        const api = new ApiClient({ headers: () => bridge.requestHeaders(), role: 'worker' });
        // Don't await: SillyTavern waits for this hook before it finishes loading.
        bridge.onReady(() => {
            startWorker({ api, bridge });
        });
        return;
    }

    const api = new ApiClient({ headers: () => bridge.requestHeaders() });
    const panel = new SettingsPanel({ api, bridge });
    /** @type {Record<string, any> | null} */
    let config = null;

    const processor = new BatchProcessor({
        api,
        bridge,
        settings: () => ({ restorePreviousChat: config?.['sillytavern']?.['restorePreviousChat'] ?? true }),
    });

    const container = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    if (!container) {
        console.error('[WhatsChat] Could not find the Extensions settings area');
        return;
    }
    await panel.mount(container);

    const refresh = async () => {
        try {
            config = await api.getConfig();
            panel.showConfig(/** @type {Record<string, any>} */ (config));
            await panel.showStatus(await api.status());
            await panel.showLogin(await api.getLogin());
            panel.showNotice('');
        } catch (error) {
            panel.showNotice(
                "The WhatsChat server plugin isn't running. Put it in SillyTavern's plugins folder, set " +
                    'enableServerPlugins: true in config.yaml, and restart SillyTavern.',
            );
            console.error('[WhatsChat]', error);
        }
    };

    // Wait for SillyTavern to finish loading (the character list in particular), but don't
    // await it here: SillyTavern waits for this hook before it finishes loading.
    bridge.onReady(() => {
        void refresh();
        api.listen({
            status: (status) => {
                void panel.showStatus(status);
            },
            batch: (batch) => {
                processor.offer(batch);
            },
            batchDropped: ({ batchId }) => {
                processor.dropped(batchId);
            },
            config: (next) => {
                config = next;
                panel.showConfig(next);
            },
            chatUpdated: (chat) => {
                // The hidden background copy wrote to this chat; show it, and don't overwrite it.
                bridge.reloadChatIfOpen(chat).catch((/** @type {unknown} */ error) => {
                    console.warn('[WhatsChat] Could not reload the chat', error);
                });
            },
            connection: (state) => {
                // After SillyTavern restarts, pick up anything that changed while we were away.
                if (state === 'open') void refresh();
            },
        });

        /** @type {ReturnType<typeof setTimeout> | undefined} */
        let staleTimer;
        bridge.onSillyTavernChange(() => {
            clearTimeout(staleTimer);
            staleTimer = setTimeout(() => {
                api.markStale().catch(() => undefined);
            }, STALE_DEBOUNCE_MS);
        });
    });
}
