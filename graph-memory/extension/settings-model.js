// @ts-check
/**
 * Graph Memory's settings, kept in SillyTavern's extension settings under `graphMemory`.
 */

export const SETTINGS_KEY = 'graphMemory';

export const DEFAULT_TEMPLATE = "[Long-term memory: what the story has established so far. Use it for continuity; don't recite it.]\n{{memory}}";

/**
 * @typedef {object} Settings
 * @property {boolean} enabled
 * @property {'chat' | 'character'} scope   one memory per chat, or one per character/group shared by its chats
 * @property {object} recall
 * @property {boolean} recall.enabled
 * @property {number} recall.recentMessages  newest messages used to search the memory
 * @property {number} recall.graphDepth      how far graphify walks from the matches (1–6)
 * @property {number} recall.maxChars
 * @property {'in_chat' | 'before_prompt' | 'in_prompt'} recall.position
 * @property {number} recall.depth           for in_chat: how many messages from the end
 * @property {'system' | 'user' | 'assistant'} recall.role
 * @property {string} recall.template
 * @property {object} extract
 * @property {boolean} extract.auto
 * @property {number} extract.every         remember after this many new messages
 * @property {number} extract.holdBack      leave the newest messages until they settle
 * @property {number} extract.maxSegment    most messages read in one go
 * @property {number} extract.contextMessages  earlier messages shown to the AI for context
 * @property {string} extract.profileId     connection profile to use; '' = the current connection
 * @property {number} extract.responseTokens
 */

/** @type {Settings} */
export const DEFAULTS = Object.freeze({
    enabled: true,
    scope: 'chat',
    recall: Object.freeze({
        enabled: true,
        recentMessages: 3,
        graphDepth: 2,
        maxChars: 2000,
        position: 'in_chat',
        depth: 4,
        role: 'system',
        template: DEFAULT_TEMPLATE,
    }),
    extract: Object.freeze({
        auto: true,
        every: 8,
        holdBack: 2,
        maxSegment: 24,
        contextMessages: 2,
        profileId: '',
        responseTokens: 1500,
    }),
});

/**
 * @param {unknown} v
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 */
function int(v, fallback, min, max) {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * @template {string} T
 * @param {unknown} v
 * @param {readonly T[]} allowed
 * @param {T} fallback
 * @returns {T}
 */
function oneOf(v, allowed, fallback) {
    return allowed.includes(/** @type {T} */ (v)) ? /** @type {T} */ (v) : fallback;
}

/**
 * Fills in defaults and clamps everything to sensible ranges.
 * @param {any} raw
 * @returns {Settings}
 */
export function normalizeSettings(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const rc = r.recall && typeof r.recall === 'object' ? r.recall : {};
    const ex = r.extract && typeof r.extract === 'object' ? r.extract : {};
    const d = DEFAULTS;
    return {
        enabled: typeof r.enabled === 'boolean' ? r.enabled : d.enabled,
        scope: oneOf(r.scope, /** @type {const} */ (['chat', 'character']), d.scope),
        recall: {
            enabled: typeof rc.enabled === 'boolean' ? rc.enabled : d.recall.enabled,
            recentMessages: int(rc.recentMessages, d.recall.recentMessages, 1, 20),
            graphDepth: int(rc.graphDepth, d.recall.graphDepth, 1, 6),
            maxChars: int(rc.maxChars, d.recall.maxChars, 200, 20000),
            position: oneOf(rc.position, /** @type {const} */ (['in_chat', 'before_prompt', 'in_prompt']), d.recall.position),
            depth: int(rc.depth, d.recall.depth, 0, 100),
            role: oneOf(rc.role, /** @type {const} */ (['system', 'user', 'assistant']), d.recall.role),
            template: typeof rc.template === 'string' && rc.template.includes('{{memory}}') ? rc.template : d.recall.template,
        },
        extract: {
            auto: typeof ex.auto === 'boolean' ? ex.auto : d.extract.auto,
            every: int(ex.every, d.extract.every, 1, 200),
            holdBack: int(ex.holdBack, d.extract.holdBack, 0, 20),
            maxSegment: int(ex.maxSegment, d.extract.maxSegment, 2, 200),
            contextMessages: int(ex.contextMessages, d.extract.contextMessages, 0, 10),
            profileId: typeof ex.profileId === 'string' ? ex.profileId : d.extract.profileId,
            responseTokens: int(ex.responseTokens, d.extract.responseTokens, 200, 16000),
        },
    };
}

/** extension_prompt_types / extension_prompt_roles values in SillyTavern 1.19. */
export const POSITION_VALUES = Object.freeze({ in_prompt: 0, in_chat: 1, before_prompt: 2 });
export const ROLE_VALUES = Object.freeze({ system: 0, user: 1, assistant: 2 });
