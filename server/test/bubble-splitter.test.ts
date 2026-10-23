import { describe, expect, it } from 'vitest';
import { type SplitterOptions, splitBubbles, splitSentences } from '../src/core/bubble-splitter.js';

const defaults: SplitterOptions = { maxBubbleChars: 60, minBubbleChars: 10, maxBubbles: 6 };

function split(text: string, options: Partial<SplitterOptions> = {}): string[] {
    return splitBubbles(text, { ...defaults, ...options });
}

describe('splitBubbles', () => {
    it('returns nothing for empty text', () => {
        expect(split('')).toEqual([]);
        expect(split('  \n\n ')).toEqual([]);
    });

    it('splits on blank lines', () => {
        expect(split('hey!\n\nhow was your day?\n \nmine was ok')).toEqual(['hey!', 'how was your day?', 'mine was ok']);
    });

    it('keeps single newlines inside a short paragraph', () => {
        expect(split('line one\nline two')).toEqual(['line one\nline two']);
    });

    it('keeps short bubbles the model chose, like "lol"', () => {
        expect(split('lol\n\nok')).toEqual(['lol', 'ok']);
    });

    it('splits a long paragraph at sentence boundaries', () => {
        const text = 'I went to the shops this morning. They had no bread at all. So I got cake instead!';
        expect(split(text)).toEqual(['I went to the shops this morning. They had no bread at all.', 'So I got cake instead!']);
    });

    it('does not split after abbreviations, initials, decimals or URLs', () => {
        const text = 'Mr. Smith met J. Doe at 5 p.m. today. It cost 3.50 at example.com/shop. Great stuff here!';
        expect(split(text, { maxBubbleChars: 40, minBubbleChars: 0 })).toEqual([
            'Mr. Smith met J. Doe at 5 p.m. today.',
            'It cost 3.50 at example.com/shop.',
            'Great stuff here!',
        ]);
    });

    it('merges a tiny trailing fragment into the previous bubble', () => {
        const text = `${'a'.repeat(50)}. ${'b'.repeat(40)}. Ok.`;
        expect(split(text)).toEqual([`${'a'.repeat(50)}.`, `${'b'.repeat(40)}. Ok.`]);
    });

    it('wraps a single overlong sentence at commas, then spaces', () => {
        const text = 'this is a long sentence, with a comma in the middle and then it keeps on going forever';
        const bubbles = split(text, { maxBubbleChars: 40, minBubbleChars: 0 });
        expect(bubbles[0]).toBe('this is a long sentence,');
        for (const bubble of bubbles) expect(bubble.length).toBeLessThanOrEqual(40);
        expect(bubbles.join(' ')).toBe(text);
    });

    it('hard-cuts a single word longer than the limit', () => {
        const url = `https://example.com/${'x'.repeat(80)}`;
        const bubbles = split(url, { maxBubbleChars: 50 });
        expect(bubbles.join('')).toBe(url);
        for (const bubble of bubbles) expect(bubble.length).toBeLessThanOrEqual(50);
    });

    it('caps the number of bubbles by merging the overflow into the last one', () => {
        expect(split('a\n\nb\n\nc\n\nd\n\ne', { maxBubbles: 3 })).toEqual(['a', 'b', 'c\nd\ne']);
        expect(split('a\n\nb', { maxBubbles: 1 })).toEqual(['a\nb']);
    });

    it('keeps emoji and non-Latin text intact', () => {
        const text = '\u3053\u3093\u306B\u3061\u306F\uFF01\u5143\u6C17\u3067\u3059\u304B\uFF1F \u{1F60A} Tr\u00E8s bien. \u00C7a va?';
        expect(split(text, { maxBubbleChars: 1000 })).toEqual([text]);
    });
});

describe('splitSentences', () => {
    it('treats single newlines as boundaries and remembers them', () => {
        expect(splitSentences('one. two\nthree')).toEqual([
            { text: 'one.', separator: ' ' },
            { text: 'two', separator: '\n' },
            { text: 'three', separator: ' ' },
        ]);
    });

    it('keeps closing quotes with the sentence', () => {
        expect(splitSentences('She said "hi." Then left.').map((p) => p.text)).toEqual(['She said "hi."', 'Then left.']);
    });
});
