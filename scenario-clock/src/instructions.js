// @ts-check
/**
 * Time instructions: the text inside a [TIME: ...] tag, a /clock command or the panel's box.
 *
 * They say how the clock moves, never the resulting date, because models are good at "8 hours
 * pass" and "it's now 7:30" but bad at calendar arithmetic. Accepted forms, combinable:
 *
 *   +45m  +2h30m  +3 days  +1w  +2mo  +1y  -15m   move by a duration
 *   07:30  7:30pm  7pm  noon  midnight             the next time the clock shows that time
 *   morning  afternoon  evening  tonight  dawn ...  the same, for a rough part of the day
 *   tomorrow  next day                             one day later (with a time: that time tomorrow;
 *                                                  before 5 AM, "tomorrow 9am" means the coming 9 AM)
 *   Monday  next friday 09:00                      the next such weekday
 *   2024-03-15  2024-03-15 18:00                   an exact date (and time)
 *
 * Unknown words are ignored, so "the next morning, 07:30" works. Nothing recognisable means
 * the instruction is invalid.
 */

import {
    DAY, MINUTE, addMonths, isInRange, makeTime, minuteOfDay, startOfDay, timeParts, validTime,
} from './time.js';

/**
 * @typedef {object} Instruction
 * @property {{ year: number, month: number, day: number } | null} date An exact date.
 * @property {number} minutes Relative minutes (may be negative or fractional).
 * @property {number} months Relative calendar months.
 * @property {boolean} dayJump True if the move is a day or more, so a clock time isn't rolled forward.
 * @property {number} tomorrows How many times "tomorrow" was said (normally 0 or 1).
 * @property {number | null} weekday 0 (Sunday) to 6.
 * @property {number | null} clock Minutes after midnight, from an explicit time like 07:30.
 * @property {number | null} roughClock Minutes after midnight, from a word like "evening".
 */

/** @type {Record<string, { minutes?: number, months?: number, dayJump?: boolean }>} */
const UNITS = {
    m: { minutes: 1 }, min: { minutes: 1 }, mins: { minutes: 1 }, minute: { minutes: 1 }, minutes: { minutes: 1 },
    h: { minutes: 60 }, hr: { minutes: 60 }, hrs: { minutes: 60 }, hour: { minutes: 60 }, hours: { minutes: 60 },
    d: { minutes: 1440, dayJump: true }, day: { minutes: 1440, dayJump: true }, days: { minutes: 1440, dayJump: true },
    w: { minutes: 10080, dayJump: true }, wk: { minutes: 10080, dayJump: true }, wks: { minutes: 10080, dayJump: true },
    week: { minutes: 10080, dayJump: true }, weeks: { minutes: 10080, dayJump: true },
    mo: { months: 1, dayJump: true }, mos: { months: 1, dayJump: true },
    month: { months: 1, dayJump: true }, months: { months: 1, dayJump: true },
    y: { months: 12, dayJump: true }, yr: { months: 12, dayJump: true }, yrs: { months: 12, dayJump: true },
    year: { months: 12, dayJump: true }, years: { months: 12, dayJump: true },
};

/** @type {Record<string, number>} */
const NUMBER_WORDS = {
    a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50,
    couple: 2, few: 3, several: 3,
};

const TENS = 'twenty|thirty|forty|fifty';
const ONES = 'one|two|three|four|five|six|seven|eight|nine';

/** @type {Record<string, number>} */
const WEEKDAY_WORDS = {
    sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3,
    thursday: 4, thu: 4, thur: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6,
};

/** Rough clock times, in minutes after midnight. An explicit time like 07:30 wins over these. */
/** @type {Record<string, number>} */
const ROUGH_TIMES = {
    dawn: 6 * 60, sunrise: 6 * 60, morning: 8 * 60,
    afternoon: 15 * 60, evening: 18 * 60, dusk: 19 * 60, sunset: 19 * 60, tonight: 21 * 60, night: 21 * 60,
};

/** Explicit times that read as words. */
/** @type {Record<string, number>} */
const EXACT_TIME_WORDS = { noon: 12 * 60, midday: 12 * 60, midnight: 0 };

/** Before 5:00 AM it still feels like the previous night. */
const LATE_NIGHT_END = 5 * 60;

const TOKEN_PATTERN = /\d{4}-\d{1,2}-\d{1,2}|\d{1,2}:\d{2}|[+-]|\d+(?:\.\d+)?|[a-z]+/g;

/**
 * @param {string} text
 * @returns {Instruction | null}
 */
export function parseInstruction(text) {
    if (typeof text !== 'string') return null;
    const normalised = text
        .toLowerCase()
        .replace(/\b([ap])\.\s?m\.?/g, '$1m')
        .replace(/o'?clock/g, '')
        .replace(new RegExp(`\\b(${TENS})[- ](${ONES})\\b`, 'g'),
            (_, tens, ones) => String((NUMBER_WORDS[tens] ?? 0) + (NUMBER_WORDS[ones] ?? 0)))
        .replace(/\b(?:a )?quarter(?: of an)? hour\b/g, '15 minutes')
        .replace(/\bhalf an? hour\b/g, '30 minutes')
        .replace(/\bhalf a day\b/g, '12 hours')
        .replace(/\b(?:an?|one) hour and a half\b/g, '90 minutes')
        .replace(/\b(\d+) hours? and a half\b/g, '$1.5 hours')
        .replace(/\b(?:next|following) day\b/g, 'tomorrow')
        .replace(/\bnext (week|month|year)\b/g, '+1 $1')
        .replace(/\b(couple|few)\s+of\b/g, '$1');
    const tokens = normalised.match(TOKEN_PATTERN) ?? [];

    /** @type {Instruction} */
    const result = {
        date: null, minutes: 0, months: 0, dayJump: false, tomorrows: 0, weekday: null, clock: null, roughClock: null,
    };
    let sign = 1;
    let recognised = false;

    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i] ?? '';
        const next = tokens[i + 1];

        if (/^\d{4}-/.test(token)) {
            const [year, month, day] = token.split('-').map(Number);
            if (validTime(year ?? 0, month ?? 0, day ?? 0, 0, 0) === null) return null;
            result.date = { year: year ?? 0, month: month ?? 0, day: day ?? 0 };
            recognised = true;
            continue;
        }

        if (token.includes(':')) {
            const [hourText, minuteText] = token.split(':');
            let hour = Number(hourText);
            const minute = Number(minuteText);
            if (next === 'am' || next === 'pm') {
                if (hour < 1 || hour > 12) return null;
                hour = to24(hour, next);
                i++;
            }
            if (hour > 23 || minute > 59) return null;
            result.clock = hour * 60 + minute;
            recognised = true;
            continue;
        }

        if (token === '+' || token === '-') {
            sign = token === '-' ? -1 : 1;
            continue;
        }

        const number = /^\d/.test(token) ? Number(token) : NUMBER_WORDS[token];
        if (number !== undefined) {
            const unit = next === undefined ? undefined : UNITS[next];
            if (unit) {
                if (unit.months) {
                    result.months += sign * Math.round(number) * unit.months;
                } else {
                    result.minutes += sign * number * (unit.minutes ?? 0);
                }
                if (unit.dayJump) result.dayJump = true;
                recognised = true;
                i++;
                continue;
            }
            if ((next === 'am' || next === 'pm') && Number.isInteger(number) && number >= 1 && number <= 12) {
                result.clock = to24(number, next) * 60;
                recognised = true;
                i++;
                continue;
            }
            continue;
        }

        if (token in WEEKDAY_WORDS) {
            result.weekday = WEEKDAY_WORDS[token] ?? null;
            recognised = true;
        } else if (token === 'tomorrow') {
            result.tomorrows += 1;
            recognised = true;
        } else if (token in EXACT_TIME_WORDS) {
            result.clock = EXACT_TIME_WORDS[token] ?? null;
            recognised = true;
        } else if (token in ROUGH_TIMES) {
            result.roughClock = ROUGH_TIMES[token] ?? null;
            recognised = true;
        }
    }

    return recognised ? result : null;
}

/**
 * Works out the new time. Returns null if the result would fall outside years 1-9999.
 * @param {Instruction} instruction
 * @param {number} now
 * @returns {number | null}
 */
export function applyInstruction(instruction, now) {
    const clock = instruction.clock ?? instruction.roughClock;
    const relative = (/** @type {number} */ time) =>
        addMonths(time, instruction.months) + Math.round(instruction.minutes) * MINUTE;

    if (instruction.date) {
        const { year, month, day } = instruction.date;
        const base = makeTime(year, month, day) + (clock ?? minuteOfDay(now)) * MINUTE;
        return inRange(relative(base));
    }

    // In the small hours, "tomorrow morning" means the coming morning, not the one after.
    let tomorrows = instruction.tomorrows;
    if (tomorrows > 0 && clock !== null && minuteOfDay(now) < LATE_NIGHT_END) tomorrows -= 1;
    const dayJump = instruction.dayJump || tomorrows > 0;

    const moved = relative(now) + tomorrows * DAY;
    if (!Number.isFinite(moved)) return null;

    if (instruction.weekday !== null) {
        const timeOfDay = clock ?? minuteOfDay(moved);
        for (let offset = 0; offset <= 7; offset++) {
            const candidate = startOfDay(moved) + offset * DAY + timeOfDay * MINUTE;
            if (timeParts(candidate).weekday === instruction.weekday && candidate > moved) return inRange(candidate);
        }
    }

    if (clock !== null) {
        let candidate = startOfDay(moved) + clock * MINUTE;
        if (!dayJump && candidate < moved) candidate += DAY;
        return inRange(candidate);
    }

    return inRange(moved);
}

/**
 * Parses and applies in one go. Returns null for invalid text or an out-of-range result.
 * @param {string} text
 * @param {number} now
 */
export function applyInstructionText(text, now) {
    const instruction = parseInstruction(text);
    return instruction ? applyInstruction(instruction, now) : null;
}

/**
 * @param {number} hour 1-12
 * @param {string} suffix "am" or "pm"
 */
function to24(hour, suffix) {
    if (suffix === 'am') return hour === 12 ? 0 : hour;
    return hour === 12 ? 12 : hour + 12;
}

/** @param {number} time */
function inRange(time) {
    return isInRange(time) ? time : null;
}
