import { describe, expect, it, vi } from 'vitest';
import { SCOPE_ID_RE } from '../../server/normalize.js';
import { MemoryController, scopeFor } from '../controller.js';
import { normalizeSettings } from '../settings-model.js';
import { fingerprint } from '../transcript.js';

const CHAT_INFO = { chatId: 'Seraphina - 1', chatLabel: 'Seraphina - 1', kind: 'character', owner: 'seraphina.png', ownerName: 'Seraphina', charName: 'Seraphina', userName: 'Ann' };

/** @param {number} n */
const makeChat = (n) => Array.from({ length: n }, (_, i) => ({ name: i % 2 ? 'Ann' : 'Seraphina', mes: `message ${i}`, is_user: i % 2 === 1 }));

const ANSWER = '{"entities":[{"name":"Kai","kind":"person"}],"relations":[]}';

function setup(overrides = {}) {
    const state = { chat: makeChat(20), active: /** @type {any} */ ({ ...CHAT_INFO }), segments: /** @type {any[]} */ ([]), settings: normalizeSettings({}) };
    const st = {
        activeChat: vi.fn(() => state.active),
        chat: vi.fn(() => state.chat),
        waitUntilIdle: vi.fn(async () => true),
        generate: vi.fn(async () => ANSWER),
        setPrompt: vi.fn(),
        clearPrompt: vi.fn(),
    };
    const api = {
        recall: vi.fn(async () => ({ memory: '• Kai (person)', entities: ['Kai'], engine: 'mcp', ms: 3 })),
        memory: vi.fn(async () => ({ meta: null, build: {}, segments: state.segments })),
        forget: vi.fn(async (_s, _c, ids) => {
            state.segments = state.segments.filter((s) => !ids.includes(s.id));
            return { removed: ids.length };
        }),
        entities: vi.fn(async () => ({ entities: [{ name: 'Seraphina', kind: 'character' }] })),
        addSegment: vi.fn(async (_scope, body) => {
            state.segments.push({ id: `s${body.from}`, from: body.from, to: body.to, fingerprint: body.fingerprint });
            return { segment: { id: `s${body.from}`, entities: body.entities.length, relations: body.relations.length } };
        }),
    };
    const notify = vi.fn();
    const controller = new MemoryController({ st: /** @type {any} */ (st), api: /** @type {any} */ (api), settings: () => state.settings, notify, ...overrides });
    return { state, st, api, notify, controller };
}

describe('scopeFor', () => {
    it('makes stable, server-safe ids per chat or per character', () => {
        const chat = scopeFor(/** @type {any} */ (CHAT_INFO), 'chat');
        const char = scopeFor(/** @type {any} */ (CHAT_INFO), 'character');
        expect(chat.id).toMatch(SCOPE_ID_RE);
        expect(char.id).toMatch(SCOPE_ID_RE);
        expect(chat.id.startsWith('chat-')).toBe(true);
        expect(char.id.startsWith('char-')).toBe(true);
        expect(scopeFor(/** @type {any} */ ({ ...CHAT_INFO, chatId: 'Seraphina - 2' }), 'character').id).toBe(char.id);
        expect(scopeFor(/** @type {any} */ ({ ...CHAT_INFO, chatId: 'Seraphina - 2' }), 'chat').id).not.toBe(chat.id);
        expect(scopeFor(/** @type {any} */ ({ ...CHAT_INFO, kind: 'group', owner: '123' }), 'character').id).toMatch(/^group-/);
        expect(chat.label).toBe('Seraphina: Seraphina - 1');
    });
});

describe('recall before a reply', () => {
    it('inserts the template with the recalled notes', async () => {
        const { controller, st, api, state } = setup();
        await controller.beforeGeneration(state.chat, 'normal');
        expect(api.recall).toHaveBeenCalledWith(expect.stringMatching(/^chat-/), { text: 'message 19\nmessage 18\nmessage 17', depth: 2, maxChars: 2000, debug: false }, 8000);
        expect(st.setPrompt).toHaveBeenCalledWith(expect.stringContaining('• Kai (person)'), state.settings.recall);
        expect(controller.lastRecall?.entities).toEqual(['Kai']);
    });

    it('skips quiet generations and disabled settings, but always clears the old note', async () => {
        const { controller, st, api, state } = setup();
        await controller.beforeGeneration(state.chat, 'quiet');
        state.settings = normalizeSettings({ recall: { enabled: false } });
        await controller.beforeGeneration(state.chat, 'normal');
        expect(api.recall).not.toHaveBeenCalled();
        expect(st.clearPrompt).toHaveBeenCalledTimes(2);
    });

    it('never blocks a reply when the server fails', async () => {
        const { controller, st, api, state } = setup();
        api.recall.mockRejectedValue(new Error('down'));
        await controller.beforeGeneration(state.chat, 'normal');
        expect(st.setPrompt).not.toHaveBeenCalled();
        expect(controller.lastRecall?.error).toBe('down');
    });
});

describe('remembering', () => {
    it('reads settled slices with the AI and sends their facts', async () => {
        const { controller, st, api, state } = setup();
        const totals = await controller.rememberPending({ manual: false });
        // 20 messages, 2 held back, 8 needed: slices [0,18) in pieces of 24 => one slice.
        expect(totals).toEqual({ segments: 1, entities: 1, relations: 0 });
        const body = api.addSegment.mock.calls[0][1];
        expect(body).toMatchObject({ chatId: 'Seraphina - 1', from: 0, to: 18, fingerprint: fingerprint(state.chat, 0, 18), scopeLabel: 'Seraphina: Seraphina - 1' });
        expect(body.transcript).toContain('[#17] Ann: message 17');
        expect(body.entities).toEqual([{ name: 'Kai', kind: 'person' }]);
        const prompt = st.generate.mock.calls[0][0];
        expect(prompt.user).toContain('Already remembered: Seraphina (character).');
        expect(prompt.profileId).toBe('');
    });

    it('re-reads slices whose messages were edited', async () => {
        const { controller, api, state } = setup();
        await controller.rememberPending({ manual: false });
        state.chat[3] = { ...state.chat[3], mes: 'edited' };
        await controller.rememberPending({ manual: false });
        expect(api.forget).toHaveBeenCalledWith(expect.any(String), 'Seraphina - 1', ['s0']);
        expect(api.addSegment).toHaveBeenCalledTimes(2);
    });

    it('manual runs take the newest messages too, in several slices', async () => {
        const { controller, api, state } = setup();
        state.settings = normalizeSettings({ extract: { maxSegment: 8 } });
        const totals = await controller.rememberPending({ manual: true });
        expect(totals.segments).toBe(3);
        expect(api.addSegment.mock.calls.map((c) => [c[1].from, c[1].to])).toEqual([[0, 8], [8, 16], [16, 20]]);
    });

    it('stops when the user switches chats', async () => {
        const { controller, api, state, st } = setup();
        state.settings = normalizeSettings({ extract: { maxSegment: 4 } });
        st.generate.mockImplementation(async () => {
            state.active = { ...CHAT_INFO, chatId: 'Other chat' };
            return ANSWER;
        });
        await controller.rememberPending({ manual: true });
        expect(api.addSegment).toHaveBeenCalledTimes(1);
        expect(api.addSegment.mock.calls[0][1].chatId).toBe('Seraphina - 1');
    });

    it('retries one bad answer, then pauses automatic remembering with a warning', async () => {
        const { controller, st, api, notify } = setup();
        st.generate.mockResolvedValueOnce('no json here').mockResolvedValueOnce(ANSWER);
        await controller.rememberPending({ manual: false });
        expect(api.addSegment).toHaveBeenCalledTimes(1);

        const bad = setup();
        bad.st.generate.mockResolvedValue('still not json');
        await bad.controller.rememberPending({ manual: false });
        expect(bad.api.addSegment).not.toHaveBeenCalled();
        expect(bad.controller.autoError).toMatch(/expected JSON/);
        expect(bad.notify).toHaveBeenCalledWith('warning', expect.stringMatching(/paused/));
        // Paused: automatic runs don't try again (and spend tokens) until the chat changes.
        await bad.controller.rememberPending({ manual: false });
        expect(bad.st.generate).toHaveBeenCalledTimes(2);
        bad.controller.chatChanged();
        expect(bad.controller.autoError).toBeNull();
        expect(notify).not.toHaveBeenCalled();
    });

    it('stores empty slices (only hidden messages) without asking the AI', async () => {
        const { controller, st, api, state } = setup();
        state.chat = state.chat.map((m) => ({ ...m, is_system: true }));
        await controller.rememberPending({ manual: true });
        expect(st.generate).not.toHaveBeenCalled();
        expect(api.addSegment.mock.calls[0][1]).toMatchObject({ transcript: '', entities: [], relations: [] });
    });

    it('uses the chosen connection profile', async () => {
        const { controller, st, state } = setup();
        state.settings = normalizeSettings({ extract: { profileId: 'cheap' } });
        await controller.rememberPending({ manual: false });
        expect(st.generate.mock.calls[0][0].profileId).toBe('cheap');
    });

    it('does nothing with no chat open or while already running', async () => {
        const { controller, api, state } = setup();
        state.active = null;
        expect((await controller.rememberPending({ manual: true })).segments).toBe(0);
        state.active = { ...CHAT_INFO };
        controller.extracting = true;
        expect((await controller.rememberPending({ manual: true })).segments).toBe(0);
        expect(api.memory).not.toHaveBeenCalled();
    });
});
