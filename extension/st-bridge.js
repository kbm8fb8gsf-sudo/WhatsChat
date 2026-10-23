// @ts-check
/**
 * The only module that touches SillyTavern internals. Everything else in the extension goes
 * through the Bridge returned by createBridge(), so a SillyTavern update should only need
 * changes here, and tests can substitute a fake.
 *
 * getContext() is used wherever it offers what we need. sendMessageAsUser, doNewChat and the
 * busy flags aren't part of getContext(), so they're imported from /script.js (PLAN.md,
 * decision 2). Verified against SillyTavern 1.19.0.
 */

const SCRIPT_URL = '/script.js';
const NOTE_KEY = 'whatschat_realistic_note';
/** Fallbacks for extension_prompt_types.IN_CHAT and extension_prompt_roles.SYSTEM. */
const IN_CHAT = 1;
const SYSTEM_ROLE = 0;

/**
 * @typedef {{ kind: 'character', characterAvatar: string, chatFile: string | null }
 *   | { kind: 'group', groupId: string, chatFile: string | null }} ActiveChat
 * @typedef {{ characterAvatar: string, chatFile: string | null }} ChatTarget
 * @typedef {{ chatFile: string, characterName: string }} OpenedChat
 * @typedef {{ avatar: string, name: string }} CharacterInfo
 * @typedef {'info' | 'success' | 'warning' | 'error'} NoticeLevel
 */

/**
 * @typedef {object} Bridge
 * @property {() => Record<string, string>} requestHeaders Headers (including CSRF) for SillyTavern API calls.
 * @property {() => CharacterInfo[]} listCharacters
 * @property {(avatar: string) => Promise<string[]>} listChats Chat file names (without .jsonl), newest first.
 * @property {() => ActiveChat | null} getActiveChat
 * @property {(timeoutMs?: number) => Promise<void>} waitUntilIdle Wait until SillyTavern isn't generating or saving.
 * @property {(target: ChatTarget) => Promise<OpenedChat>} openChat Open the mapped chat, creating one if none is mapped.
 * @property {(text: string) => Promise<void>} addUserMessage Post text as the user, exactly as if typed.
 * @property {(note: string) => void} setNote Inject the realistic-text note into bridge generations only.
 * @property {() => void} clearNote
 * @property {() => Promise<string>} generateReply Generate the character's reply and return its text.
 * @property {(previous: ActiveChat | null) => Promise<void>} restoreChat
 * @property {() => string} userName
 * @property {(message: string, level?: NoticeLevel) => void} notify
 */

/**
 * @param {{
 *   getContext?: () => STContext,
 *   loadScript?: () => Promise<unknown>,
 *   fetchImpl?: typeof fetch,
 *   sleep?: (ms: number) => Promise<void>,
 *   now?: () => number,
 * }} [deps]
 * @returns {Bridge}
 */
export function createBridge(deps = {}) {
    const getContext = deps.getContext ?? (() => SillyTavern.getContext());
    const loadScript = deps.loadScript ?? (() => import(/* webpackIgnore: true */ SCRIPT_URL));
    const fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
    const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const now = deps.now ?? (() => Date.now());

    /** @type {Promise<STScriptModule> | null} */
    let scriptPromise = null;
    let noteActive = false;

    /** @returns {Promise<STScriptModule>} */
    function script() {
        scriptPromise ??= loadScript().then((module) => checkScriptModule(module));
        return scriptPromise;
    }

    /** @param {string} avatar */
    function characterIndex(avatar) {
        return getContext().characters.findIndex((c) => c.avatar === avatar);
    }

    /** @returns {ActiveChat | null} */
    function getActiveChat() {
        const ctx = getContext();
        const chatFile = ctx.chatId ?? null;
        if (ctx.groupId) return { kind: 'group', groupId: ctx.groupId, chatFile };
        if (ctx.characterId === undefined || ctx.characterId === null || ctx.characterId === '') return null;
        const character = ctx.characters[Number(ctx.characterId)];
        return character ? { kind: 'character', characterAvatar: character.avatar, chatFile } : null;
    }

    /** @param {number} timeoutMs */
    async function waitUntilIdle(timeoutMs = 10 * 60_000) {
        const module = await script();
        const start = now();
        while (module.is_send_press || module.isChatSaving) {
            if (now() - start > timeoutMs) throw new Error('SillyTavern stayed busy for too long');
            await sleep(250);
        }
    }

    /** @param {string} avatar */
    async function listChats(avatar) {
        const response = await fetchImpl('/api/characters/chats', {
            method: 'POST',
            headers: getContext().getRequestHeaders(),
            body: JSON.stringify({ avatar_url: avatar, simple: true }),
        });
        if (!response.ok) return [];
        /** @type {unknown} */
        const data = await response.json();
        if (!Array.isArray(data)) return [];
        return data
            .map((entry) => (entry && typeof entry === 'object' && 'file_id' in entry ? String(entry.file_id) : ''))
            .filter((name) => name !== '')
            .sort()
            .reverse();
    }

    /**
     * selectCharacterById silently does nothing in some states, so confirm it worked.
     * @param {number} index
     */
    async function selectCharacter(index) {
        const ctx = getContext();
        const current = getActiveChat();
        const character = ctx.characters[index];
        if (current?.kind === 'character' && current.characterAvatar === character?.avatar) return;
        await ctx.selectCharacterById(index, { switchMenu: false });
        if (String(getContext().characterId) !== String(index)) {
            throw new Error('SillyTavern did not switch to the character');
        }
    }

    return {
        requestHeaders: () => getContext().getRequestHeaders(),

        listCharacters: () => getContext().characters.map((c) => ({ avatar: c.avatar, name: c.name })),

        listChats,

        getActiveChat,

        waitUntilIdle,

        async openChat(target) {
            const index = characterIndex(target.characterAvatar);
            const character = getContext().characters[index];
            if (index < 0 || !character) throw new Error(`Character "${target.characterAvatar}" was not found`);
            const characterName = character.name;
            await selectCharacter(index);

            if (target.chatFile) {
                if (getContext().chatId !== target.chatFile) {
                    const chats = await listChats(target.characterAvatar);
                    if (!chats.includes(target.chatFile)) {
                        throw new Error(`The chat "${target.chatFile}" no longer exists for ${characterName}`);
                    }
                    await getContext().openCharacterChat(target.chatFile);
                }
                return { chatFile: target.chatFile, characterName };
            }

            // No chat mapped yet: start a fresh one for this contact.
            await (await script()).doNewChat({ deleteCurrentChat: false });
            const chatFile = getContext().chatId;
            if (!chatFile) throw new Error('Could not create a new chat');
            return { chatFile, characterName };
        },

        async addUserMessage(text) {
            await (await script()).sendMessageAsUser(text, '');
        },

        setNote(note) {
            noteActive = true;
            getContext().setExtensionPrompt(NOTE_KEY, note, IN_CHAT, 0, false, SYSTEM_ROLE, () => noteActive);
        },

        clearNote() {
            noteActive = false;
            getContext().setExtensionPrompt(NOTE_KEY, '', IN_CHAT, 0, false, SYSTEM_ROLE, null);
        },

        async generateReply() {
            const before = getContext().chat.length;
            // Resolves once the reply is saved, for streaming and non-streaming APIs alike.
            await getContext().generate('normal');
            const chat = getContext().chat;
            const last = chat.at(-1);
            if (chat.length <= before || !last || last.is_user || last.is_system) {
                throw new Error('SillyTavern did not produce a reply. Check that an API is connected.');
            }
            return last.mes;
        },

        async restoreChat(previous) {
            if (!previous || sameChat(getActiveChat(), previous)) return;
            await waitUntilIdle();
            const ctx = getContext();
            if (previous.kind === 'group') {
                await ctx.openGroupChat(previous.groupId, previous.chatFile ?? undefined);
                return;
            }
            const index = characterIndex(previous.characterAvatar);
            if (index < 0) return;
            await selectCharacter(index);
            if (previous.chatFile && getContext().chatId !== previous.chatFile) {
                await getContext().openCharacterChat(previous.chatFile);
            }
        },

        userName: () => getContext().name1,

        notify(message, level = 'info') {
            const toastr = /** @type {{ toastr?: Record<NoticeLevel, (m: string, t?: string) => void> }} */ (
                /** @type {unknown} */ (globalThis)
            ).toastr;
            if (toastr) toastr[level](message, 'WhatsChat');
            else console.info(`[WhatsChat] ${message}`);
        },
    };
}

/**
 * @param {ActiveChat | null} a
 * @param {ActiveChat | null} b
 */
export function sameChat(a, b) {
    if (!a || !b || a.kind !== b.kind || a.chatFile !== b.chatFile) return false;
    if (a.kind === 'group' && b.kind === 'group') return a.groupId === b.groupId;
    if (a.kind === 'character' && b.kind === 'character') return a.characterAvatar === b.characterAvatar;
    return false;
}

/**
 * Fail loudly, with a useful message, if SillyTavern's internals have moved.
 * @param {unknown} module
 * @returns {STScriptModule}
 */
function checkScriptModule(module) {
    const exports = /** @type {Record<string, unknown>} */ (module);
    const missing = [];
    if (typeof exports['sendMessageAsUser'] !== 'function') missing.push('sendMessageAsUser');
    if (typeof exports['doNewChat'] !== 'function') missing.push('doNewChat');
    if (!('is_send_press' in exports)) missing.push('is_send_press');
    if (!('isChatSaving' in exports)) missing.push('isChatSaving');
    if (missing.length > 0) {
        throw new Error(
            `This SillyTavern version doesn't provide ${missing.join(', ')}, which WhatsChat needs. ` +
                'Please update WhatsChat or report this.',
        );
    }
    return /** @type {STScriptModule} */ (module);
}
