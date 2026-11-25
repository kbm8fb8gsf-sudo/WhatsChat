// @ts-check
/**
 * Everything that reads or changes the clock of the open chat. SillyTavern is reached only
 * through the `getContext` passed in, so tests can use a fake.
 */

import { applyInstructionText, parseInstruction } from './instructions.js';
import { buildPrompt, macroValues } from './prompt.js';
import { POSITION_VALUES, ROLE_VALUES } from './settings.js';
import { fromIso, fromLocalDate } from './time.js';
import {
    EXTRA_KEY, META_KEY, buildTimeline, clampClock, manualOps, newClock, rateAt, readClock, timeAfter, withRate,
    writeClock,
} from './timeline.js';

export const PROMPT_KEY = 'scenario_clock';

/**
 * The part of SillyTavern's getContext() this extension uses.
 * @typedef {object} ClockContext
 * @property {import('./timeline.js').ChatMessageLike[]} chat
 * @property {Record<string, unknown> | undefined} chatMetadata
 * @property {() => string | undefined} [getCurrentChatId]
 * @property {string | undefined} [chatId]
 * @property {() => Promise<void>} saveMetadata
 * @property {() => Promise<void>} saveChat
 * @property {(key: string, value: string, position: number, depth: number, scan?: boolean, role?: number) => void} setExtensionPrompt
 */

/**
 * @typedef {object} ClockState
 * @property {import('./timeline.js').ChatClock} clock
 * @property {import('./timeline.js').Timeline} timeline
 */

/**
 * @typedef {object} Change
 * @property {number} before
 * @property {number} after
 */

/**
 * @param {object} deps
 * @param {() => ClockContext} deps.getContext
 * @param {() => import('./settings.js').Settings} deps.getSettings
 * @param {() => Date} [deps.now] The real date and time, for clocks that start "now".
 */
export function createController({ getContext, getSettings, now = () => new Date() }) {
    /** The type of the generation in progress, so a swipe doesn't count the message it replaces. */
    /** @type {string | null} */
    let generationType = null;

    function hasChat() {
        const ctx = getContext();
        const id = ctx.getCurrentChatId ? ctx.getCurrentChatId() : ctx.chatId;
        return Boolean(id) && Boolean(ctx.chatMetadata);
    }

    /** @returns {import('./timeline.js').ChatClock | null} */
    function readChatClock() {
        const ctx = getContext();
        if (!hasChat()) return null;
        return readClock(ctx.chatMetadata?.[META_KEY]);
    }

    /** @returns {ClockState | null} */
    function state() {
        const clock = readChatClock();
        if (!clock) return null;
        return { clock, timeline: buildTimeline(getContext().chat, clock) };
    }

    /**
     * The time the next reply happens at. During a swipe, the message being replaced is left out.
     * @param {string | null} [type]
     * @returns {{ time: number, origin: number } | null}
     */
    function timeForGeneration(type = generationType) {
        const current = state();
        if (!current) return null;
        const chat = getContext().chat;
        const lastIndex = type === 'swipe' ? chat.length - 2 : chat.length - 1;
        return { time: timeAfter(chat, current.clock, lastIndex), origin: current.timeline.origin };
    }

    /**
     * Sets (or clears) the text SillyTavern adds to the prompt.
     * @param {string | null} [type] The generation type, when called just before generating.
     */
    function updatePrompt(type = generationType) {
        const settings = getSettings();
        const ctx = getContext();
        const position = POSITION_VALUES[settings.position];
        const role = ROLE_VALUES[settings.role];
        const target = settings.enabled ? timeForGeneration(type) : null;
        const text = target
            ? buildPrompt({ ...target, settings, withTagHelp: settings.aiTags && type !== 'quiet' })
            : '';
        ctx.setExtensionPrompt(PROMPT_KEY, text, position, settings.depth, false, role);
    }

    /** @param {string | null} type */
    function setGenerationType(type) {
        generationType = type;
    }

    /** @returns {Record<string, string> | null} */
    function currentMacroValues() {
        if (!getSettings().enabled) return null;
        const target = timeForGeneration();
        return target ? macroValues(target.time, target.origin, getSettings()) : null;
    }

    /** @param {import('./timeline.js').ChatClock} clock */
    async function saveClock(clock) {
        const ctx = getContext();
        if (!ctx.chatMetadata) throw new Error('Open a chat first.');
        ctx.chatMetadata[META_KEY] = writeClock(clock);
        await ctx.saveMetadata();
    }

    /** The start time for a new clock, from the settings. */
    function defaultStart() {
        const settings = getSettings();
        if (settings.startMode === 'fixed') {
            const fixed = fromIso(settings.fixedStart);
            if (fixed !== null) return fixed;
        }
        return fromLocalDate(now());
    }

    /**
     * Starts (or restarts) the clock so it reads `time` right now, after the latest message.
     * @param {number} time
     */
    async function start(time) {
        if (!hasChat()) throw new Error('Open a chat first.');
        const chat = getContext().chat;
        await saveClock(newClock(time, chat.length - 1, getSettings().minutesPerMessage));
    }

    /**
     * Gives a brand-new chat (nothing from the user yet, only greetings) a clock. It starts
     * before the opening messages, so a [TIME: ...] tag in a character's greeting sets the scene.
     * @returns {Promise<boolean>} Whether a clock was started.
     */
    async function autoStart() {
        const settings = getSettings();
        if (!settings.enabled || !settings.autoStart || !hasChat() || readChatClock()) return false;
        if (getContext().chat.some((message) => message.is_user)) return false;
        await saveClock(newClock(defaultStart(), -1, settings.minutesPerMessage));
        return true;
    }

    async function stop() {
        const ctx = getContext();
        if (!ctx.chatMetadata || !(META_KEY in ctx.chatMetadata)) return;
        delete ctx.chatMetadata[META_KEY];
        await ctx.saveMetadata();
    }

    /**
     * Pulls the clock back after messages past its start were deleted.
     * @returns {Promise<boolean>} Whether anything changed.
     */
    async function repair() {
        const clock = readChatClock();
        if (!clock) return false;
        const fixed = clampClock(clock, getContext().chat.length);
        if (!fixed) return false;
        await saveClock(fixed);
        return true;
    }

    /**
     * Moves or sets the clock by hand, e.g. "+2h", "07:30", "2024-03-15 18:00". The change is
     * stored with the latest message, so deleting that message (or swiping to another reply)
     * undoes it.
     * @param {string} text
     * @returns {Promise<Change>}
     */
    async function adjust(text) {
        const instruction = text.trim();
        const current = state();
        if (!current) throw new Error('This chat has no clock yet. Start one first.');
        if (!parseInstruction(instruction)) throw new Error(`"${instruction}" isn't a time change I understand.`);
        const before = current.timeline.current;
        const after = applyInstructionText(instruction, before);
        if (after === null) throw new Error('That would move the clock outside the years 1 to 9999.');

        const ctx = getContext();
        const lastIndex = ctx.chat.length - 1;
        const last = ctx.chat[lastIndex];
        if (!last || lastIndex <= current.clock.startIndex) {
            await saveClock({ ...current.clock, start: after });
        } else {
            setOps(last, [...manualOps(last), instruction]);
            await ctx.saveChat();
        }
        return { before, after };
    }

    /**
     * Removes the last manual change made after the latest message.
     * @returns {Promise<Change | null>} Null if there was nothing to undo.
     */
    async function undo() {
        const current = state();
        const ctx = getContext();
        const last = ctx.chat[ctx.chat.length - 1];
        if (!current || !last) return null;
        const ops = manualOps(last);
        if (ops.length === 0) return null;
        setOps(last, ops.slice(0, -1));
        await ctx.saveChat();
        return { before: current.timeline.current, after: buildTimeline(ctx.chat, current.clock).current };
    }

    /** Manual changes after the latest message, newest last. */
    function pendingOps() {
        const chat = getContext().chat;
        const last = chat[chat.length - 1];
        const clock = readChatClock();
        if (!last || !clock || chat.length - 1 <= clock.startIndex) return [];
        return manualOps(last);
    }

    function minutesPerMessage() {
        const clock = readChatClock();
        return clock ? rateAt(clock, getContext().chat.length) : getSettings().minutesPerMessage;
    }

    /**
     * Changes how long a message with no tag takes, for this chat's future messages only.
     * @param {number} minutes
     */
    async function setMinutesPerMessage(minutes) {
        const clock = readChatClock();
        if (!clock) return;
        await saveClock(withRate(clock, getContext().chat.length, minutes));
    }

    return {
        hasChat,
        state,
        updatePrompt,
        setGenerationType,
        currentMacroValues,
        defaultStart,
        start,
        autoStart,
        stop,
        repair,
        adjust,
        undo,
        pendingOps,
        minutesPerMessage,
        setMinutesPerMessage,
    };
}

/** @typedef {ReturnType<typeof createController>} Controller */

/**
 * Stores manual changes on a message, and on its current swipe so SillyTavern keeps them when
 * swiping back and forth.
 * @param {import('./timeline.js').ChatMessageLike} message
 * @param {string[]} ops
 */
function setOps(message, ops) {
    const targets = [message];
    const swipe = typeof message.swipe_id === 'number' ? message.swipe_info?.[message.swipe_id] : undefined;
    if (swipe) targets.push(swipe);
    for (const target of targets) {
        target.extra ??= {};
        if (ops.length > 0) {
            target.extra[EXTRA_KEY] = { ops: [...ops] };
        } else {
            delete target.extra[EXTRA_KEY];
        }
    }
}
