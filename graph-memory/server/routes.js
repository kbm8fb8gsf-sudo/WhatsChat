// @ts-check
/**
 * HTTP API, mounted by SillyTavern at /api/plugins/graph-memory (behind its login and CSRF
 * checks). Every memory lives under the calling SillyTavern user, so users on a shared
 * server never see each other's memories.
 */
import { promises as fs } from 'node:fs';
import { parseSegmentInput, SCOPE_ID_RE, USER_HANDLE_RE } from './normalize.js';
import { labelsToIds, parseGraphifyLabels, renderMemory } from './render.js';
import { errorMessage } from './util.js';

/**
 * @typedef {object} RouteDeps
 * @property {import('./store.js').MemoryStore} store
 * @property {import('./graphify.js').GraphifyService} graphify
 * @property {import('./render.js').GraphCache} graphs
 * @property {import('./util.js').Logger} logger
 * @property {string} version
 */

/**
 * @typedef {import('express').Request} Req
 * @typedef {import('express').Response} Res
 */

export const GRAPH_PAGE_CSP = [
    'sandbox allow-scripts allow-popups',
    "default-src 'none'",
    "script-src 'unsafe-inline' https://unpkg.com",
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'font-src data:',
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
].join('; ');

/**
 * @param {Req} req
 * @returns {string}
 */
export function userOf(req) {
    const handle = /** @type {any} */ (req).user?.profile?.handle;
    return typeof handle === 'string' && USER_HANDLE_RE.test(handle) ? handle : 'default-user';
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 */
function num(value, fallback, min, max) {
    const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

/**
 * @param {import('express').Router} router
 * @param {RouteDeps} deps
 */
export function registerRoutes(router, deps) {
    const { store, graphify, graphs, logger } = deps;

    /**
     * @param {(req: Req, res: Res, user: string, scope: string) => Promise<void>} fn
     */
    const memoryRoute = (fn) => handle(async (req, res) => {
        const scope = String(req.params.scope ?? '');
        if (!SCOPE_ID_RE.test(scope)) {
            res.status(400).json({ error: 'Invalid memory id' });
            return;
        }
        await fn(req, res, userOf(req), scope);
    });

    /** @param {(req: Req, res: Res) => Promise<void> | void} fn */
    function handle(fn) {
        /** @param {Req} req @param {Res} res */
        return async (req, res) => {
            try {
                await fn(req, res);
            } catch (err) {
                logger.error(`${req.method} ${req.path}: ${errorMessage(err)}`);
                if (!res.headersSent) res.status(500).json({ error: errorMessage(err) });
            }
        };
    }

    router.get('/status', handle(async (_req, res) => {
        res.json({ version: deps.version, graphify: await graphify.runtime() });
    }));

    router.post('/status/refresh', handle(async (_req, res) => {
        res.json({ version: deps.version, graphify: await graphify.runtime({ refresh: true }) });
    }));

    router.get('/memories', handle(async (req, res) => {
        res.json({ memories: await store.list(userOf(req)) });
    }));

    router.get('/memories/:scope', memoryRoute(async (req, res, user, scope) => {
        const chatId = typeof req.query.chat === 'string' ? req.query.chat : '';
        res.json({
            meta: await store.meta(user, scope),
            build: await graphify.buildInfo(user, scope),
            segments: chatId ? await store.chatSegments(user, scope, chatId) : undefined,
        });
    }));

    router.get('/memories/:scope/entities', memoryRoute(async (req, res, user, scope) => {
        const limit = num(req.query.limit, 60, 1, 300);
        res.json({ entities: await store.knownEntities(user, scope, limit) });
    }));

    router.post('/memories/:scope/segments', memoryRoute(async (req, res, user, scope) => {
        const parsed = parseSegmentInput(req.body);
        if (!parsed.ok) {
            res.status(400).json({ error: parsed.error });
            return;
        }
        const seg = await store.addSegment(user, scope, parsed.value);
        void graphify.scheduleBuild(user, scope);
        res.json({
            segment: { id: seg.id, from: seg.from, to: seg.to, entities: seg.entities.length, relations: seg.relations.length },
        });
    }));

    router.post('/memories/:scope/forget', memoryRoute(async (req, res, user, scope) => {
        const body = req.body ?? {};
        const chatId = typeof body.chatId === 'string' ? body.chatId : '';
        if (!chatId) {
            res.status(400).json({ error: 'chatId is required' });
            return;
        }
        const ids = Array.isArray(body.ids) ? body.ids.filter((/** @type {unknown} */ x) => typeof x === 'string') : null;
        const removed = await store.forget(user, scope, chatId, ids);
        if (removed > 0) void graphify.scheduleBuild(user, scope, 500);
        res.json({ removed });
    }));

    router.post('/memories/:scope/rebuild', memoryRoute(async (_req, res, user, scope) => {
        res.json({ build: await graphify.scheduleBuild(user, scope, 0) });
    }));

    router.post('/memories/:scope/recall', memoryRoute(async (req, res, user, scope) => {
        const body = req.body ?? {};
        const question = typeof body.text === 'string' ? body.text.slice(0, 4000).trim() : '';
        const maxChars = num(body.maxChars, 2400, 200, 40_000);
        if (!question) {
            res.json({ memory: '', entities: [], engine: null, ms: 0 });
            return;
        }
        const started = Date.now();
        const answer = await graphify.query(user, scope, question, {
            depth: num(body.depth, 2, 1, 6),
            // Ask graphify for more than will be shown: it ranks, we trim.
            tokenBudget: Math.ceil((maxChars / 3) * 2),
        });
        const graph = answer ? await graphs.load(store.graphFile(user, scope)) : null;
        if (!answer || !graph) {
            res.json({ memory: '', entities: [], engine: answer?.engine ?? null, ms: Date.now() - started });
            return;
        }
        const ids = labelsToIds(graph, parseGraphifyLabels(answer.text));
        const rendered = renderMemory(graph, ids, {
            maxChars,
            maxEntities: num(body.maxEntities, 30, 1, 200),
            withHistory: body.withHistory !== false,
        });
        res.json({
            memory: rendered.text,
            entities: rendered.entities,
            engine: answer.engine,
            ms: Date.now() - started,
            raw: body.debug === true ? answer.text : undefined,
        });
    }));

    router.delete('/memories/:scope', memoryRoute(async (_req, res, user, scope) => {
        graphs.forget(store.graphFile(user, scope));
        await store.deleteScope(user, scope);
        res.json({ ok: true });
    }));

    router.get('/memories/:scope/graph.html', memoryRoute(async (_req, res, user, scope) => {
        let html;
        try {
            html = await fs.readFile(store.htmlFile(user, scope), 'utf8');
        } catch {
            res.status(404).type('text/plain').send('No picture of this memory yet. It appears after the first facts are remembered.');
            return;
        }
        // The page shows text that came from chats and the AI. Sandboxing gives it an opaque
        // origin, so even if something slipped past graphify's escaping it couldn't reach
        // SillyTavern's session or API. It only needs its inline code and vis-network from unpkg.
        res.set('Content-Security-Policy', GRAPH_PAGE_CSP);
        res.set('Cache-Control', 'no-store');
        res.set('X-Content-Type-Options', 'nosniff');
        res.type('html').send(html);
    }));
}
