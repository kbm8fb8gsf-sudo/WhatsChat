import type { Request, Response, Router } from 'express';
import QRCode from 'qrcode';
import { z } from 'zod';
import type { AiHealth, BackgroundStatus } from '../background/background-browser.js';
import type { ConfigStore } from '../config/store.js';
import type { BridgeEvent, BridgeService, BridgeStatus } from '../core/bridge-service.js';
import type { Logger } from '../util/logger.js';
import type { ClientRole, SseHub } from './sse.js';

/** What the routes need from background mode. */
export interface BackgroundControl {
    /** True while new batches should go only to the hidden background page. */
    handlesReplies(): boolean;
    status(): BackgroundStatus;
    restart(): Promise<void>;
    reportHealth(ai: AiHealth): void;
    describeLogin(): { username: string; passwordSet: boolean };
    setLogin(username: string, password: string | undefined): Promise<void>;
}

export interface RouteDeps {
    /** Read on every request, because the service is created after the routes are registered. */
    readonly service: BridgeService;
    store: ConfigStore;
    hub: SseHub;
    logger: Logger;
    background: BackgroundControl;
}

export type FullStatus = BridgeStatus & { background: BackgroundStatus };

const clientIdSchema = z.string().min(1).max(100);
const claimBody = z.object({ clientId: clientIdSchema });
const replyBody = z.object({
    clientId: clientIdSchema,
    text: z.string().max(100_000),
    chatFile: z.string().min(1).max(500).optional(),
    characterName: z.string().max(200).optional(),
    userName: z.string().max(200).optional(),
});
const failBody = z.object({
    clientId: clientIdSchema,
    reason: z.string().max(2_000).default('unknown error'),
    chatFile: z.string().min(1).max(500).optional(),
});
const loginBody = z.object({ username: z.string().max(200), password: z.string().max(500).optional() });
const healthBody = z.object({ connected: z.boolean(), api: z.string().max(100) });

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
        res.json(fullStatus(deps));
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
        res.json(fullStatus(deps));
    }));

    router.post('/disconnect', handle(async (_req, res) => {
        await deps.service.disconnect();
        res.json(fullStatus(deps));
    }));

    router.post('/logout', handle(async (_req, res) => {
        await deps.service.logout();
        res.json(fullStatus(deps));
    }));

    router.get('/events', handle((req, res) => {
        const requested = typeof req.query['clientId'] === 'string' ? req.query['clientId'] : undefined;
        const role: ClientRole = req.query['role'] === 'worker' ? 'worker' : 'tab';
        const clientId = hub.connect(req, res, requested, role, (id) => {
            deps.service.clientGone(id);
        });
        if (clientId === null) return;
        hub.send(clientId, 'hello', { clientId });
        hub.send(clientId, 'status', fullStatus(deps));
        const pending = deps.service.pendingOffer();
        if (pending && offerAudience(deps)(role)) hub.send(clientId, 'batch', pending);
    }));

    router.post('/batches/:id/claim', handle((req, res) => {
        const body = parseBody(claimBody, req, res);
        if (!body) return;
        if (deps.background.handlesReplies() && hub.roleOf(body.clientId) !== 'worker') {
            res.status(409).json({ ok: false, reason: 'handled-in-background' });
            return;
        }
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
        const result = deps.service.fail(batchId(req), body.clientId, body.reason, body.chatFile);
        if (result.ok) res.json(result);
        else res.status(409).json(result);
    }));

    // A tab saw SillyTavern's settings, a character or a lorebook change. The hidden page
    // reloads before its next reply so it doesn't use (or save) an out-of-date copy.
    router.post('/background/stale', handle((_req, res) => {
        hub.broadcast('stale', { at: Date.now() }, isWorker);
        res.json({ ok: true });
    }));

    // The hidden page reports whether SillyTavern is connected to the AI.
    router.post('/background/health', handle((req, res) => {
        const body = parseBody(healthBody, req, res);
        if (!body) return;
        deps.background.reportHealth(body);
        res.json({ ok: true });
    }));

    router.get('/background/login', handle((_req, res) => {
        res.json(deps.background.describeLogin());
    }));

    router.put('/background/login', handle(async (req, res) => {
        const body = parseBody(loginBody, req, res);
        if (!body) return;
        await deps.background.setLogin(body.username, body.password);
        void deps.background.restart();
        res.json(deps.background.describeLogin());
    }));

    router.post('/background/restart', handle(async (_req, res) => {
        await deps.background.restart();
        res.json(fullStatus(deps));
    }));
}

export function fullStatus(deps: RouteDeps): FullStatus {
    return { ...deps.service.status(), background: deps.background.status() };
}

const isWorker = (role: ClientRole): boolean => role === 'worker';
const everyone = (): boolean => true;

/** While background mode handles replies, only the hidden page gets offered batches. */
function offerAudience(deps: RouteDeps): (role: ClientRole) => boolean {
    return deps.background.handlesReplies() ? isWorker : everyone;
}

/**
 * Forward service events and config changes to connected clients. `announce` re-sends the
 * status and the pending batch, for when background mode starts or stops and the audience
 * for batches changes.
 */
export function forwardEvents(deps: RouteDeps): { stop: () => void; announce: () => void } {
    const offService = deps.service.onEvent((event: BridgeEvent) => {
        switch (event.type) {
            case 'status':
                deps.hub.broadcast('status', fullStatus(deps));
                break;
            case 'batch':
                deps.hub.broadcast('batch', event.batch, offerAudience(deps));
                break;
            case 'batch-dropped':
                deps.hub.broadcast('batch-dropped', {
                    batchId: event.batchId,
                    contactId: event.contactId,
                    reason: event.reason,
                });
                break;
            case 'chat-updated':
                deps.hub.broadcast(
                    'chat-updated',
                    { characterAvatar: event.characterAvatar, chatFile: event.chatFile },
                    (role) => role === 'tab',
                );
                break;
        }
    });
    const offConfig = deps.store.onChange((config) => {
        deps.hub.broadcast('config', config);
    });
    return {
        stop: () => {
            offService();
            offConfig();
        },
        announce: () => {
            deps.hub.broadcast('status', fullStatus(deps));
            const pending = deps.service.pendingOffer();
            if (pending) deps.hub.broadcast('batch', pending, offerAudience(deps));
        },
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
