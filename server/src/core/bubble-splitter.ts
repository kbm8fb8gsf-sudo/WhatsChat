/**
 * Splits a cleaned reply into separate message bubbles. Pure.
 *
 * Paragraphs (blank-line separated) become bubbles, because the realistic-text note asks the
 * model to separate messages that way. A paragraph longer than maxBubbleChars is split at
 * sentence boundaries, then at word boundaries if a single sentence is still too long.
 */

export interface SplitterOptions {
    maxBubbleChars: number;
    /** A trailing fragment shorter than this, left over from splitting a long paragraph, joins the previous bubble. */
    minBubbleChars: number;
    maxBubbles: number;
}

export function splitBubbles(text: string, options: SplitterOptions): string[] {
    const paragraphs = text
        .split(/\n[ \t]*\n+/)
        .map((p) => p.trim())
        .filter((p) => p !== '');
    const bubbles = paragraphs.flatMap((paragraph) =>
        paragraph.length <= options.maxBubbleChars ? [paragraph] : splitParagraph(paragraph, options),
    );
    return capBubbles(bubbles, options.maxBubbles);
}

interface Piece {
    text: string;
    /** Separator to use when joining this piece with the next: a newline if one was there originally. */
    separator: ' ' | '\n';
}

function splitParagraph(paragraph: string, options: SplitterOptions): string[] {
    const max = options.maxBubbleChars;
    const pieces = splitSentences(paragraph).flatMap((piece) =>
        piece.text.length <= max
            ? [piece]
            : wrapWords(piece.text, max).map((text, i, all): Piece => ({
                  text,
                  separator: i === all.length - 1 ? piece.separator : ' ',
              })),
    );

    const chunks: Piece[] = [];
    for (const piece of pieces) {
        const last = chunks.at(-1);
        if (last && last.text.length + 1 + piece.text.length <= max) {
            last.text = `${last.text}${last.separator}${piece.text}`;
            last.separator = piece.separator;
        } else {
            chunks.push({ ...piece });
        }
    }

    const tail = chunks.at(-1);
    const beforeTail = chunks.at(-2);
    if (tail && beforeTail && tail.text.length < options.minBubbleChars) {
        beforeTail.text = `${beforeTail.text}${beforeTail.separator}${tail.text}`;
        chunks.pop();
    }
    return chunks.map((chunk) => chunk.text);
}

const ABBREVIATIONS = new Set([
    'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'approx', 'inc', 'ltd', 'co', 'no', 'mt', 'ft',
]);

/** Sentence-ish pieces of one paragraph. Single newlines are always boundaries. */
export function splitSentences(paragraph: string): Piece[] {
    const pieces: Piece[] = [];
    const boundary = /([.!?\u2026]+[)"'\u201D\u2019\]]*)[ \t]+|[ \t]*\n[ \t]*/gu;
    let start = 0;
    for (const match of paragraph.matchAll(boundary)) {
        const punctuation = match[1];
        if (punctuation !== undefined) {
            if (isAbbreviation(paragraph.slice(start, match.index), punctuation)) continue;
            pieces.push({ text: paragraph.slice(start, match.index + punctuation.length).trim(), separator: ' ' });
        } else {
            pieces.push({ text: paragraph.slice(start, match.index).trim(), separator: '\n' });
        }
        start = match.index + match[0].length;
    }
    pieces.push({ text: paragraph.slice(start).trim(), separator: ' ' });
    return pieces.filter((piece) => piece.text !== '');
}

function isAbbreviation(before: string, punctuation: string): boolean {
    if (punctuation !== '.') return false;
    const word = /(\S+)$/.exec(before)?.[1]?.replace(/^[("'\u201C]+/, '').toLowerCase();
    if (word === undefined) return false;
    // Known abbreviations, single initials ("J. Smith") and dotted forms ("e.g", "p.m").
    return ABBREVIATIONS.has(word) || /^\p{L}$/u.test(word) || /^(?:\p{L}\.)+\p{L}$/u.test(word);
}

/** Break text longer than max at the last comma/semicolon, else the last space, before the limit. */
function wrapWords(text: string, max: number): string[] {
    const lines: string[] = [];
    let rest = text;
    while (rest.length > max) {
        const window = rest.slice(0, max + 1);
        let cut = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '));
        cut = cut >= max / 2 ? cut + 1 : window.lastIndexOf(' ');
        if (cut <= 0) cut = max; // a single huge word, such as a URL
        lines.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
    }
    if (rest !== '') lines.push(rest);
    return lines;
}

function capBubbles(bubbles: string[], maxBubbles: number): string[] {
    if (bubbles.length <= maxBubbles) return bubbles;
    const kept = bubbles.slice(0, Math.max(0, maxBubbles - 1));
    return [...kept, bubbles.slice(kept.length).join('\n')];
}
