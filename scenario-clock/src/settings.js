// @ts-check
/** Global settings, kept in SillyTavern's extensionSettings.scenario_clock. */

import { fromIso } from './time.js';

export const SETTINGS_KEY = 'scenario_clock';

export const DEFAULT_PROMPT = '[Story clock: it is {{scenario_time}} on {{scenario_weekday}}, {{scenario_date}} '
    + '({{scenario_timeofday}}), day {{scenario_day}} of the story. This is the correct current time and date; '
    + 'it overrides any other time or date in the chat history or its summaries.]';

export const DEFAULT_TAG_HELP = 'When time passes in your reply (a scene change, travel, waiting, sleeping), '
    + 'mark it with a time tag at that point: [TIME: +20m], [TIME: +3h] or [TIME: +2d] moves the clock forward '
    + 'by that much, and [TIME: 07:30] jumps to the next 7:30. Give only the change; the clock works out the '
    + 'new date. A quick exchange of dialogue needs no tag. Never move time backwards.';

/**
 * @typedef {object} Settings
 * @property {boolean} enabled
 * @property {boolean} autoStart Start a clock in every new chat.
 * @property {'real' | 'fixed'} startMode New clocks start at the real date and time, or at `fixedStart`.
 * @property {string} fixedStart "YYYY-MM-DDTHH:MM"
 * @property {number} minutesPerMessage Default for new clocks: minutes a message adds when it has no tag.
 * @property {boolean} aiTags Ask the AI to move the clock with [TIME: ...] tags.
 * @property {'hide' | 'badge' | 'raw'} tagDisplay How tags look in the chat.
 * @property {boolean} showOnMessages Show the story time in each message's header.
 * @property {boolean} hour24
 * @property {'dmy' | 'mdy'} dateOrder
 * @property {'chat' | 'after' | 'before'} position In the chat at `depth`, after the main prompt, or before it.
 * @property {number} depth
 * @property {'system' | 'user' | 'assistant'} role
 * @property {string} promptTemplate
 * @property {string} tagTemplate
 */

/** @type {Readonly<Settings>} */
export const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    autoStart: true,
    startMode: 'real',
    fixedStart: '2025-06-01T09:00',
    minutesPerMessage: 1,
    aiTags: true,
    tagDisplay: 'hide',
    showOnMessages: true,
    hour24: false,
    dateOrder: 'dmy',
    position: 'chat',
    depth: 0,
    role: 'system',
    promptTemplate: DEFAULT_PROMPT,
    tagTemplate: DEFAULT_TAG_HELP,
});

/** SillyTavern's extension_prompt_types. */
export const POSITION_VALUES = { after: 0, chat: 1, before: 2 };
/** SillyTavern's extension_prompt_roles. */
export const ROLE_VALUES = { system: 0, user: 1, assistant: 2 };

/**
 * Fills in anything missing or invalid with the default.
 * @param {unknown} raw
 * @returns {Settings}
 */
export function normalizeSettings(raw) {
    const input = raw && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {};
    const d = DEFAULT_SETTINGS;
    return {
        enabled: bool(input['enabled'], d.enabled),
        autoStart: bool(input['autoStart'], d.autoStart),
        startMode: oneOf(input['startMode'], ['real', 'fixed'], d.startMode),
        fixedStart: fromIso(input['fixedStart']) === null ? d.fixedStart : String(input['fixedStart']).trim(),
        minutesPerMessage: number(input['minutesPerMessage'], d.minutesPerMessage, 0, 24 * 60),
        aiTags: bool(input['aiTags'], d.aiTags),
        tagDisplay: oneOf(input['tagDisplay'], ['hide', 'badge', 'raw'], d.tagDisplay),
        showOnMessages: bool(input['showOnMessages'], d.showOnMessages),
        hour24: bool(input['hour24'], d.hour24),
        dateOrder: oneOf(input['dateOrder'], ['dmy', 'mdy'], d.dateOrder),
        position: oneOf(input['position'], ['chat', 'after', 'before'], d.position),
        depth: Math.round(number(input['depth'], d.depth, 0, 10000)),
        role: oneOf(input['role'], ['system', 'user', 'assistant'], d.role),
        promptTemplate: typeof input['promptTemplate'] === 'string' ? input['promptTemplate'] : d.promptTemplate,
        tagTemplate: typeof input['tagTemplate'] === 'string' ? input['tagTemplate'] : d.tagTemplate,
    };
}

/**
 * @param {unknown} value
 * @param {boolean} fallback
 */
function bool(value, fallback) {
    return typeof value === 'boolean' ? value : fallback;
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 */
function number(value, fallback, min, max) {
    const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/**
 * @template {string} T
 * @param {unknown} value
 * @param {readonly T[]} options
 * @param {T} fallback
 * @returns {T}
 */
function oneOf(value, options, fallback) {
    return options.includes(/** @type {T} */ (value)) ? /** @type {T} */ (value) : fallback;
}
