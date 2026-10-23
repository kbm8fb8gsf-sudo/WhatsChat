import { fileURLToPath } from 'node:url';
import type { Router } from 'express';
import { createPlugin, type PluginHandle } from './plugin.js';
import { createBaileysSocket } from './transport/baileys-socket.js';
import { WhatsAppTransport } from './transport/whatsapp.js';
import { createConsoleLogger } from './util/logger.js';

/** Plugin metadata read by SillyTavern's plugin loader. Routes are mounted at /api/plugins/<id>. */
export const info = {
    id: 'whatschat',
    name: 'WhatsChat',
    description: 'Chat with your SillyTavern characters over WhatsApp.',
};

let handle: PluginHandle | null = null;

/**
 * Called once by SillyTavern on startup. Routes are registered before anything slow happens,
 * and the WhatsApp connection is started in the background.
 */
export async function init(router: Router): Promise<void> {
    const logger = createConsoleLogger();
    handle = await createPlugin(router, {
        dataDir: dataDirectory(),
        logger,
        createTransport: ({ sessionDir, store, scheduler, logger: transportLogger }) =>
            new WhatsAppTransport({
                authDir: sessionDir,
                scheduler,
                logger: transportLogger,
                settings: () => {
                    const config = store.get();
                    return {
                        markOnlineOnConnect: config.whatsapp.markOnlineOnConnect,
                        mediaPlaceholders: config.inbound.mediaPlaceholders,
                    };
                },
                createSocket: createBaileysSocket,
            }),
    });
    logger.info('Loaded. Open the WhatsChat panel in SillyTavern’s Extensions menu to set it up.');
}

/** Called by SillyTavern on shutdown (SIGINT, SIGTERM or an uncaught exception). */
export async function exit(): Promise<void> {
    const current = handle;
    handle = null;
    await current?.close();
}

/** `<plugin folder>/data` (gitignored) unless WHATSCHAT_DATA_DIR says otherwise. */
function dataDirectory(): string {
    return process.env['WHATSCHAT_DATA_DIR'] ?? fileURLToPath(new URL('../data/', import.meta.url));
}
