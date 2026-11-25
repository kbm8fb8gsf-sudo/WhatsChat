// @ts-check
/**
 * Story time is a wall-clock reading with no time zone. It's held as a millisecond count and
 * worked out with Date's UTC methods only, so daylight saving and the browser's own time zone
 * can never shift it. Precision is one minute.
 */

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

const MIN_YEAR = 1;
const MAX_YEAR = 9999;

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const MONTHS = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * @typedef {object} TimeParts
 * @property {number} year
 * @property {number} month 1-12
 * @property {number} day 1-31
 * @property {number} hour 0-23
 * @property {number} minute 0-59
 * @property {number} weekday 0 (Sunday) to 6
 */

/**
 * @typedef {object} FormatOptions
 * @property {boolean} hour24 Use "21:42" rather than "9:42 PM".
 * @property {'dmy' | 'mdy'} dateOrder "14 March 2024" or "March 14, 2024".
 */

/**
 * @param {number} year
 * @param {number} month 1-12
 * @param {number} day
 * @param {number} [hour]
 * @param {number} [minute]
 * @returns {number}
 */
export function makeTime(year, month, day, hour = 0, minute = 0) {
    // Date.UTC treats years 0-99 as 1900-1999, so set the year separately.
    const date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    date.setUTCHours(hour, minute, 0, 0);
    return date.getTime();
}

/**
 * @param {number} time
 * @returns {TimeParts}
 */
export function timeParts(time) {
    const date = new Date(time);
    return {
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate(),
        hour: date.getUTCHours(),
        minute: date.getUTCMinutes(),
        weekday: date.getUTCDay(),
    };
}

/** @param {number} time */
export function isInRange(time) {
    if (!Number.isFinite(time)) return false;
    const { year } = timeParts(time);
    return year >= MIN_YEAR && year <= MAX_YEAR;
}

/**
 * @param {number} year
 * @param {number} month 1-12
 */
export function daysInMonth(year, month) {
    const date = new Date(0);
    date.setUTCFullYear(year, month, 0);
    return date.getUTCDate();
}

/** @param {number} time */
export function startOfDay(time) {
    return Math.floor(time / DAY) * DAY;
}

/** @param {number} time Minutes since midnight. */
export function minuteOfDay(time) {
    return Math.round((time - startOfDay(time)) / MINUTE);
}

/**
 * Calendar months: 31 January plus one month is 29 February in a leap year.
 * @param {number} time
 * @param {number} months Whole months, may be negative.
 */
export function addMonths(time, months) {
    if (!months) return time;
    const p = timeParts(time);
    const total = p.year * 12 + (p.month - 1) + months;
    const year = Math.floor(total / 12);
    const month = total - year * 12 + 1;
    const day = Math.min(p.day, daysInMonth(year, month));
    return makeTime(year, month, day, p.hour, p.minute);
}

/**
 * "2024-03-14T21:42". Years are always four digits.
 * @param {number} time
 */
export function toIso(time) {
    const p = timeParts(time);
    return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/**
 * Reads "2024-03-14T21:42", "2024-03-14 21:42" or "2024-03-14" (midnight).
 * @param {unknown} text
 * @returns {number | null}
 */
export function fromIso(text) {
    if (typeof text !== 'string') return null;
    const match = /^\s*(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2}))?\s*$/.exec(text);
    if (!match) return null;
    const [year, month, day, hour, minute] = match.slice(1).map((v) => (v === undefined ? 0 : Number(v)));
    return validTime(year ?? 0, month ?? 0, day ?? 0, hour ?? 0, minute ?? 0);
}

/**
 * @param {number} year
 * @param {number} month
 * @param {number} day
 * @param {number} hour
 * @param {number} minute
 * @returns {number | null}
 */
export function validTime(year, month, day, hour, minute) {
    if (year < MIN_YEAR || year > MAX_YEAR) return null;
    if (month < 1 || month > 12) return null;
    if (day < 1 || day > daysInMonth(year, month)) return null;
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    return makeTime(year, month, day, hour, minute);
}

/**
 * The browser's local date and time, read as a story time.
 * @param {Date} date
 */
export function fromLocalDate(date) {
    return makeTime(date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes());
}

/**
 * @param {number} time
 * @param {Pick<FormatOptions, 'hour24'>} options
 */
export function formatTime(time, { hour24 }) {
    const { hour, minute } = timeParts(time);
    if (hour24) return `${pad(hour)}:${pad(minute)}`;
    const suffix = hour < 12 ? 'AM' : 'PM';
    const hour12 = hour % 12 === 0 ? 12 : hour % 12;
    return `${hour12}:${pad(minute)} ${suffix}`;
}

/**
 * @param {number} time
 * @param {Pick<FormatOptions, 'dateOrder'>} options
 */
export function formatDate(time, { dateOrder }) {
    const { year, month, day } = timeParts(time);
    const monthName = MONTHS[month - 1];
    return dateOrder === 'mdy' ? `${monthName} ${day}, ${year}` : `${day} ${monthName} ${year}`;
}

/** @param {number} time */
export function formatWeekday(time) {
    return WEEKDAYS[timeParts(time).weekday] ?? '';
}

/**
 * "Thursday, 14 March 2024, 9:42 PM"
 * @param {number} time
 * @param {FormatOptions} options
 */
export function formatFull(time, options) {
    return `${formatWeekday(time)}, ${formatDate(time, options)}, ${formatTime(time, options)}`;
}

/**
 * Short enough for a message header: "Thu 14 Mar, 9:42 PM" or "Thu, Mar 14, 9:42 PM".
 * @param {number} time
 * @param {FormatOptions} options
 */
export function formatShort(time, options) {
    const { month, day } = timeParts(time);
    const weekday = formatWeekday(time).slice(0, 3);
    const monthName = (MONTHS[month - 1] ?? '').slice(0, 3);
    const date = options.dateOrder === 'mdy' ? `${weekday}, ${monthName} ${day}` : `${weekday} ${day} ${monthName}`;
    return `${date}, ${formatTime(time, options)}`;
}

/**
 * A plain-words part of the day, which helps models with lighting, meals and so on.
 * @param {number} time
 */
export function timeOfDay(time) {
    const { hour } = timeParts(time);
    if (hour < 5) return 'late night';
    if (hour < 8) return 'early morning';
    if (hour < 12) return 'morning';
    if (hour < 13) return 'midday';
    if (hour < 17) return 'afternoon';
    if (hour < 21) return 'evening';
    return 'night';
}

/**
 * Day 1 is the day the story starts on.
 * @param {number} time
 * @param {number} origin
 */
export function dayNumber(time, origin) {
    return Math.max(1, Math.round((startOfDay(time) - startOfDay(origin)) / DAY) + 1);
}

/**
 * "2 days 3 hours", "45 minutes", "1 hour 5 minutes". Used in notices, not in prompts.
 * @param {number} ms May be negative; the sign is dropped.
 */
export function formatDuration(ms) {
    let minutes = Math.round(Math.abs(ms) / MINUTE);
    if (minutes === 0) return '0 minutes';
    const days = Math.floor(minutes / (24 * 60));
    minutes -= days * 24 * 60;
    const hours = Math.floor(minutes / 60);
    minutes -= hours * 60;
    /** @type {string[]} */
    const parts = [];
    if (days) parts.push(plural(days, 'day'));
    if (hours) parts.push(plural(hours, 'hour'));
    if (minutes && days === 0) parts.push(plural(minutes, 'minute'));
    return parts.join(' ') || '0 minutes';
}

/**
 * @param {number} count
 * @param {string} word
 */
function plural(count, word) {
    return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/**
 * @param {number} value
 * @param {number} [width]
 */
function pad(value, width = 2) {
    return String(value).padStart(width, '0');
}
