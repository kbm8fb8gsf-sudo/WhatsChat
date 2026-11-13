import { describe, expect, it } from 'vitest';
import { cleanMessage, coveredUpTo, fingerprint, hash64, planNextSegment, queryText, staleSegments, transcript } from '../transcript.js';

/** @param {string} name @param {string} mes @param {object} [extra] */
const m = (name, mes, extra = {}) => ({ name, mes, is_user: name === 'Ann', ...extra });

const CHAT = [
    m('Seraphina', 'Welcome to the forest.'),
    m('Ann', 'Thanks. *looks around*'),
    m('System', 'hidden note', { is_system: true }),
    m('Seraphina', '<think>plan</think>The wolves came at night.'),
    m('Ann', ''),
];

describe('hash64', () => {
    it('is stable, 16 hex digits and input-sensitive', () => {
        expect(hash64('abc')).toMatch(/^[0-9a-f]{16}$/);
        expect(hash64('abc')).toBe(hash64('abc'));
        expect(hash64('abc')).not.toBe(hash64('abd'));
    });
});

describe('transcript', () => {
    it('labels messages with their ids and skips hidden or empty ones', () => {
        expect(transcript(CHAT, 0, 5)).toBe([
            '[#0] Seraphina: Welcome to the forest.',
            '[#1] Ann: Thanks. *looks around*',
            '[#3] Seraphina: The wolves came at night.',
        ].join('\n\n'));
    });

    it('caps long messages', () => {
        expect(cleanMessage('a'.repeat(50), 10)).toBe(`${'a'.repeat(9)}…`);
    });
});

describe('fingerprint / staleSegments', () => {
    it('changes when a message is edited, hidden or removed', () => {
        const before = fingerprint(CHAT, 0, 4);
        const edited = CHAT.map((x, i) => (i === 1 ? { ...x, mes: 'Thanks!' } : x));
        const hidden = CHAT.map((x, i) => (i === 0 ? { ...x, is_system: true } : x));
        expect(fingerprint(edited, 0, 4)).not.toBe(before);
        expect(fingerprint(hidden, 0, 4)).not.toBe(before);
        expect(fingerprint(CHAT.slice(0, 3), 0, 4)).not.toBe(before);
        expect(fingerprint(CHAT, 0, 4)).toBe(before);
    });

    it('finds remembered slices that no longer match the chat', () => {
        const segs = [
            { id: 'a', from: 0, to: 2, fingerprint: fingerprint(CHAT, 0, 2) },
            { id: 'b', from: 2, to: 4, fingerprint: 'old' },
            { id: 'c', from: 4, to: 9, fingerprint: 'x' },
        ];
        expect(staleSegments(CHAT, segs)).toEqual(['b', 'c']);
    });
});

describe('planNextSegment', () => {
    const opts = { holdBack: 2, minNew: 4, maxSegment: 10 };

    it('waits for enough settled new messages', () => {
        expect(planNextSegment(5, [], opts)).toBeNull();
        expect(planNextSegment(6, [], opts)).toEqual({ from: 0, to: 4 });
    });

    it('continues after what is remembered, in pieces of at most maxSegment', () => {
        expect(planNextSegment(40, [{ from: 0, to: 10 }], opts)).toEqual({ from: 10, to: 20 });
    });

    it('fills holes left by edits first, even small ones', () => {
        expect(planNextSegment(40, [{ from: 0, to: 10 }, { from: 12, to: 20 }], opts)).toEqual({ from: 10, to: 12 });
    });

    it('never touches the held-back newest messages', () => {
        expect(planNextSegment(12, [{ from: 0, to: 4 }, { from: 11, to: 12 }], opts)).toEqual({ from: 4, to: 10 });
        expect(planNextSegment(12, [{ from: 0, to: 10 }], opts)).toBeNull();
    });

    it('takes even a single message when asked (manual mode)', () => {
        expect(planNextSegment(11, [{ from: 0, to: 10 }], { holdBack: 0, minNew: 1, maxSegment: 10 })).toEqual({ from: 10, to: 11 });
    });
});

describe('coveredUpTo', () => {
    it('stops at the first gap', () => {
        expect(coveredUpTo([{ from: 0, to: 4 }, { from: 4, to: 8 }, { from: 10, to: 12 }])).toBe(8);
        expect(coveredUpTo([{ from: 2, to: 4 }])).toBe(0);
    });
});

describe('queryText', () => {
    it('uses the newest story messages, newest first', () => {
        expect(queryText(CHAT, 2)).toBe('The wolves came at night.\nThanks. *looks around*');
    });

    it('keeps the newest message even if it alone is too long', () => {
        expect(queryText([m('A', 'old'), m('B', 'x'.repeat(50))], 3, 20)).toBe(`${'x'.repeat(19)}…`);
    });
});
