/**
 * Turns a raw SillyTavern reply into something that reads like a text message.
 * Pure: no I/O, no clock, no randomness.
 */

export interface CleanerOptions {
    /** What to do with *roleplay actions* in single asterisks. */
    actions: 'remove' | 'keep' | 'unwrap';
    stripMarkdown: boolean;
    /** Cut a trailing fragment that doesn't end a sentence (e.g. a reply cut off by the token limit). */
    dropUnfinishedSentence: boolean;
    maxChars: number;
    /** Speaker names whose "Name:" prefix is stripped from the start of lines. */
    names: readonly string[];
}

/**
 * Marks where something was removed, so a line left holding nothing but a removed action or
 * OOC note can be dropped entirely instead of turning into a paragraph break.
 */
const REMOVED = '\u0000';

export function cleanReply(raw: string, options: CleanerOptions): string {
    let text = raw.replace(/\r\n?/g, '\n').replaceAll(REMOVED, '');
    text = removeReasoning(text);
    text = removeOoc(text);
    text = stripHtml(text);
    text = stripNamePrefixes(text, options.names);
    if (options.stripMarkdown) text = stripMarkdown(text);
    text = handleActions(text, options.actions);
    text = unwrapQuotedLines(text);
    text = normaliseWhitespace(text);
    if (options.dropUnfinishedSentence) text = dropUnfinishedSentence(text);
    return truncate(text, options.maxChars);
}

const REASONING_TAGS = 'think|thinking|reasoning|reflection';

function removeReasoning(text: string): string {
    let result = text.replace(new RegExp(`<(${REASONING_TAGS})>[\\s\\S]*?</\\1>`, 'gi'), REMOVED);
    // A closing tag with no opener: everything before it was reasoning.
    const closer = new RegExp(`</(?:${REASONING_TAGS})>`, 'gi');
    let lastCloser = -1;
    for (const match of result.matchAll(closer)) lastCloser = match.index + match[0].length;
    if (lastCloser >= 0) result = result.slice(lastCloser);
    // An opener with no closer: everything after it is reasoning.
    const opener = new RegExp(`<(?:${REASONING_TAGS})>`, 'i').exec(result);
    if (opener) result = result.slice(0, opener.index);
    return result;
}

function removeOoc(text: string): string {
    return text
        .replace(/\(\([\s\S]*?\)\)/g, REMOVED)
        .replace(/\[\s*OOC\s*:[\s\S]*?\]/gi, REMOVED)
        .replace(/\(\s*OOC\s*:[^)]*\)/gi, REMOVED)
        .replace(/^[ \t]*OOC[ \t]*:.*$/gim, REMOVED);
}

const ENTITIES: Readonly<Record<string, string>> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
    '&nbsp;': ' ',
};

function stripHtml(text: string): string {
    return text
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<br\s*\/?>/gi, '\n')
        // Tags start with a letter or "/", so emoticons like "<3" survive.
        .replace(/<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?>/gi, '')
        .replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (entity) => ENTITIES[entity] ?? entity);
}

function stripNamePrefixes(text: string, names: readonly string[]): string {
    const usable = names.map((n) => n.trim()).filter((n) => n !== '');
    if (usable.length === 0) return text;
    const alternatives = usable.map(escapeRegExp).join('|');
    return text.replace(new RegExp(`^[ \\t]*(?:\\*\\*)?(?:${alternatives})(?:\\*\\*)?[ \\t]*:[ \\t]*`, 'gim'), '');
}

function stripMarkdown(text: string): string {
    return text
        .replace(/```[^\n]*\n([\s\S]*?)```/g, '$1')
        .replace(/`([^`\n]+)`/g, '$1')
        .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
        .replace(/^[ \t]*>[ \t]?/gm, '')
        .replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, '')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\[([^\]]+)\]\((\S+?)\)/g, (_match, label: string, url: string) =>
            label === url ? url : `${label} (${url})`,
        )
        .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '$1')
        .replace(/(?<![\w])__(?=\S)([\s\S]*?\S)__(?![\w])/g, '$1')
        .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1');
}

/**
 * Single-asterisk spans on one line, not part of a ** pair, with no space just inside the
 * asterisks (so "5 * 3 = 15 and 2 * 4" is left alone).
 */
const ACTION = /[ \t]*(?<!\*)\*(?![\s*])([^*\n]*?[^\s*])\*(?!\*)/g;

function handleActions(text: string, mode: CleanerOptions['actions']): string {
    switch (mode) {
        case 'keep':
            return text;
        case 'remove':
            // Taking the preceding spaces with it turns "Fine *sighs*, ok" into "Fine, ok".
            return text.replace(ACTION, REMOVED);
        case 'unwrap':
            return text.replace(ACTION, (match, inner: string) => `${/^[ \t]/.test(match) ? ' ' : ''}${inner}`);
    }
}

const QUOTE_PAIRS: readonly (readonly [string, string])[] = [
    ['"', '"'],
    ['\u201C', '\u201D'],
    ['\u00AB', '\u00BB'],
];

/** A line that is entirely one quotation becomes the bare words. */
function unwrapQuotedLines(text: string): string {
    return text
        .split('\n')
        .map((line) => {
            const trimmed = line.trim();
            for (const [open, close] of QUOTE_PAIRS) {
                if (trimmed.length > 2 && trimmed.startsWith(open) && trimmed.endsWith(close)) {
                    const inner = trimmed.slice(open.length, -close.length);
                    if (!inner.includes(open) && !inner.includes(close)) return inner.trim();
                }
            }
            return line;
        })
        .join('\n');
}

function normaliseWhitespace(text: string): string {
    return text
        .split('\n')
        .filter((line) => !(line.includes(REMOVED) && line.replaceAll(REMOVED, '').trim() === ''))
        .join('\n')
        .replaceAll(REMOVED, '')
        .replace(/[ \t\u00A0]+/g, ' ')
        .split('\n')
        .map((line) => line.trim())
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

const SENTENCE_END = /[.!?\u2026][)"'\u201D\u2019\]]*$/u;
const FRIENDLY_END = /(?:\p{Extended_Pictographic}|[:;]-?[()DPp]|<3|[)~*])$/u;

function dropUnfinishedSentence(text: string): string {
    if (SENTENCE_END.test(text) || FRIENDLY_END.test(text)) return text;
    let cut = -1;
    for (const match of text.matchAll(/[.!?\u2026][)"'\u201D\u2019\]]*(?=\s)/gu)) {
        cut = match.index + match[0].length;
    }
    if (cut <= 0) return text;
    return text.slice(0, cut).trim();
}

function truncate(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    let cut = text.slice(0, maxChars);
    // Never leave half a surrogate pair (an emoji cut in two).
    if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);

    let sentenceEnd = -1;
    for (const match of cut.matchAll(/[.!?\u2026](?=\s)/g)) sentenceEnd = match.index + 1;
    if (sentenceEnd >= maxChars / 2) return cut.slice(0, sentenceEnd).trim();

    const space = cut.search(/\s\S*$/);
    return (space > 0 ? cut.slice(0, space) : cut).trim();
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
