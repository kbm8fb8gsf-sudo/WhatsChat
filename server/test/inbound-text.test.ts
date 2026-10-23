import { describe, expect, it } from 'vitest';
import { joinBatchText, neutraliseMacros } from '../src/core/inbound-text.js';

describe('neutraliseMacros', () => {
    it('breaks every {{ with a zero-width space', () => {
        expect(neutraliseMacros('what is {{persona}} and {{char}}?')).toBe(
            'what is {\u200B{persona}} and {\u200B{char}}?',
        );
    });

    it('leaves text without macros alone', () => {
        expect(neutraliseMacros('a {single} brace')).toBe('a {single} brace');
    });

    it('looks identical once zero-width spaces are removed', () => {
        const input = '{{setvar::x::1}}{{getvar::x}}';
        expect(neutraliseMacros(input).replace(/\u200B/g, '')).toBe(input);
    });
});

describe('joinBatchText', () => {
    it('joins messages with newlines, dropping blanks', () => {
        expect(joinBatchText([' hey ', '', 'you there?'], { neutraliseMacros: false })).toBe('hey\nyou there?');
    });

    it('neutralises macros when enabled', () => {
        expect(joinBatchText(['{{user}}'], { neutraliseMacros: true })).toBe('{\u200B{user}}');
        expect(joinBatchText(['{{user}}'], { neutraliseMacros: false })).toBe('{{user}}');
    });
});
