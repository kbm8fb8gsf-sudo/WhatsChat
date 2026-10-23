// @ts-check
import { describe, expect, it, vi } from 'vitest';
import { createBridge, sameChat } from '../st-bridge.js';

function fakeSillyTavern() {
    const state = {
        characterId: /** @type {string | undefined} */ ('0'),
        groupId: /** @type {string | null} */ (null),
        groupChat: /** @type {string | null} */ (null),
        /** @type {STChatMessage[]} */
        chat: [],
        characters: [
            { avatar: 'Seraphina.png', name: 'Seraphina', chat: 'Seraphina - old' },
            { avatar: 'Sensei.png', name: 'Coding Sensei', chat: 'Sensei - 1' },
        ],
        /** @type {Record<string, { value: string, position: number, depth: number, role?: number, filter?: (() => boolean | Promise<boolean>) | null }>} */
        prompts: {},
        ignoreSelect: false,
        replyOnGenerate: true,
    };
    const ctx = {
        get chat() {
            return state.chat;
        },
        characters: state.characters,
        get characterId() {
            return state.characterId;
        },
        get groupId() {
            return state.groupId;
        },
        get chatId() {
            if (state.groupId) return state.groupChat ?? undefined;
            return state.characterId === undefined ? undefined : state.characters[Number(state.characterId)]?.chat;
        },
        name1: 'Lewis',
        name2: 'Seraphina',
        eventSource: { on: vi.fn(), removeListener: vi.fn() },
        eventTypes: {},
        extensionSettings: {},
        getRequestHeaders: () => ({ 'X-CSRF-Token': 't' }),
        getCurrentChatId: () => undefined,
        saveChat: () => Promise.resolve(),
        selectCharacterById: vi.fn((/** @type {number} */ id) => {
            if (!state.ignoreSelect) {
                state.characterId = String(id);
                state.groupId = null;
            }
            return Promise.resolve();
        }),
        openCharacterChat: vi.fn((/** @type {string} */ file) => {
            const character = state.characters[Number(state.characterId)];
            if (character) character.chat = file;
            return Promise.resolve();
        }),
        openGroupChat: vi.fn((/** @type {string} */ groupId, /** @type {string | undefined} */ chatId) => {
            state.groupId = groupId;
            state.groupChat = chatId ?? null;
            state.characterId = undefined;
            return Promise.resolve();
        }),
        setExtensionPrompt: vi.fn((key, value, position, depth, _scan, role, filter) => {
            state.prompts[key] = { value, position, depth, role, filter };
        }),
        generate: vi.fn(() => {
            if (state.replyOnGenerate) state.chat.push({ name: 'Seraphina', is_user: false, is_system: false, mes: 'hello there' });
            return Promise.resolve();
        }),
    };
    const script = {
        sendMessageAsUser: vi.fn((/** @type {string} */ text) => {
            const message = { name: 'Lewis', is_user: true, is_system: false, mes: text };
            state.chat.push(message);
            return Promise.resolve(message);
        }),
        doNewChat: vi.fn(() => {
            const character = state.characters[Number(state.characterId)];
            if (character) character.chat = `${character.name} - new`;
            return Promise.resolve();
        }),
        is_send_press: false,
        isChatSaving: false,
    };
    const fetchImpl = vi.fn(() =>
        Promise.resolve(
            new Response(
                JSON.stringify([
                    { file_name: 'Seraphina - WhatsApp.jsonl', file_id: 'Seraphina - WhatsApp' },
                    { file_name: 'Seraphina - old.jsonl', file_id: 'Seraphina - old' },
                ]),
            ),
        ),
    );
    const bridge = createBridge({
        getContext: () => /** @type {STContext} */ (/** @type {unknown} */ (ctx)),
        loadScript: () => Promise.resolve(script),
        fetchImpl: /** @type {typeof fetch} */ (/** @type {unknown} */ (fetchImpl)),
        sleep: () => Promise.resolve(),
    });
    return { state, ctx, script, fetchImpl, bridge };
}

describe('st-bridge', () => {
    it('describes the active chat', () => {
        const st = fakeSillyTavern();
        expect(st.bridge.getActiveChat()).toEqual({ kind: 'character', characterAvatar: 'Seraphina.png', chatFile: 'Seraphina - old' });
        st.state.groupId = 'g1';
        st.state.groupChat = 'group chat';
        expect(st.bridge.getActiveChat()).toEqual({ kind: 'group', groupId: 'g1', chatFile: 'group chat' });
        st.state.groupId = null;
        st.state.characterId = undefined;
        expect(st.bridge.getActiveChat()).toBeNull();
    });

    it('lists chats newest first using the CSRF headers', async () => {
        const st = fakeSillyTavern();
        expect(await st.bridge.listChats('Seraphina.png')).toEqual(['Seraphina - old', 'Seraphina - WhatsApp']);
        expect(st.fetchImpl).toHaveBeenCalledWith('/api/characters/chats', {
            method: 'POST',
            headers: { 'X-CSRF-Token': 't' },
            body: JSON.stringify({ avatar_url: 'Seraphina.png', simple: true }),
        });
    });

    it('opens the mapped chat, switching character if needed', async () => {
        const st = fakeSillyTavern();
        st.state.characterId = '1';
        const opened = await st.bridge.openChat({ characterAvatar: 'Seraphina.png', chatFile: 'Seraphina - WhatsApp' });
        expect(opened).toEqual({ chatFile: 'Seraphina - WhatsApp', characterName: 'Seraphina' });
        expect(st.ctx.selectCharacterById).toHaveBeenCalledWith(0, { switchMenu: false });
        expect(st.ctx.openCharacterChat).toHaveBeenCalledWith('Seraphina - WhatsApp');
    });

    it('does nothing when the mapped chat is already open', async () => {
        const st = fakeSillyTavern();
        await st.bridge.openChat({ characterAvatar: 'Seraphina.png', chatFile: 'Seraphina - old' });
        expect(st.ctx.selectCharacterById).not.toHaveBeenCalled();
        expect(st.ctx.openCharacterChat).not.toHaveBeenCalled();
    });

    it('creates a new chat for a contact without one', async () => {
        const st = fakeSillyTavern();
        const opened = await st.bridge.openChat({ characterAvatar: 'Seraphina.png', chatFile: null });
        expect(st.script.doNewChat).toHaveBeenCalledWith({ deleteCurrentChat: false });
        expect(opened).toEqual({ chatFile: 'Seraphina - new', characterName: 'Seraphina' });
    });

    it('refuses missing characters, missing chats and switches that did not happen', async () => {
        const st = fakeSillyTavern();
        await expect(st.bridge.openChat({ characterAvatar: 'Nobody.png', chatFile: null })).rejects.toThrow('was not found');
        await expect(st.bridge.openChat({ characterAvatar: 'Seraphina.png', chatFile: 'Deleted' })).rejects.toThrow(
            'no longer exists',
        );
        st.state.ignoreSelect = true;
        await expect(st.bridge.openChat({ characterAvatar: 'Sensei.png', chatFile: null })).rejects.toThrow(
            'did not switch',
        );
    });

    it('posts the user message through SillyTavern\u2019s own send', async () => {
        const st = fakeSillyTavern();
        await st.bridge.addUserMessage('hi');
        expect(st.script.sendMessageAsUser).toHaveBeenCalledWith('hi', '');
    });

    it('injects the note in-chat as a system message, only while active', async () => {
        const st = fakeSillyTavern();
        st.bridge.setNote('You are texting.');
        const prompt = st.state.prompts['whatschat_realistic_note'];
        expect(prompt).toMatchObject({ value: 'You are texting.', position: 1, depth: 0, role: 0 });
        expect(await prompt?.filter?.()).toBe(true);
        st.bridge.clearNote();
        expect(st.state.prompts['whatschat_realistic_note']).toMatchObject({ value: '' });
        expect(await prompt?.filter?.()).toBe(false);
    });

    it('returns the generated reply, or fails clearly when there is none', async () => {
        const st = fakeSillyTavern();
        expect(await st.bridge.generateReply()).toBe('hello there');
        st.state.replyOnGenerate = false;
        await expect(st.bridge.generateReply()).rejects.toThrow('did not produce a reply');
    });

    it('waits while SillyTavern is generating or saving', async () => {
        const st = fakeSillyTavern();
        st.script.is_send_press = true;
        let checks = 0;
        const bridge = createBridge({
            getContext: () => /** @type {STContext} */ (/** @type {unknown} */ (st.ctx)),
            loadScript: () => Promise.resolve(st.script),
            sleep: () => {
                checks++;
                if (checks === 3) st.script.is_send_press = false;
                return Promise.resolve();
            },
        });
        await bridge.waitUntilIdle();
        expect(checks).toBe(3);
    });

    it('gives up waiting after the timeout', async () => {
        const st = fakeSillyTavern();
        st.script.isChatSaving = true;
        let time = 0;
        const bridge = createBridge({
            getContext: () => /** @type {STContext} */ (/** @type {unknown} */ (st.ctx)),
            loadScript: () => Promise.resolve(st.script),
            sleep: () => {
                time += 1_000;
                return Promise.resolve();
            },
            now: () => time,
        });
        await expect(bridge.waitUntilIdle(5_000)).rejects.toThrow('busy');
    });

    it('explains which SillyTavern internals are missing', async () => {
        const bridge = createBridge({
            getContext: () => /** @type {STContext} */ (/** @type {unknown} */ (fakeSillyTavern().ctx)),
            loadScript: () => Promise.resolve({ sendMessageAsUser: () => undefined }),
        });
        await expect(bridge.addUserMessage('x')).rejects.toThrow('doNewChat, is_send_press, isChatSaving');
    });

    it('restores the previous character chat or group chat', async () => {
        const st = fakeSillyTavern();
        const previous = st.bridge.getActiveChat();
        await st.bridge.openChat({ characterAvatar: 'Sensei.png', chatFile: null });
        await st.bridge.restoreChat(previous);
        expect(st.bridge.getActiveChat()).toEqual(previous);

        await st.bridge.restoreChat({ kind: 'group', groupId: 'g1', chatFile: 'group chat' });
        expect(st.ctx.openGroupChat).toHaveBeenCalledWith('g1', 'group chat');
        await st.bridge.restoreChat(null);
    });
});

describe('sameChat', () => {
    it('compares kind, owner and chat', () => {
        const a = /** @type {const} */ ({ kind: 'character', characterAvatar: 'A.png', chatFile: 'x' });
        expect(sameChat(a, { ...a })).toBe(true);
        expect(sameChat(a, { ...a, chatFile: 'y' })).toBe(false);
        expect(sameChat(a, { kind: 'group', groupId: 'A.png', chatFile: 'x' })).toBe(false);
        expect(sameChat(a, null)).toBe(false);
    });
});
