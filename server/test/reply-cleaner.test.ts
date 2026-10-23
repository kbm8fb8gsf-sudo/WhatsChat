import { describe, expect, it } from 'vitest';
import { type CleanerOptions, cleanReply } from '../src/core/reply-cleaner.js';

const defaults: CleanerOptions = {
    actions: 'remove',
    stripMarkdown: true,
    dropUnfinishedSentence: false,
    maxChars: 2000,
    names: ['Alice', 'Lewis'],
};

function clean(raw: string, options: Partial<CleanerOptions> = {}): string {
    return cleanReply(raw, { ...defaults, ...options });
}

describe('cleanReply', () => {
    it.each([
        ['plain text is untouched', 'hey, how are you?', 'hey, how are you?'],
        ['removes closed reasoning blocks', '<think>plan the reply</think>hi there', 'hi there'],
        ['removes reasoning with a lone closer', 'some thoughts\n</thinking>\nhi there', 'hi there'],
        ['removes reasoning with a lone opener', 'hi there\n<think>unfinished thoughts', 'hi there'],
        ['removes OOC in double parentheses', 'sure thing ((OOC: this is fun))', 'sure thing'],
        ['removes [OOC: ...] blocks', '[OOC: note to user]\nsee you soon', 'see you soon'],
        ['removes OOC lines', 'ok!\nOOC: brb\nmissed you', 'ok!\nmissed you'],
        ['strips HTML tags but keeps <3', '<b>love</b> you <3', 'love you <3'],
        ['turns <br> into newlines', 'one<br>two<br/>three', 'one\ntwo\nthree'],
        ['decodes common entities', 'fish &amp; chips &lt;3', 'fish & chips <3'],
        ['strips a speaker prefix', 'Alice: on my way!', 'on my way!'],
        ['strips a bold speaker prefix on any line', 'hey\n**Alice**: wait up', 'hey\nwait up'],
        ['leaves other prefixes alone', 'Note: bring snacks', 'Note: bring snacks'],
        ['removes actions', '*smiles* hey you', 'hey you'],
        ['removes actions before punctuation', 'fine *sighs*, whatever', 'fine, whatever'],
        ['removes actions mid sentence', 'hey *waves* how are you', 'hey how are you'],
        ['drops a line that held only an action', 'hey\n*waves*\nhow are you', 'hey\nhow are you'],
        ['keeps paragraph breaks the model wrote', 'hey\n\n*waves*\n\nhow are you', 'hey\n\nhow are you'],
        ['leaves arithmetic asterisks alone', '5 * 3 = 15', '5 * 3 = 15'],
        ['strips bold markdown without treating it as an action', 'that is **so** good', 'that is so good'],
        ['strips headings, quotes and rules', '# Title\n> quoted\n---\nbody', 'Title\nquoted\n\nbody'],
        ['strips inline code', 'run `npm test` now', 'run npm test now'],
        ['rewrites links', 'see [this](https://x.test/a)', 'see this (https://x.test/a)'],
        ['collapses a link whose text is the url', '[https://x.test](https://x.test)', 'https://x.test'],
        ['removes images', 'look ![pic](https://x.test/p.png) cool', 'look cool'],
        ['unwraps a fully quoted line', '"I missed you!"', 'I missed you!'],
        ['unwraps curly quotes', '\u201CI missed you!\u201D', 'I missed you!'],
        ['keeps quotes that are only part of a line', 'she said "hi" to me', 'she said "hi" to me'],
        ['normalises whitespace and blank lines', '  a   b \n\n\n\n c  ', 'a b\n\nc'],
        ['keeps emoji intact', 'see you \u{1F60A}\u{1F44D}', 'see you \u{1F60A}\u{1F44D}'],
        ['normalises CRLF', 'one\r\ntwo', 'one\ntwo'],
    ])('%s', (_name, input, expected) => {
        expect(clean(input)).toBe(expected);
    });

    it('can keep or unwrap actions instead', () => {
        expect(clean('*smiles* hey', { actions: 'keep' })).toBe('*smiles* hey');
        expect(clean('hey *smiles* you', { actions: 'unwrap' })).toBe('hey smiles you');
        expect(clean('*smiles* hey', { actions: 'unwrap' })).toBe('smiles hey');
    });

    it('leaves markdown when stripMarkdown is off', () => {
        expect(clean('that is **so** good', { stripMarkdown: false })).toBe('that is **so** good');
    });

    it('drops an unfinished trailing fragment only when asked', () => {
        const cutOff = 'I had a great day. We went to the park and then we';
        expect(clean(cutOff)).toBe(cutOff);
        expect(clean(cutOff, { dropUnfinishedSentence: true })).toBe('I had a great day.');
        expect(clean('lol ok', { dropUnfinishedSentence: true })).toBe('lol ok');
        expect(clean('Sure. see you \u{1F60A}', { dropUnfinishedSentence: true })).toBe('Sure. see you \u{1F60A}');
        expect(clean('Sure. talk later :)', { dropUnfinishedSentence: true })).toBe('Sure. talk later :)');
    });

    it('truncates long replies at a sentence boundary', () => {
        const text = `${'a'.repeat(60)}. ${'b'.repeat(60)}. ${'c'.repeat(60)}`;
        expect(clean(text, { maxChars: 130 })).toBe(`${'a'.repeat(60)}. ${'b'.repeat(60)}.`);
    });

    it('truncates at a word boundary when no sentence ends late enough', () => {
        expect(clean('one two three four five six', { maxChars: 12 })).toBe('one two');
    });

    it('never splits an emoji when truncating', () => {
        const result = clean(`${'a'.repeat(9)}\u{1F60A}`, { maxChars: 10 });
        expect(result).toBe('a'.repeat(9));
    });

    it('returns an empty string for a reply that was only reasoning and actions', () => {
        expect(clean('<think>hmm</think>*nods*')).toBe('');
    });

    it('handles names containing regex characters', () => {
        expect(clean('Dr. (Who)?: hello', { names: ['Dr. (Who)?'] })).toBe('hello');
    });
});
