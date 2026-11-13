// @ts-check
/**
 * Validation and clean-up of what the extension sends: a slice of chat plus the story facts
 * the AI extracted from it. Everything here is untrusted (it came from a model reading chat
 * text), so every field is type-checked, trimmed and length-capped before it is stored.
 */

export const LIMITS = Object.freeze({
    chatId: 300,
    label: 120,
    name: 80,
    kind: 24,
    description: 400,
    relation: 40,
    detail: 200,
    aliases: 6,
    entities: 200,
    relations: 400,
    transcript: 400_000,
    segmentMessages: 500,
    fingerprint: 128,
});

/** Kinds the extraction prompt asks for. Anything else is kept but shown as "thing". */
export const KNOWN_KINDS = Object.freeze([
    'character', 'person', 'creature', 'place', 'item', 'group', 'event', 'fact', 'concept',
]);

/**
 * @typedef {object} Entity
 * @property {string} name
 * @property {string} kind
 * @property {string} description
 * @property {string[]} aliases
 */

/**
 * @typedef {object} Relation
 * @property {string} source
 * @property {string} relation
 * @property {string} target
 * @property {string} detail
 */

/**
 * @typedef {object} SegmentInput
 * @property {string} chatId
 * @property {string} chatLabel
 * @property {string} scopeLabel
 * @property {number} from   index of the first message in the slice (SillyTavern's message id)
 * @property {number} to     one past the last message
 * @property {string} fingerprint  the extension's hash of the slice's text, to notice later edits
 * @property {string} transcript
 * @property {Entity[]} entities
 * @property {Relation[]} relations
 */

/**
 * @param {unknown} value
 * @param {number} max
 * @returns {string}
 */
export function cleanText(value, max) {
    if (typeof value !== 'string') return '';
    // eslint-disable-next-line no-control-regex
    const text = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (text.length <= max) return text;
    return text.slice(0, max - 1).trimEnd() + '…';
}

/**
 * A display name: trimmed, no wrapping quotes or markdown emphasis.
 * @param {unknown} value
 * @returns {string}
 */
export function cleanName(value) {
    let text = cleanText(value, LIMITS.name * 2);
    text = text.replace(/^[\s"'`*_~“”‘’]+|[\s"'`*_~“”‘’.,;:!?]+$/gu, '');
    return cleanText(text, LIMITS.name);
}

/**
 * Canonical id for an entity name, so "The Silver Amulet", "silver amulet" and
 * "Silver  Amulet" all become `silver_amulet` and merge into one memory.
 * Uses graphify's own id alphabet: lowercase letters, digits and underscores.
 * @param {string} name
 * @returns {string} empty when the name has no letters or digits
 */
export function entityId(name) {
    const folded = name
        .normalize('NFKD')
        .replace(/\p{M}+/gu, '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '_')
        .replace(/^_+|_+$/g, '');
    const withoutArticle = folded.replace(/^(the|a|an)_(?=.)/, '');
    return withoutArticle.slice(0, 96);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function cleanKind(value) {
    const kind = cleanText(value, LIMITS.kind).toLowerCase();
    if (kind === 'npc' || kind === 'people') return 'person';
    if (kind === 'location') return 'place';
    if (kind === 'object') return 'item';
    if (kind === 'faction' || kind === 'organization' || kind === 'organisation') return 'group';
    if (kind === 'animal' || kind === 'monster') return 'creature';
    return KNOWN_KINDS.includes(kind) ? kind : 'thing';
}

/**
 * "Gave Gift To" / "gave-gift-to" -> "gave_gift_to"
 * @param {unknown} value
 * @returns {string}
 */
export function cleanRelation(value) {
    return cleanText(value, LIMITS.relation * 2)
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, LIMITS.relation);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function index(value) {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 10_000_000 ? value : null;
}

/**
 * @param {unknown} raw
 * @returns {Entity[]}
 */
export function normalizeEntities(raw) {
    if (!Array.isArray(raw)) return [];
    /** @type {Map<string, Entity>} */
    const byId = new Map();
    for (const item of raw.slice(0, LIMITS.entities * 2)) {
        if (!isObject(item)) continue;
        const name = cleanName(item.name);
        const id = entityId(name);
        if (!id) continue;
        const aliases = Array.isArray(item.aliases)
            ? [...new Set(item.aliases.map(cleanName).filter((a) => a && entityId(a) && entityId(a) !== id))].slice(0, LIMITS.aliases)
            : [];
        const entity = {
            name,
            kind: cleanKind(item.kind ?? item.type),
            description: cleanText(item.description ?? item.summary, LIMITS.description),
            aliases,
        };
        const existing = byId.get(id);
        if (existing) {
            // The model listed the same thing twice: keep the fuller description.
            if (entity.description.length > existing.description.length) existing.description = entity.description;
            existing.aliases = [...new Set([...existing.aliases, ...aliases])].slice(0, LIMITS.aliases);
            if (existing.kind === 'thing') existing.kind = entity.kind;
        } else {
            byId.set(id, entity);
        }
        if (byId.size >= LIMITS.entities) break;
    }
    return [...byId.values()];
}

/**
 * @param {unknown} raw
 * @returns {Relation[]}
 */
export function normalizeRelations(raw) {
    if (!Array.isArray(raw)) return [];
    /** @type {Map<string, Relation>} */
    const out = new Map();
    for (const item of raw.slice(0, LIMITS.relations * 2)) {
        if (!isObject(item)) continue;
        const source = cleanName(item.source ?? item.from ?? item.subject);
        const target = cleanName(item.target ?? item.to ?? item.object);
        const relation = cleanRelation(item.relation ?? item.type ?? item.predicate);
        if (!entityId(source) || !entityId(target) || !relation) continue;
        if (entityId(source) === entityId(target)) continue;
        const key = `${entityId(source)}|${relation}|${entityId(target)}`;
        const detail = cleanText(item.detail ?? item.description ?? item.note, LIMITS.detail);
        const existing = out.get(key);
        if (existing) {
            if (detail.length > existing.detail.length) existing.detail = detail;
            continue;
        }
        out.set(key, { source, relation, target, detail });
        if (out.size >= LIMITS.relations) break;
    }
    return [...out.values()];
}

/**
 * @param {unknown} body
 * @returns {{ ok: true, value: SegmentInput } | { ok: false, error: string }}
 */
export function parseSegmentInput(body) {
    if (!isObject(body)) return { ok: false, error: 'Expected a JSON object.' };
    const chatId = typeof body.chatId === 'string' ? body.chatId.trim() : '';
    if (!chatId || chatId.length > LIMITS.chatId) return { ok: false, error: 'chatId is missing or too long.' };
    const from = index(body.from);
    const to = index(body.to);
    if (from === null || to === null || to <= from) return { ok: false, error: 'from/to must be message indexes with from < to.' };
    if (to - from > LIMITS.segmentMessages) return { ok: false, error: `A segment can hold at most ${LIMITS.segmentMessages} messages.` };
    const fingerprint = typeof body.fingerprint === 'string' ? body.fingerprint.slice(0, LIMITS.fingerprint) : '';
    if (typeof body.transcript !== 'string') return { ok: false, error: 'transcript must be a string.' };
    if (body.transcript.length > LIMITS.transcript) return { ok: false, error: 'transcript is too long.' };
    return {
        ok: true,
        value: {
            chatId,
            chatLabel: cleanText(body.chatLabel, LIMITS.label) || chatId.slice(0, LIMITS.label),
            scopeLabel: cleanText(body.scopeLabel, LIMITS.label),
            from,
            to,
            fingerprint,
            transcript: body.transcript,
            entities: normalizeEntities(body.entities),
            relations: normalizeRelations(body.relations),
        },
    };
}

/** Scope ids are made by the extension (e.g. `chat-1a2b…`); they become folder names. */
export const SCOPE_ID_RE = /^(chat|char|group)-[a-f0-9]{8,64}$/;

/** SillyTavern user handles: lowercase letters, digits, dashes and underscores. */
export const USER_HANDLE_RE = /^[a-z0-9_-]{1,64}$/;
