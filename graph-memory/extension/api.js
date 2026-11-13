// @ts-check
/**
 * Client for the Graph Memory server plugin (/api/plugins/graph-memory).
 */

export const API_BASE = '/api/plugins/graph-memory';

/**
 * @typedef {object} SegmentSummary
 * @property {string} id
 * @property {number} from
 * @property {number} to
 * @property {string} fingerprint
 * @property {number} entities
 * @property {number} relations
 */

/**
 * @typedef {object} BuildInfo
 * @property {'idle' | 'pending' | 'building'} state
 * @property {string | null} builtAt
 * @property {number} nodes
 * @property {number} edges
 * @property {number} communities
 * @property {boolean} html
 * @property {string | null} error
 */

/**
 * @typedef {object} GraphifyStatus
 * @property {boolean} ok
 * @property {string} [python]
 * @property {string} [graphifyVersion]
 * @property {boolean} [mcp]
 * @property {string} [error]
 * @property {{ python: string, error: string }[]} [tried]
 */

export class ApiError extends Error {
    /**
     * @param {string} message
     * @param {number} status
     */
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}

/**
 * @param {{ headers: () => Record<string, string>, fetch?: typeof fetch, base?: string }} deps
 */
export function createApi(deps) {
    const base = deps.base ?? API_BASE;
    const doFetch = deps.fetch ?? ((input, init) => fetch(input, init));

    /**
     * @param {string} method
     * @param {string} path
     * @param {unknown} [body]
     * @param {number} [timeoutMs]
     * @returns {Promise<any>}
     */
    async function call(method, path, body, timeoutMs = 30_000) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let res;
        try {
            res = await doFetch(base + path, {
                method,
                headers: { ...deps.headers(), 'Content-Type': 'application/json' },
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: controller.signal,
                cache: 'no-store',
            });
        } catch (err) {
            if (controller.signal.aborted) throw new ApiError('The Graph Memory server plugin took too long to answer.', 0);
            throw new ApiError(`Can't reach the Graph Memory server plugin: ${err instanceof Error ? err.message : String(err)}`, 0);
        } finally {
            clearTimeout(timer);
        }
        let data = null;
        try {
            data = await res.json();
        } catch {
            // not JSON (e.g. SillyTavern's own 404 page)
        }
        if (!res.ok) {
            if (res.status === 404 && !data) {
                throw new ApiError('The Graph Memory server plugin isn\'t running. Check that it\'s in SillyTavern\'s plugins folder and that enableServerPlugins is true in config.yaml.', 404);
            }
            throw new ApiError(data?.error ?? `Request failed (${res.status})`, res.status);
        }
        return data;
    }

    /** @param {string} scope */
    const mem = (scope) => `/memories/${encodeURIComponent(scope)}`;

    return {
        /** @returns {Promise<{ version: string, graphify: GraphifyStatus }>} */
        status: () => call('GET', '/status'),
        /** @returns {Promise<{ version: string, graphify: GraphifyStatus }>} */
        refreshStatus: () => call('POST', '/status/refresh', {}, 120_000),
        /**
         * @param {string} scope
         * @param {string} chatId
         * @returns {Promise<{ meta: { label: string } | null, build: BuildInfo, segments: SegmentSummary[] }>}
         */
        memory: (scope, chatId) => call('GET', `${mem(scope)}?chat=${encodeURIComponent(chatId)}`),
        /**
         * @param {string} scope
         * @param {number} limit
         * @returns {Promise<{ entities: { name: string, kind: string }[] }>}
         */
        entities: (scope, limit) => call('GET', `${mem(scope)}/entities?limit=${limit}`),
        /**
         * @param {string} scope
         * @param {object} body
         * @returns {Promise<{ segment: { id: string, entities: number, relations: number } }>}
         */
        addSegment: (scope, body) => call('POST', `${mem(scope)}/segments`, body),
        /**
         * @param {string} scope
         * @param {string} chatId
         * @param {string[] | null} ids
         * @returns {Promise<{ removed: number }>}
         */
        forget: (scope, chatId, ids) => call('POST', `${mem(scope)}/forget`, ids ? { chatId, ids } : { chatId }),
        /**
         * @param {string} scope
         * @returns {Promise<{ build: BuildInfo }>}
         */
        rebuild: (scope) => call('POST', `${mem(scope)}/rebuild`, {}, 300_000),
        /**
         * @param {string} scope
         * @param {{ text: string, depth: number, maxChars: number, debug?: boolean }} body
         * @param {number} timeoutMs
         * @returns {Promise<{ memory: string, entities: string[], engine: string | null, ms: number, raw?: string }>}
         */
        recall: (scope, body, timeoutMs) => call('POST', `${mem(scope)}/recall`, body, timeoutMs),
        /** @param {string} scope */
        remove: (scope) => call('DELETE', mem(scope)),
        /** @param {string} scope */
        graphUrl: (scope) => `${base}${mem(scope)}/graph.html`,
    };
}

/** @typedef {ReturnType<typeof createApi>} Api */
