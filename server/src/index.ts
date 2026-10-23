import type { Router } from 'express';

/** Plugin metadata read by SillyTavern's plugin loader. Routes are mounted at /api/plugins/<id>. */
export const info = {
    id: 'whatschat',
    name: 'WhatsChat',
    description: 'Chat with your SillyTavern characters over WhatsApp.',
};

/**
 * Called once by SillyTavern on startup. Routes must be registered before this resolves,
 * because SillyTavern only mounts the router if it already has routes at that point.
 */
export async function init(router: Router): Promise<void> {
    router.get('/status', (_req, res) => {
        res.json({ ok: true });
    });
    return Promise.resolve();
}

/** Called by SillyTavern on shutdown (SIGINT, SIGTERM or an uncaught exception). */
export async function exit(): Promise<void> {
    return Promise.resolve();
}
