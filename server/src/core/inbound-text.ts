/** Inbound text handling. Pure. */

const ZERO_WIDTH_SPACE = '\u200B';

/**
 * Stop SillyTavern expanding {{macros}} a contact types (PLAN.md decision 5). An invisible
 * zero-width space between the braces leaves the text looking the same.
 */
export function neutraliseMacros(text: string): string {
    return text.replace(/\{\{/g, `{${ZERO_WIDTH_SPACE}{`);
}

/** Join a batch of inbound messages into the single user message SillyTavern receives. */
export function joinBatchText(texts: readonly string[], options: { neutraliseMacros: boolean }): string {
    const joined = texts
        .map((t) => t.trim())
        .filter((t) => t !== '')
        .join('\n');
    return options.neutraliseMacros ? neutraliseMacros(joined) : joined;
}
