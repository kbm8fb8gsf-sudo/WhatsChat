// @ts-check
/**
 * The clock is worked out from the chat itself every time, never cached:
 *
 *   start time  →  message → message → message → ... → the time now
 *
 * Each message moves the clock by its [TIME: ...] tags, or by a few minutes if it has none, then
 * by any manual changes the user made after it. Because nothing is cached, deleting, editing,
 * swiping, branching and hiding messages all keep the clock right with no extra bookkeeping.
 *
 * Per chat, chatMetadata.scenario_clock holds where the clock starts. Manual changes live in the
 * message they were made after (extra.scenario_clock.ops), so they follow that message around.
 */

import { applyInstruction, parseInstruction } from './instructions.js';
import { findTags } from './tags.js';
import { MINUTE, fromIso, toIso } from './time.js';

export const META_KEY = 'scenario_clock';
export const EXTRA_KEY = 'scenario_clock';

/**
 * @typedef {object} ChatMessageLike
 * @property {string} [mes]
 * @property {boolean} [is_user]
 * @property {boolean} [is_system]
 * @property {number} [swipe_id]
 * @property {Array<{ extra?: Record<string, unknown> } | undefined>} [swipe_info]
 * @property {Record<string, unknown>} [extra]
 */

/**
 * @typedef {object} ChatClock
 * @property {number} start The time just after message `startIndex`.
 * @property {number} startIndex -1 means the clock starts before the first message, so the
 *   opening message's own tags count. Messages up to this index have no time of their own.
 * @property {Array<{ from: number, minutes: number }>} rates Minutes added by a message with
 *   no tag, from message `from` onwards. Sorted by `from`. A change only affects later messages.
 */

/**
 * @typedef {object} Timeline
 * @property {(number | null)[]} times The time after each message, or null if it's before the clock started.
 * @property {number} origin Day 1 of the story.
 * @property {number} current The time after the last message.
 */

/**
 * @param {unknown} raw chatMetadata.scenario_clock
 * @returns {ChatClock | null}
 */
export function readClock(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const record = /** @type {Record<string, unknown>} */ (raw);
    const start = fromIso(record['start']);
    if (start === null) return null;
    const startIndex = Number.isInteger(record['startIndex']) ? Math.max(-1, Number(record['startIndex'])) : -1;
    /** @type {ChatClock['rates']} */
    const rates = [];
    if (Array.isArray(record['rates'])) {
        for (const rate of record['rates']) {
            const from = Number(rate?.from);
            const minutes = Number(rate?.minutes);
            if (Number.isInteger(from) && from >= 0 && Number.isFinite(minutes) && minutes >= 0) {
                rates.push({ from, minutes });
            }
        }
    }
    rates.sort((a, b) => a.from - b.from);
    return { start, startIndex, rates };
}

/**
 * The form saved in chat metadata.
 * @param {ChatClock} clock
 */
export function writeClock(clock) {
    return {
        start: toIso(clock.start),
        startIndex: clock.startIndex,
        rates: clock.rates.map(({ from, minutes }) => ({ from, minutes })),
    };
}

/**
 * @param {number} start
 * @param {number} startIndex
 * @param {number} minutesPerMessage
 * @returns {ChatClock}
 */
export function newClock(start, startIndex, minutesPerMessage) {
    return { start, startIndex, rates: [{ from: 0, minutes: minutesPerMessage }] };
}

/**
 * @param {ChatClock} clock
 * @param {number} index
 */
export function rateAt(clock, index) {
    let minutes = 0;
    for (const rate of clock.rates) {
        if (rate.from > index) break;
        minutes = rate.minutes;
    }
    return minutes;
}

/**
 * Changes the minutes-per-message from message `from` onwards, leaving earlier messages as they were.
 * @param {ChatClock} clock
 * @param {number} from
 * @param {number} minutes
 * @returns {ChatClock}
 */
export function withRate(clock, from, minutes) {
    const rates = clock.rates.filter((rate) => rate.from < from);
    rates.push({ from: Math.max(0, from), minutes });
    return { ...clock, rates };
}

/**
 * After messages are deleted (or in a branch made from an earlier message), anything pointing
 * past the end of the chat is pulled back, so new messages there aren't skipped.
 * @param {ChatClock} clock
 * @param {number} chatLength
 * @returns {ChatClock | null} The fixed clock, or null if nothing needed changing.
 */
export function clampClock(clock, chatLength) {
    const startIndex = Math.min(clock.startIndex, chatLength - 1);
    const beyond = clock.rates.filter((rate) => rate.from > chatLength);
    const latest = beyond[beyond.length - 1];
    const rates = latest
        ? [...clock.rates.filter((rate) => rate.from < chatLength), { from: chatLength, minutes: latest.minutes }]
        : clock.rates;
    if (startIndex === clock.startIndex && !latest) return null;
    return { ...clock, startIndex, rates };
}

/**
 * Messages SillyTavern adds itself (help, comments, tool calls) don't move the clock.
 * Narrator messages (/sys) do: they're part of the story.
 * @param {ChatMessageLike} message
 */
export function isStoryMessage(message) {
    const type = message.extra?.['type'];
    if (typeof type === 'string' && type !== 'narrator') return false;
    return !Array.isArray(message.extra?.['tool_invocations']);
}

/**
 * Manual changes made after this message.
 * @param {ChatMessageLike} message
 * @returns {string[]}
 */
export function manualOps(message) {
    const record = message.extra?.[EXTRA_KEY];
    if (!record || typeof record !== 'object') return [];
    const ops = /** @type {Record<string, unknown>} */ (record)['ops'];
    return Array.isArray(ops) ? ops.filter((op) => typeof op === 'string') : [];
}

/**
 * The time after a message, given the time before it.
 * @param {ChatMessageLike} message
 * @param {number} index
 * @param {number} before
 * @param {ChatClock} clock
 */
export function advance(message, index, before, clock) {
    let time = before;
    if (isStoryMessage(message)) {
        const tags = findTags(message.mes);
        if (tags.length > 0) {
            for (const tag of tags) time = applyInstruction(tag.parsed, time) ?? time;
        } else if (index > 0) {
            time += rateAt(clock, index) * MINUTE;
        }
    }
    for (const op of manualOps(message)) {
        const instruction = parseInstruction(op);
        if (instruction) time = applyInstruction(instruction, time) ?? time;
    }
    return time;
}

/**
 * @param {ChatMessageLike[]} chat
 * @param {ChatClock} clock
 * @returns {Timeline}
 */
export function buildTimeline(chat, clock) {
    /** @type {(number | null)[]} */
    const times = [];
    let time = clock.start;
    for (let index = 0; index < chat.length; index++) {
        const message = chat[index];
        if (index < clock.startIndex || !message) {
            times.push(null);
        } else if (index === clock.startIndex) {
            times.push(clock.start);
        } else {
            time = advance(message, index, time, clock);
            times.push(time);
        }
    }
    const first = clock.startIndex === -1 ? times[0] : null;
    return { times, origin: first ?? clock.start, current: time };
}

/**
 * The time just after message `index` (-1: before the first message).
 * @param {ChatMessageLike[]} chat
 * @param {ChatClock} clock
 * @param {number} index
 */
export function timeAfter(chat, clock, index) {
    if (index <= clock.startIndex) return clock.start;
    return buildTimeline(chat.slice(0, index + 1), clock).current;
}
