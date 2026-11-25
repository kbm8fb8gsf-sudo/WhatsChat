import { describe, expect, it } from 'vitest';
import {
    addMonths, dayNumber, formatDate, formatDuration, formatFull, formatShort, formatTime, fromIso, fromLocalDate,
    makeTime, minuteOfDay, timeOfDay, timeParts, toIso,
} from '../src/time.js';

describe('time', () => {
    it('round-trips ISO text', () => {
        expect(toIso(makeTime(2024, 3, 14, 21, 42))).toBe('2024-03-14T21:42');
        expect(fromIso('2024-03-14T21:42')).toBe(makeTime(2024, 3, 14, 21, 42));
        expect(fromIso('2024-03-14 21:42')).toBe(makeTime(2024, 3, 14, 21, 42));
        expect(fromIso('2024-03-14')).toBe(makeTime(2024, 3, 14));
    });

    it('rejects impossible dates and junk', () => {
        expect(fromIso('2023-02-29')).toBeNull();
        expect(fromIso('2024-13-01')).toBeNull();
        expect(fromIso('2024-01-01T24:00')).toBeNull();
        expect(fromIso('yesterday')).toBeNull();
        expect(fromIso(undefined)).toBeNull();
    });

    it('handles years before 100 and far from today', () => {
        expect(toIso(makeTime(50, 6, 1, 12, 0))).toBe('0050-06-01T12:00');
        expect(fromIso('0050-06-01T12:00')).toBe(makeTime(50, 6, 1, 12, 0));
        expect(timeParts(makeTime(1350, 1, 1)).year).toBe(1350);
        expect(toIso(makeTime(2350, 12, 31, 23, 59))).toBe('2350-12-31T23:59');
    });

    it('adds calendar months, clamping to the end of the month', () => {
        expect(toIso(addMonths(makeTime(2024, 1, 31, 8, 0), 1))).toBe('2024-02-29T08:00');
        expect(toIso(addMonths(makeTime(2023, 1, 31, 8, 0), 1))).toBe('2023-02-28T08:00');
        expect(toIso(addMonths(makeTime(2024, 11, 15), 3))).toBe('2025-02-15T00:00');
        expect(toIso(addMonths(makeTime(2024, 1, 15), -2))).toBe('2023-11-15T00:00');
    });

    it('formats times and dates both ways', () => {
        const t = makeTime(2024, 3, 14, 21, 42);
        expect(formatTime(t, { hour24: false })).toBe('9:42 PM');
        expect(formatTime(t, { hour24: true })).toBe('21:42');
        expect(formatTime(makeTime(2024, 3, 14, 0, 5), { hour24: false })).toBe('12:05 AM');
        expect(formatTime(makeTime(2024, 3, 14, 12, 0), { hour24: false })).toBe('12:00 PM');
        expect(formatDate(t, { dateOrder: 'dmy' })).toBe('14 March 2024');
        expect(formatDate(t, { dateOrder: 'mdy' })).toBe('March 14, 2024');
        expect(formatFull(t, { hour24: false, dateOrder: 'dmy' })).toBe('Thursday, 14 March 2024, 9:42 PM');
        expect(formatShort(t, { hour24: true, dateOrder: 'dmy' })).toBe('Thu 14 Mar, 21:42');
        expect(formatShort(t, { hour24: false, dateOrder: 'mdy' })).toBe('Thu, Mar 14, 9:42 PM');
    });

    it('names the part of the day', () => {
        const at = (/** @type {number} */ hour) => timeOfDay(makeTime(2024, 1, 1, hour, 0));
        expect([at(2), at(6), at(9), at(12), at(15), at(19), at(22)])
            .toEqual(['late night', 'early morning', 'morning', 'midday', 'afternoon', 'evening', 'night']);
    });

    it('counts story days from the origin', () => {
        const origin = makeTime(2024, 3, 14, 21, 0);
        expect(dayNumber(origin, origin)).toBe(1);
        expect(dayNumber(makeTime(2024, 3, 15, 1, 0), origin)).toBe(2);
        expect(dayNumber(makeTime(2024, 4, 14, 1, 0), origin)).toBe(32);
        expect(dayNumber(makeTime(2024, 3, 1), origin)).toBe(1);
    });

    it('describes durations', () => {
        expect(formatDuration(0)).toBe('0 minutes');
        expect(formatDuration(45 * 60_000)).toBe('45 minutes');
        expect(formatDuration(-(90 * 60_000))).toBe('1 hour 30 minutes');
        expect(formatDuration((2 * 24 * 60 + 3 * 60 + 10) * 60_000)).toBe('2 days 3 hours');
    });

    it('reads the browser date as wall-clock time', () => {
        const local = new Date(2026, 10, 25, 13, 7);
        expect(toIso(fromLocalDate(local))).toBe('2026-11-25T13:07');
        expect(minuteOfDay(fromLocalDate(local))).toBe(13 * 60 + 7);
    });
});
