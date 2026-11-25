// @ts-check
/** The text given to the AI, and the {{scenario_*}} macros it's built from. */

import {
    dayNumber, formatDate, formatFull, formatTime, formatWeekday, timeOfDay, toIso,
} from './time.js';

/** Macro name → what it gives. Also used for SillyTavern's macro list. */
export const MACROS = {
    scenario_time: 'The story time, e.g. "9:42 PM".',
    scenario_date: 'The story date, e.g. "14 March 2024".',
    scenario_weekday: 'The story weekday, e.g. "Thursday".',
    scenario_timeofday: 'The part of the day in words, e.g. "evening".',
    scenario_day: 'Which day of the story it is, starting at 1.',
    scenario_datetime: 'Weekday, date and time, e.g. "Thursday, 14 March 2024, 9:42 PM".',
    scenario_iso: 'Date and time as "2024-03-14T21:42".',
};

/** @typedef {keyof typeof MACROS} MacroName */

/**
 * @param {number} time
 * @param {number} origin Day 1 of the story.
 * @param {import('./time.js').FormatOptions} options
 * @returns {Record<MacroName, string>}
 */
export function macroValues(time, origin, options) {
    return {
        scenario_time: formatTime(time, options),
        scenario_date: formatDate(time, options),
        scenario_weekday: formatWeekday(time),
        scenario_timeofday: timeOfDay(time),
        scenario_day: String(dayNumber(time, origin)),
        scenario_datetime: formatFull(time, options),
        scenario_iso: toIso(time),
    };
}

/**
 * Fills in {{scenario_*}} macros. Other macros are left for SillyTavern.
 * @param {string} template
 * @param {Record<string, string>} values
 */
export function renderTemplate(template, values) {
    return template.replace(/\{\{\s*(scenario_[a-z]+)\s*\}\}/gi, (whole, name) => {
        const value = values[String(name).toLowerCase()];
        return value === undefined ? whole : value;
    });
}

/**
 * @param {object} input
 * @param {number} input.time
 * @param {number} input.origin
 * @param {import('./settings.js').Settings} input.settings
 * @param {boolean} input.withTagHelp
 */
export function buildPrompt({ time, origin, settings, withTagHelp }) {
    const values = macroValues(time, origin, settings);
    const parts = [renderTemplate(settings.promptTemplate, values).trim()];
    if (withTagHelp) parts.push(renderTemplate(settings.tagTemplate, values).trim());
    return parts.filter(Boolean).join('\n');
}
