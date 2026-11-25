import { describe, expect, it } from 'vitest';
import { findTags } from '../src/tags.js';
import { fromIso, toIso } from '../src/time.js';
import {
    buildTimeline, clampClock, newClock, rateAt, readClock, timeAfter, withRate, writeClock,
} from '../src/timeline.js';

const START = /** @type {number} */ (fromIso('2024-03-14T21:00'));

/**
 * @param {string} mes
 * @param {Record<string, unknown>} [extra]
 */
function msg(mes, extra = {}) {
    return { mes, is_user: false, extra };
}

/** @param {(number | null)[]} times */
function iso(times) {
    return times.map((t) => (t === null ? null : toIso(t)));
}

describe('findTags', () => {
    it('finds valid tags in order, case-insensitively', () => {
        const tags = findTags('She waits. [TIME: +2h] Later... [time:07:30] Morning. [TIME: whenever]');
        expect(tags.map((t) => t.instruction)).toEqual(['+2h', '07:30']);
        expect(tags[0]?.raw).toBe('[TIME: +2h]');
    });

    it('ignores text without tags', () => {
        expect(findTags('No time here [OOC: hi]')).toEqual([]);
        expect(findTags(undefined)).toEqual([]);
    });
});

describe('buildTimeline', () => {
    it('folds tags, adds the default minutes, and skips the opening message', () => {
        const clock = newClock(START, -1, 2);
        const chat = [
            msg('Hello there.'),
            { mes: 'Hi!', is_user: true },
            msg('[TIME: +3h] Hours later...'),
            msg('[TIME: tomorrow 08:00] Morning.'),
        ];
        expect(iso(buildTimeline(chat, clock).times)).toEqual([
            '2024-03-14T21:00', '2024-03-14T21:02', '2024-03-15T00:02', '2024-03-15T08:00',
        ]);
    });

    it('lets a tag in the greeting set the scene and day 1', () => {
        const clock = newClock(START, -1, 1);
        const timeline = buildTimeline([msg('[TIME: 1889-10-04 18:00] Fog rolls in.'), msg('Hm.')], clock);
        expect(toIso(timeline.origin)).toBe('1889-10-04T18:00');
        expect(toIso(timeline.current)).toBe('1889-10-04T18:01');
    });

    it("doesn't move for SillyTavern's own notices, but does for narrator messages", () => {
        const clock = newClock(START, -1, 5);
        const chat = [
            msg('Start'),
            { mes: 'Help text with [TIME: +9h] as an example', is_system: true, extra: { type: 'help' } },
            { mes: 'The rain stops. [TIME: +1h]', is_system: false, extra: { type: 'narrator' } },
            { mes: '', extra: { tool_invocations: [] } },
        ];
        expect(iso(buildTimeline(chat, clock).times)).toEqual([
            '2024-03-14T21:00', '2024-03-14T21:00', '2024-03-14T22:00', '2024-03-14T22:00',
        ]);
    });

    it('counts hidden messages, since the story still happened', () => {
        const clock = newClock(START, -1, 1);
        const chat = [msg('Start'), { mes: '[TIME: +1h]', is_system: true, extra: {} }];
        expect(toIso(buildTimeline(chat, clock).current)).toBe('2024-03-14T22:00');
    });

    it('applies manual changes after the message they were made on', () => {
        const clock = newClock(START, -1, 1);
        const chat = [msg('Start'), msg('[TIME: +1h] ok', { scenario_clock: { ops: ['+30m', '07:00'] } })];
        expect(toIso(buildTimeline(chat, clock).current)).toBe('2024-03-15T07:00');
    });

    it('ignores messages from before the clock started', () => {
        const clock = newClock(START, 1, 1);
        const chat = [msg('[TIME: +5d]'), msg('[TIME: +5d]'), msg('[TIME: +1h]')];
        expect(iso(buildTimeline(chat, clock).times)).toEqual([null, '2024-03-14T21:00', '2024-03-14T22:00']);
        expect(toIso(buildTimeline(chat, clock).origin)).toBe('2024-03-14T21:00');
    });

    it('uses the minutes-per-message in force at each message', () => {
        const clock = withRate(newClock(START, -1, 1), 3, 10);
        const chat = [msg('a'), msg('b'), msg('c'), msg('d'), msg('e')];
        expect(iso(buildTimeline(chat, clock).times)).toEqual([
            '2024-03-14T21:00', '2024-03-14T21:01', '2024-03-14T21:02', '2024-03-14T21:12', '2024-03-14T21:22',
        ]);
        expect(rateAt(clock, 2)).toBe(1);
        expect(rateAt(clock, 3)).toBe(10);
    });

    it('rolls back when messages are removed, with nothing to clean up', () => {
        const clock = newClock(START, -1, 1);
        const chat = [msg('a'), msg('[TIME: +8h]'), msg('b')];
        expect(toIso(buildTimeline(chat, clock).current)).toBe('2024-03-15T05:01');
        expect(toIso(buildTimeline(chat.slice(0, 1), clock).current)).toBe('2024-03-14T21:00');
    });
});

describe('timeAfter', () => {
    it('gives the time after any message, or the start before the first', () => {
        const clock = newClock(START, -1, 1);
        const chat = [msg('a'), msg('[TIME: +1h]'), msg('[TIME: +1h]')];
        expect(toIso(timeAfter(chat, clock, -1))).toBe('2024-03-14T21:00');
        expect(toIso(timeAfter(chat, clock, 1))).toBe('2024-03-14T22:00');
        expect(toIso(timeAfter(chat, clock, 2))).toBe('2024-03-14T23:00');
    });
});

describe('clock records', () => {
    it('round-trips through chat metadata', () => {
        const clock = withRate(newClock(START, 4, 1), 9, 3);
        expect(readClock(writeClock(clock))).toEqual(clock);
        expect(writeClock(clock).start).toBe('2024-03-14T21:00');
    });

    it('rejects broken records', () => {
        expect(readClock(null)).toBeNull();
        expect(readClock({ start: 'soon' })).toBeNull();
        expect(readClock({ start: '2024-03-14T21:00', startIndex: 'x', rates: [{ from: -1, minutes: 2 }] }))
            .toEqual({ start: START, startIndex: -1, rates: [] });
    });

    it('pulls the start and rate changes back after deletions', () => {
        const clock = withRate(newClock(START, 10, 1), 12, 5);
        expect(clampClock(clock, 20)).toBeNull();
        expect(clampClock(clock, 6)).toEqual({ start: START, startIndex: 5, rates: [{ from: 0, minutes: 1 }, { from: 6, minutes: 5 }] });
    });
});
