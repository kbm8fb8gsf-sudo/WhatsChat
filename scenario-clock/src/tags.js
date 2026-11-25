// @ts-check
/**
 * [TIME: ...] tags inside message text. They stay in the stored message, so editing a message
 * or swiping to another reply changes the clock naturally. They're only hidden on screen.
 */

import { parseInstruction } from './instructions.js';

/** Matches one tag; group 1 is the instruction. Make a fresh RegExp before using it with lastIndex. */
export const TAG_SOURCE = String.raw`\[\s*time\s*:\s*([^\[\]\n]{1,100}?)\s*\]`;

/**
 * @typedef {object} FoundTag
 * @property {number} index Where the tag starts in the text.
 * @property {string} raw The whole tag, e.g. "[TIME: +2h]".
 * @property {string} instruction The part after the colon, e.g. "+2h".
 * @property {import('./instructions.js').Instruction} parsed
 */

/**
 * Valid tags only, in order. Tags whose instruction can't be read are skipped, so they stay
 * visible and the user can see something is off.
 * @param {unknown} text
 * @returns {FoundTag[]}
 */
export function findTags(text) {
    if (typeof text !== 'string' || !/\[\s*time\s*:/i.test(text)) return [];
    /** @type {FoundTag[]} */
    const found = [];
    const pattern = new RegExp(TAG_SOURCE, 'gi');
    for (const match of text.matchAll(pattern)) {
        const instruction = (match[1] ?? '').trim();
        const parsed = parseInstruction(instruction);
        if (parsed) found.push({ index: match.index, raw: match[0], instruction, parsed });
    }
    return found;
}
