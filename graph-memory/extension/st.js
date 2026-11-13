// @ts-check
/**
 * The only file that touches SillyTavern itself. Everything goes through getContext(),
 * except the "is it generating?" flag, which getContext() doesn't offer and is read from
 * /script.js's live export instead (verified against SillyTavern 1.19.0).
 */
import { POSITION_VALUES, ROLE_VALUES } from './settings-model.js';

export const PROMPT_KEY = 'graph_memory';
/** Kept in a variable so bundlers and type checkers leave this runtime import alone. */
const SCRIPT_URL = '/script.js';

/**
 * @typedef {object} ActiveChat
 * @property {string} chatId          SillyTavern's chat id (the chat file name)
 * @property {string} chatLabel
 * @property {'character' | 'group'} kind
 * @property {string} owner           character avatar file or group id
 * @property {string} ownerName       character or group name
 * @property {string} charName
 * @property {string} userName
 */

/**
 * @param {{ getContext?: () => any, importScript?: () => Promise<any>, sleep?: (ms: number) => Promise<void> }} [deps]
 */
export function createSt(deps = {}) {
    const getContext = deps.getContext ?? (() => SillyTavern.getContext());
    const importScript = deps.importScript ?? (() => import(/* webpackIgnore: true */ SCRIPT_URL));
    const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    /** @type {Promise<any> | null} */
    let scriptModule = null;
    const script = () => (scriptModule ??= importScript().catch(() => ({})));

    return {
        context: getContext,

        /** @returns {ActiveChat | null} */
        activeChat() {
            const ctx = getContext();
            const chatId = ctx.getCurrentChatId?.();
            if (!chatId) return null;
            const userName = String(ctx.name1 ?? '');
            if (ctx.groupId) {
                const group = (ctx.groups ?? []).find((/** @type {any} */ g) => String(g.id) === String(ctx.groupId));
                const name = String(group?.name ?? 'Group');
                return { chatId: String(chatId), chatLabel: String(chatId), kind: 'group', owner: String(ctx.groupId), ownerName: name, charName: name, userName };
            }
            const character = ctx.characters?.[ctx.characterId];
            if (!character?.avatar) return null;
            const name = String(character.name ?? ctx.name2 ?? 'Character');
            return { chatId: String(chatId), chatLabel: String(chatId), kind: 'character', owner: String(character.avatar), ownerName: name, charName: name, userName };
        },

        /** @returns {any[]} */
        chat() {
            return getContext().chat ?? [];
        },

        async isBusy() {
            const m = await script();
            return Boolean(m.is_send_press || m.isChatSaving);
        },

        /** @param {number} timeoutMs */
        async waitUntilIdle(timeoutMs) {
            const start = Date.now();
            while (await this.isBusy()) {
                if (Date.now() - start > timeoutMs) return false;
                await sleep(500);
            }
            return true;
        },

        /**
         * Asks the AI, either through the current connection or a chosen connection profile
         * (which leaves the user's own connection untouched).
         * @param {{ system: string, user: string, responseTokens: number, profileId: string }} req
         * @returns {Promise<string>}
         */
        async generate(req) {
            const ctx = getContext();
            if (req.profileId) {
                const svc = ctx.ConnectionManagerRequestService;
                if (!svc) throw new Error('Connection profiles need SillyTavern\'s Connection Manager extension.');
                const result = await svc.sendRequest(
                    req.profileId,
                    [{ role: 'system', content: req.system }, { role: 'user', content: req.user }],
                    req.responseTokens,
                    { stream: false, extractData: true },
                );
                return typeof result === 'string' ? result : String(result?.content ?? '');
            }
            if (typeof ctx.generateRaw !== 'function') throw new Error('This SillyTavern version has no generateRaw().');
            return String(await ctx.generateRaw({ systemPrompt: req.system, prompt: req.user, responseLength: req.responseTokens }) ?? '');
        },

        /** @returns {{ id: string, name: string }[]} */
        profiles() {
            try {
                const svc = getContext().ConnectionManagerRequestService;
                return (svc?.getSupportedProfiles?.() ?? []).map((/** @type {any} */ p) => ({ id: String(p.id), name: String(p.name ?? p.id) }));
            } catch {
                return [];
            }
        },

        /**
         * @param {string} text
         * @param {import('./settings-model.js').Settings['recall']} recall
         */
        setPrompt(text, recall) {
            getContext().setExtensionPrompt(PROMPT_KEY, text, POSITION_VALUES[recall.position], recall.depth, false, ROLE_VALUES[recall.role]);
        },

        clearPrompt() {
            getContext().setExtensionPrompt(PROMPT_KEY, '', POSITION_VALUES.in_chat, 0);
        },

        /** @returns {Record<string, string>} */
        requestHeaders() {
            return getContext().getRequestHeaders();
        },

        /**
         * @param {string} event key of eventTypes, e.g. 'CHAT_CHANGED'
         * @param {(...args: any[]) => void} handler
         */
        on(event, handler) {
            const ctx = getContext();
            const name = ctx.eventTypes?.[event];
            if (name) ctx.eventSource.on(name, handler);
        },

        /** @param {string} text */
        async confirm(text) {
            const ctx = getContext();
            if (typeof ctx.callGenericPopup === 'function' && ctx.POPUP_TYPE) {
                return (await ctx.callGenericPopup(text, ctx.POPUP_TYPE.CONFIRM)) === (ctx.POPUP_RESULT?.AFFIRMATIVE ?? 1);
            }
            return window.confirm(text);
        },

        settingsRoot() {
            return getContext().extensionSettings;
        },

        saveSettings() {
            getContext().saveSettingsDebounced();
        },
    };
}

/** @typedef {ReturnType<typeof createSt>} St */
