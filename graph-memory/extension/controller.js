// @ts-check
/**
 * Graph Memory's two jobs:
 *  - recall: before each reply, search the memory with the newest messages and insert what
 *    graphify finds into the prompt;
 *  - remember: every few messages, have the AI read the newest settled slice of chat and
 *    send the facts it found to the server, which has graphify rebuild the graph.
 */
import { buildExtractionPrompt, parseExtraction } from './extract-prompt.js';
import { coveredUpTo, fingerprint, hash64, planNextSegment, queryText, staleSegments, transcript } from './transcript.js';

/**
 * @typedef {import('./st.js').St} St
 * @typedef {import('./st.js').ActiveChat} ActiveChat
 * @typedef {import('./api.js').Api} Api
 * @typedef {import('./settings-model.js').Settings} Settings
 */

/**
 * @typedef {object} Scope
 * @property {string} id      memory id on the server
 * @property {string} label
 * @property {ActiveChat} chat
 */

/**
 * @typedef {object} RecallResult
 * @property {string} memory
 * @property {string[]} entities
 * @property {string | null} engine
 * @property {number} ms
 * @property {string} [error]
 * @property {string} at
 */

const RECALL_TIMEOUT_MS = 8000;
const KNOWN_ENTITIES = 60;

/**
 * The memory the open chat belongs to.
 * @param {ActiveChat} chat
 * @param {Settings['scope']} mode
 * @returns {Scope}
 */
export function scopeFor(chat, mode) {
    if (mode === 'character') {
        const prefix = chat.kind === 'group' ? 'group' : 'char';
        return { id: `${prefix}-${hash64(`${chat.kind}:${chat.owner}`)}`, label: chat.ownerName, chat };
    }
    return { id: `chat-${hash64(`${chat.kind}:${chat.owner}:${chat.chatId}`)}`, label: `${chat.ownerName}: ${chat.chatLabel}`, chat };
}

export class MemoryController {
    /**
     * @param {{ st: St, api: Api, settings: () => Settings, notify?: (level: 'info' | 'warning' | 'error' | 'success', msg: string) => void, onChange?: () => void }} deps
     */
    constructor(deps) {
        this.st = deps.st;
        this.api = deps.api;
        this.settings = deps.settings;
        this.notify = deps.notify ?? (() => {});
        this.onChange = deps.onChange ?? (() => {});
        /** @type {RecallResult | null} */
        this.lastRecall = null;
        this.extracting = false;
        /** @type {{ done: number, total: number | null, scope: string } | null} */
        this.progress = null;
        this.stopRequested = false;
        /** @type {string | null} the last automatic-remembering error, shown once per chat */
        this.autoError = null;
        /** @type {ReturnType<typeof setTimeout> | null} */
        this.autoTimer = null;
    }

    /** @returns {Scope | null} */
    currentScope() {
        const chat = this.st.activeChat();
        return chat ? scopeFor(chat, this.settings().scope) : null;
    }

    // ---------------- recall ----------------

    /**
     * SillyTavern's generate_interceptor: runs before every prompt is assembled.
     * @param {any[]} chat the messages going into this prompt
     * @param {string} type 'normal', 'swipe', 'regenerate', 'continue', 'impersonate', 'quiet'…
     */
    async beforeGeneration(chat, type) {
        this.st.clearPrompt();
        const s = this.settings();
        // 'quiet' prompts are background jobs (summaries, other extensions), not story replies.
        if (!s.enabled || !s.recall.enabled || type === 'quiet') return;
        const scope = this.currentScope();
        if (!scope) return;
        const result = await this.recall(scope, chat, false);
        if (result.memory) this.st.setPrompt(s.recall.template.replace('{{memory}}', result.memory), s.recall);
    }

    /**
     * @param {Scope} scope
     * @param {any[]} chat
     * @param {boolean} debug
     * @returns {Promise<RecallResult & { raw?: string }>}
     */
    async recall(scope, chat, debug) {
        const s = this.settings();
        const text = queryText(chat, s.recall.recentMessages);
        /** @type {RecallResult & { raw?: string }} */
        let result;
        try {
            const res = await this.api.recall(scope.id, { text, depth: s.recall.graphDepth, maxChars: s.recall.maxChars, debug }, RECALL_TIMEOUT_MS);
            result = { memory: res.memory ?? '', entities: res.entities ?? [], engine: res.engine, ms: res.ms, raw: res.raw, at: new Date().toISOString() };
        } catch (err) {
            // Never block a reply because memory is unavailable.
            const message = err instanceof Error ? err.message : String(err);
            console.warn('[Graph Memory] Recall failed:', message);
            result = { memory: '', entities: [], engine: null, ms: 0, error: message, at: new Date().toISOString() };
        }
        this.lastRecall = result;
        this.onChange();
        return result;
    }

    /** What would be recalled right now, for the settings panel's preview. */
    async preview() {
        const scope = this.currentScope();
        if (!scope) throw new Error('Open a chat first.');
        return this.recall(scope, this.st.chat(), true);
    }

    // ---------------- remember ----------------

    /** Called after each new message; remembers once enough new messages have settled. */
    scheduleAuto() {
        const s = this.settings();
        if (!s.enabled || !s.extract.auto) return;
        if (this.autoTimer) clearTimeout(this.autoTimer);
        this.autoTimer = setTimeout(() => {
            this.autoTimer = null;
            void this.rememberPending({ manual: false });
        }, 2000);
    }

    /** Clears the per-chat error so a fresh chat gets a fresh attempt. */
    chatChanged() {
        this.autoError = null;
        this.st.clearPrompt();
        this.lastRecall = null;
        this.onChange();
    }

    stop() {
        this.stopRequested = true;
    }

    /**
     * Reads any slices of the open chat that aren't remembered yet.
     * Manual runs ("Remember the whole chat now") also take the newest messages and keep
     * going until the chat is fully covered.
     * @param {{ manual: boolean }} opts
     * @returns {Promise<{ segments: number, entities: number, relations: number }>}
     */
    async rememberPending(opts) {
        const totals = { segments: 0, entities: 0, relations: 0 };
        if (this.extracting) return totals;
        const scope = this.currentScope();
        if (!scope) return totals;
        if (!opts.manual && this.autoError) return totals;
        this.extracting = true;
        this.stopRequested = false;
        this.progress = { done: 0, total: null, scope: scope.id };
        this.onChange();
        try {
            for (;;) {
                if (this.stopRequested) break;
                if (!(await this.st.waitUntilIdle(opts.manual ? 10 * 60_000 : 60_000))) break;
                // The user may have switched chats while we waited.
                const now = this.currentScope();
                if (!now || now.id !== scope.id || now.chat.chatId !== scope.chat.chatId) break;

                const s = this.settings();
                const chat = this.st.chat();
                const info = await this.api.memory(scope.id, scope.chat.chatId);
                let segments = info.segments ?? [];
                const stale = staleSegments(chat, segments);
                if (stale.length) {
                    await this.api.forget(scope.id, scope.chat.chatId, stale);
                    segments = segments.filter((seg) => !stale.includes(seg.id));
                }
                const holdBack = opts.manual ? 0 : s.extract.holdBack;
                const next = planNextSegment(chat.length, segments, {
                    holdBack,
                    minNew: opts.manual ? 1 : s.extract.every,
                    maxSegment: s.extract.maxSegment,
                });
                if (!next) break;
                if (this.progress && this.progress.total === null) {
                    const remaining = Math.max(0, chat.length - holdBack - coveredUpTo(segments));
                    this.progress.total = Math.max(1, Math.ceil(remaining / s.extract.maxSegment));
                }
                const added = await this.rememberSlice(scope, chat, next.from, next.to, s);
                totals.segments++;
                totals.entities += added.entities;
                totals.relations += added.relations;
                if (this.progress) this.progress.done++;
                this.onChange();
            }
            this.autoError = null;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (opts.manual) {
                this.notify('error', `Graph Memory couldn't finish: ${message}`);
            } else {
                // Don't keep retrying (and spending tokens) on every message after a failure.
                this.autoError = message;
                this.notify('warning', `Graph Memory paused remembering for this chat: ${message}`);
            }
        } finally {
            this.extracting = false;
            this.progress = null;
            this.onChange();
        }
        return totals;
    }

    /**
     * @param {Scope} scope
     * @param {any[]} chat
     * @param {number} from
     * @param {number} to
     * @param {Settings} s
     */
    async rememberSlice(scope, chat, from, to, s) {
        const story = transcript(chat, from, to);
        const print = fingerprint(chat, from, to);
        /** @type {{ entities: unknown[], relations: unknown[] }} */
        let found = { entities: [], relations: [] };
        if (story.trim()) {
            const known = await this.api.entities(scope.id, KNOWN_ENTITIES).then((r) => r.entities).catch(() => []);
            const contextFrom = Math.max(0, from - s.extract.contextMessages);
            const prompt = buildExtractionPrompt({
                story,
                context: s.extract.contextMessages > 0 ? transcript(chat, contextFrom, from, 1200) : '',
                known,
                charName: scope.chat.charName,
                userName: scope.chat.userName,
            });
            found = await this.askForFacts(prompt, s);
        }
        const res = await this.api.addSegment(scope.id, {
            chatId: scope.chat.chatId,
            chatLabel: scope.chat.chatLabel,
            scopeLabel: scope.label,
            from,
            to,
            fingerprint: print,
            transcript: story,
            entities: found.entities,
            relations: found.relations,
        });
        return { entities: res.segment.entities, relations: res.segment.relations };
    }

    /**
     * One retry: models occasionally wrap or truncate the JSON.
     * @param {{ system: string, user: string }} prompt
     * @param {Settings} s
     */
    async askForFacts(prompt, s) {
        let lastError = null;
        for (let attempt = 0; attempt < 2; attempt++) {
            const answer = await this.st.generate({ system: prompt.system, user: prompt.user, responseTokens: s.extract.responseTokens, profileId: s.extract.profileId });
            if (!answer.trim()) {
                lastError = new Error('The AI returned an empty answer. Is it connected?');
                continue;
            }
            try {
                return parseExtraction(answer);
            } catch (err) {
                lastError = err;
            }
        }
        throw lastError ?? new Error('No answer');
    }
}
