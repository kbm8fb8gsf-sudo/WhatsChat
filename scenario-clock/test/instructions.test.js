import { describe, expect, it } from 'vitest';
import { applyInstructionText, parseInstruction } from '../src/instructions.js';
import { fromIso, toIso } from '../src/time.js';

/** Thursday 14 March 2024, 9:42 PM. */
const NOW = /** @type {number} */ (fromIso('2024-03-14T21:42'));

/** @param {string} text */
function apply(text, now = NOW) {
    const result = applyInstructionText(text, now);
    return result === null ? null : toIso(result);
}

describe('relative changes', () => {
    it.each([
        ['+20m', '2024-03-14T22:02'],
        ['+3h', '2024-03-15T00:42'],
        ['+2h30m', '2024-03-15T00:12'],
        ['+2h 30m', '2024-03-15T00:12'],
        ['+1.5h', '2024-03-14T23:12'],
        ['+2d', '2024-03-16T21:42'],
        ['+1w', '2024-03-21T21:42'],
        ['+1mo', '2024-04-14T21:42'],
        ['+1y', '2025-03-14T21:42'],
        ['-15m', '2024-03-14T21:27'],
        ['3 hours', '2024-03-15T00:42'],
        ['an hour later', '2024-03-14T22:42'],
        ['half an hour', '2024-03-14T22:12'],
        ['a quarter of an hour', '2024-03-14T21:57'],
        ['an hour and a half', '2024-03-14T23:12'],
        ['forty-five minutes', '2024-03-14T22:27'],
        ['a couple of hours', '2024-03-14T23:42'],
        ['a few days later', '2024-03-17T21:42'],
        ['next week', '2024-03-21T21:42'],
    ])('%s → %s', (text, expected) => {
        expect(apply(text)).toBe(expected);
    });
});

describe('clock times', () => {
    it.each([
        ['07:30', '2024-03-15T07:30'],
        ['23:00', '2024-03-14T23:00'],
        ['21:42', '2024-03-14T21:42'],
        ['7:30 am', '2024-03-15T07:30'],
        ['7pm', '2024-03-15T19:00'],
        ['11 p.m.', '2024-03-14T23:00'],
        ['12am', '2024-03-15T00:00'],
        ['noon', '2024-03-15T12:00'],
        ['midnight', '2024-03-15T00:00'],
        ['the next morning', '2024-03-15T08:00'],
        ['the next morning, 07:15', '2024-03-15T07:15'],
        ['evening', '2024-03-15T18:00'],
    ])('%s rolls forward to the next %s', (text, expected) => {
        expect(apply(text)).toBe(expected);
    });

    it('sets the time on the target day when a day or more passes', () => {
        expect(apply('tomorrow')).toBe('2024-03-15T21:42');
        expect(apply('next day')).toBe('2024-03-15T21:42');
        expect(apply('tomorrow 9am')).toBe('2024-03-15T09:00');
        expect(apply('tomorrow evening')).toBe('2024-03-15T18:00');
        expect(apply('+2d 08:00')).toBe('2024-03-16T08:00');
        expect(apply('+1d 23:00')).toBe('2024-03-15T23:00');
    });

    it('treats "tomorrow" after midnight as the coming day when a time is given', () => {
        const smallHours = /** @type {number} */ (fromIso('2024-03-15T01:30'));
        expect(apply('tomorrow 9am', smallHours)).toBe('2024-03-15T09:00');
        expect(apply('tomorrow morning', smallHours)).toBe('2024-03-15T08:00');
        expect(apply('tomorrow', smallHours)).toBe('2024-03-16T01:30');
    });

    it('rolls forward from an early-morning start too', () => {
        const early = /** @type {number} */ (fromIso('2024-03-14T06:00'));
        expect(apply('07:30', early)).toBe('2024-03-14T07:30');
        expect(apply('05:00', early)).toBe('2024-03-15T05:00');
    });
});

describe('weekdays', () => {
    it('goes to the next such day', () => {
        expect(apply('friday')).toBe('2024-03-15T21:42');
        expect(apply('Monday 09:00')).toBe('2024-03-18T09:00');
        expect(apply('next thursday')).toBe('2024-03-21T21:42');
        expect(apply('thursday 23:00')).toBe('2024-03-14T23:00');
        expect(apply('thursday 08:00')).toBe('2024-03-21T08:00');
    });
});

describe('exact dates', () => {
    it('sets the date and keeps or sets the time', () => {
        expect(apply('2024-03-20')).toBe('2024-03-20T21:42');
        expect(apply('2024-03-20 18:00')).toBe('2024-03-20T18:00');
        expect(apply('2024-03-20T06:15')).toBe('2024-03-20T06:15');
        expect(apply('1889-10-04 6pm')).toBe('1889-10-04T18:00');
        expect(apply('2020-01-01 10:00')).toBe('2020-01-01T10:00');
    });
});

describe('invalid input', () => {
    it.each(['', 'later', 'soon', 'some time passes', '25:00', '2024-02-30', '13pm', '3'])('%j is rejected', (text) => {
        expect(parseInstruction(text)).toBeNull();
        expect(apply(text)).toBeNull();
    });

    it('refuses results outside years 1-9999', () => {
        expect(apply('+9000y')).toBeNull();
        expect(apply('-3000y')).toBeNull();
    });
});
