import type { Request, Response, Router } from 'express';
import QRCode from 'qrcode';
import { z } from 'zod';
import type { ConfigStore } from '../config/store.js';
import type { BridgeEvent, BridgeService } from '../core/bridge-service.js';
import type { Logger } from '../util/logger.js';
import type { SseHub } from './sse.js';

export interface RouteDeps {
    /** Read on every request, because the service is created after the routes are registered. */
    readonly service: BridgeService;
    store: ConfigStore;
    hub: SseHub;
    logger: Logger;
}

const clientIdSchema = z.string().min(1).max(100);
const claimBody = z.object({ clientId: clientIdSchema });
const replyBody = z.object({
    clientId: clientIdSchema,
    text: z.string().max(100_000),
    chatFile: z.string().min(1).max(500).optional(),
    characterName: z.string().max(200).optional(),
    userName: z.string().max(200).optional(),
});
const failBody = z.object({ clientId: clientIdSchema, reason: z.string().max(2_000).default('unknown error') });

type Handler = (req: Request, res: Response) => Promise<void> | void;

/**
 * HTTP API under /api/plugins/whatschat. SillyTavern mounts this router behind its own login
 * and CSRF protection, and parses JSON bodies before it.
 *
 * There is deliberately no endpoint that sends text to an arbitrary number: replies can only
 * answer a batch that an allowlisted contact started.
 */
export function registerRoutes(router: Router, deps: RouteDeps): void {
    const { store, hub, logger } = deps;
    const qr = qrRenderer();

    const handle =
        (handler: Handler) =>
        (req: Request, res: Response): void => {
            Promise.resolve()
                .then(() => handler(req, res))
                .catch((error: unknown) => {
                    logger.error(`${req.method} ${req.path} failed`, error);
                    if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
                });
        };

    router.get('/status', handle((_req, res) => {
        res.json(deps.service.status());
    }));

    router.get('/qr', handle(async (_req, res) => {
        const status = deps.service.status().transport;
        const code = status.state === 'pairing' ? status.pairingCode : undefined;
        res.json({ qr: code ? await qr(code) : null });
    }));

    router.get('/config', handle((_req, res) => {
        res.json(store.get());
    }));

    router.put('/config', handle(async (req, res) => {
        const result = await store.save(req.body);
        if (result.ok) res.json(result.config);
        else res.status(400).json({ error: 'Invalid config', issues: result.issues });
    }));

    router.post('/connect', handle(async (_req, res) => {
        await deps.service.connect();
        res.json(deps.service.status());
    }));

    router.post('/disconnect', handle(async (_req, res) => {
        await deps.service.disconnect();
        res.json(deps.service.status());
    }));

    router.post('/logout', handle(async (_req, res) => {
        await deps.service.logout();
        res.json(deps.service.status());
    }));

    router.get('/events', handle((req, res) => {
        const clientId = hub.connect(req, res, (id) => {
            deps.service.clientGone(id);
        });
        if (clientId === null) return;
        hub.send(clientId, 'hello', { clientId });
        hub.send(clientId, 'status', deps.service.status());
        const pending = deps.service.pendingOffer();
        if (pending) hub.send(clientId, 'batch', pending);
    }));

    router.post('/batches/:id/claim', handle((req, res) => {
        const body = parseBody(claimBody, req, res);
        if (!body) return;
        const result = deps.service.claim(batchId(req), body.clientId);
        if (result.ok) res.json(result);
        else res.status(409).json(result);
    }));

    router.post('/batches/:id/reply', handle((req, res) => {
        const body = parseBody(replyBody, req, res);
        if (!body) return;
        const result = deps.service.reply(batchId(req), body.clientId, body);
        if (result.ok) res.status(202).json(result);
        else res.status(result.reason === 'not-claimed' ? 409 : 422).json(result);
    }));

    router.post('/batches/:id/fail', handle((req, res) => {
        const body = parseBody(failBody, req, res);
        if (!body) return;
        const result = deps.service.fail(batchId(req), body.clientId, body.reason);
        if (result.ok) res.json(result);
        else res.status(409).json(result);
    }));
}

/** Forward service events and config changes to every connected tab. */
export function forwardEvents(deps: RouteDeps): () => void {
    const offService = deps.service.onEvent((event: BridgeEvent) => {
        switch (event.type) {
            case 'status':
                deps.hub.broadcast('status', event.status);
                break;
            case 'batch':
                deps.hub.broadcast('batch', event.batch);
                break;
            case 'batch-dropped':
                deps.hub.broadcast('batch-dropped', {
                    batchId: event.batchId,
                    contactId: event.contactId,
                    reason: event.reason,
                });
                break;
        }
    });
    const offConfig = deps.store.onChange((config) => {
        deps.hub.broadcast('config', config);
    });
    return () => {
        offService();
        offConfig();
    };
}

function batchId(req: Request): string {
    return req.params['id'] ?? '';
}

function parseBody<T>(schema: z.ZodType<T>, req: Request, res: Response): T | null {
    const result = schema.safeParse(req.body);
    if (result.success) return result.data;
    res.status(400).json({
        error: 'Invalid request',
        issues: result.error.issues.map((i) => `${i.path.map(String).join('.') || 'body'}: ${i.message}`),
    });
    return null;
}

/** Renders the pairing code as a PNG data URL, caching the latest one. */
function qrRenderer(): (code: string) => Promise<string> {
    let cached: { code: string; url: string } | null = null;
    return async (code) => {
        if (cached?.code === code) return cached.url;
        const url = await QRCode.toDataURL(code, { margin: 1, width: 300, errorCorrectionLevel: 'M' });
        cached = { code, url };
        return url;
    };
}
