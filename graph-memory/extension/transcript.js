// @ts-check
/**
 * Pure helpers over SillyTavern's chat array: which slice to remember next, what it says,
 * whether an already-remembered slice has since been edited, and what text to search
 * the memory with.
 */

/**
 * @typedef {object} ChatMessage
 * @property {string} [name]
 * @property {string} [mes]
 * @property {boolean} [is_user]
 * @property {boolean} [is_system]
 */

/**
 * @typedef {object} SegmentInfo
 * @property {string} id
 * @property {number} from
 * @property {number} to
 * @property {string} fingerprint
 */

/**
 * Two FNV-1a passes with different seeds: a 16-hex-digit hash that works without
 * crypto.subtle (which browsers only offer on https or localhost).
 * @param {string} text
 * @returns {string}
 */
export function hash64(text) {
    let a = 0x811c9dc5;
    let b = 0x01000193 ^ 0x5bd1e995;
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        a = Math.imul(a ^ c, 0x01000193);
        b = Math.imul(b ^ c, 0x01000193) ^ (b >>> 15);
    }
    return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

/** @param {ChatMessage | undefined} msg */
function isStoryMessage(msg) {
    return !!msg && !msg.is_system && typeof msg.mes === 'string' && msg.mes.trim().length > 0;
}

/**
 * Message text as the story reads: no reasoning blocks, no HTML comments, tidy whitespace.
 * @param {string} text
 * @param {number} max
 */
export function cleanMessage(text, max) {
    const t = text
        .replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * `[#12] Seraphina: …` lines for messages [from, to). Hidden (system) messages are left out.
 * @param {ChatMessage[]} chat
 * @param {number} from
 * @param {number} to
 * @param {number} [maxPerMessage]
 */
export function transcript(chat, from, to, maxPerMessage = 4000) {
    /** @type {string[]} */
    const lines = [];
    for (let i = Math.max(0, from); i < Math.min(to, chat.length); i++) {
        const msg = chat[i];
        if (!isStoryMessage(msg)) continue;
        const name = (msg?.name ?? (msg?.is_user ? 'User' : 'Character')).trim();
        lines.push(`[#${i}] ${name}: ${cleanMessage(msg?.mes ?? '', maxPerMessage)}`);
    }
    return lines.join('\n\n');
}

/**
 * Changes when any message in [from, to) is edited, swiped, deleted, hidden or unhidden.
 * @param {ChatMessage[]} chat
 * @param {number} from
 * @param {number} to
 */
export function fingerprint(chat, from, to) {
    let text = `${from}:${to}`;
    for (let i = from; i < to; i++) {
        const msg = chat[i];
        if (!msg) return `missing-${hash64(text)}`;
        text += `\u0001${msg.is_system ? 'h' : 'v'}\u0002${msg.name ?? ''}\u0002${msg.mes ?? ''}`;
    }
    return hash64(text);
}

/**
 * Remembered slices whose messages have changed (or no longer exist) since.
 * @param {ChatMessage[]} chat
 * @param {SegmentInfo[]} segments
 * @returns {string[]}
 */
export function staleSegments(chat, segments) {
    return segments.filter((s) => s.to > chat.length || fingerprint(chat, s.from, s.to) !== s.fingerprint).map((s) => s.id);
}

/**
 * The next slice of chat to remember, or null when there's nothing worth doing yet.
 * Holes before the newest remembered slice (left by edits) are always filled. New messages
 * at the end wait until there are `minNew` of them. The newest `holdBack` messages are left
 * alone because they may still be swiped or edited.
 * @param {number} chatLength
 * @param {Pick<SegmentInfo, 'from' | 'to'>[]} segments
 * @param {{ holdBack: number, minNew: number, maxSegment: number }} opts
 * @returns {{ from: number, to: number } | null}
 */
export function planNextSegment(chatLength, segments, opts) {
    const end = Math.max(0, chatLength - Math.max(0, opts.holdBack));
    const sorted = [...segments].sort((a, b) => a.from - b.from);
    let cursor = 0;
    for (const s of sorted) {
        if (s.from > cursor) {
            const to = Math.min(s.from, end, cursor + opts.maxSegment);
            if (to > cursor) return { from: cursor, to };
        }
        cursor = Math.max(cursor, s.to);
    }
    if (end - cursor >= Math.max(1, opts.minNew)) {
        return { from: cursor, to: Math.min(end, cursor + opts.maxSegment) };
    }
    return null;
}

/**
 * How far the remembered part reaches without gaps (for "remembered up to #N").
 * @param {Pick<SegmentInfo, 'from' | 'to'>[]} segments
 */
export function coveredUpTo(segments) {
    let cursor = 0;
    for (const s of [...segments].sort((a, b) => a.from - b.from)) {
        if (s.from > cursor) break;
        cursor = Math.max(cursor, s.to);
    }
    return cursor;
}

/**
 * What to search the memory with: the newest messages, newest first, so the latest turn
 * always survives the length cap.
 * @param {ChatMessage[]} chat
 * @param {number} recent how many story messages to use
 * @param {number} [maxChars]
 */
export function queryText(chat, recent, maxChars = 2000) {
    /** @type {string[]} */
    const parts = [];
    let used = 0;
    for (let i = chat.length - 1; i >= 0 && parts.length < recent; i--) {
        const msg = chat[i];
        if (!isStoryMessage(msg)) continue;
        const text = cleanMessage(msg?.mes ?? '', maxChars);
        if (used + text.length > maxChars) {
            if (parts.length === 0) parts.push(text.slice(0, maxChars));
            break;
        }
        parts.push(text);
        used += text.length + 1;
    }
    return parts.join('\n');
}
