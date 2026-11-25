// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from 'vitest';
import HTML from '../settings.html?raw';

/**
 * A stand-in for the bits of SillyTavern's getContext() that index.js uses.
 */
function fakeSillyTavern() {
    /** @type {Record<string, Array<(...args: any[]) => unknown>>} */
    const listeners = {};
    /** @type {Record<string, any>} */
    const commands = {};
    /** @type {Record<string, () => string>} */
    const macros = {};
    /** @type {Record<string, { value: string, position: number, depth: number, role?: number }>} */
    const prompts = {};
    const context = {
        chat: /** @type {any[]} */ ([]),
        /** @type {Record<string, unknown>} */
        chatMetadata: {},
        chatId: /** @type {string | undefined} */ (undefined),
        getCurrentChatId: () => context.chatId,
        eventSource: {
            on: (/** @type {string} */ name, /** @type {(...args: any[]) => unknown} */ listener) => {
                (listeners[name] ??= []).push(listener);
            },
        },
        eventTypes: {
            CHAT_CHANGED: 'chat_id_changed',
            MESSAGE_RECEIVED: 'message_received',
            MESSAGE_SENT: 'message_sent',
            MESSAGE_DELETED: 'message_deleted',
        },
        /** @type {Record<string, unknown>} */
        extensionSettings: {},
        powerUserSettings: { experimental_macro_engine: true },
        saveSettingsDebounced: vi.fn(),
        saveMetadata: vi.fn(async () => {}),
        saveChat: vi.fn(async () => {}),
        setExtensionPrompt: (/** @type {string} */ key, /** @type {string} */ value, /** @type {number} */ position, /** @type {number} */ depth, /** @type {boolean} */ _scan, /** @type {number} */ role) => {
            prompts[key] = { value, position, depth, role };
        },
        callGenericPopup: vi.fn(async () => '+30m'),
        POPUP_TYPE: { TEXT: 1, CONFIRM: 2, INPUT: 3 },
        POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null },
        registerMacro: vi.fn(),
        macros: {
            register: (/** @type {string} */ name, /** @type {{ handler: () => string }} */ options) => {
                macros[name] = options.handler;
            },
            category: { TIME: 'time' },
        },
        SlashCommandParser: { addCommandObject: (/** @type {any} */ command) => { commands[command.name] = command; } },
        SlashCommand: { fromProps: (/** @type {any} */ props) => props },
        SlashCommandArgument: { fromProps: (/** @type {any} */ props) => props },
        SlashCommandNamedArgument: { fromProps: (/** @type {any} */ props) => props },
        ARGUMENT_TYPE: { STRING: 'string', BOOLEAN: 'bool' },
    };
    /** @param {string} name @param {...any} args */
    async function emit(name, ...args) {
        for (const listener of listeners[name] ?? []) await listener(...args);
    }
    return { context, commands, macros, prompts, emit };
}

const st = fakeSillyTavern();

beforeAll(async () => {
    document.body.innerHTML = '<div id="extensions_settings2"></div><div id="extensionsMenu"></div><div id="chat"></div>';
    vi.stubGlobal('SillyTavern', { getContext: () => st.context });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(HTML)));
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 10, 25, 13, 7) });
    const module = await import('../index.js');
    await module.onActivate();
});

/** Opens a chat the way SillyTavern does: messages, then CHAT_CHANGED. */
async function openChat(/** @type {any[]} */ chat, /** @type {Record<string, unknown>} */ metadata = {}) {
    st.context.chat = chat;
    st.context.chatMetadata = metadata;
    st.context.chatId = `chat-${Math.random()}`;
    document.getElementById('chat')?.replaceChildren();
    await st.emit('chat_id_changed');
}

describe('Scenario Clock in SillyTavern', () => {
    it('adds its panel, wand button, slash commands and macros', () => {
        expect(document.querySelector('.scenario-clock-settings')).not.toBeNull();
        expect(document.getElementById('scenario_clock_wand')?.textContent).toBe('Scenario Clock');
        expect(Object.keys(st.commands).sort()).toEqual(['clock', 'clock-start', 'clock-stop', 'clock-undo']);
        expect(Object.keys(st.macros)).toContain('scenario_datetime');
        expect(st.context.extensionSettings['scenario_clock']).toMatchObject({ enabled: true });
    });

    it('starts a clock in a new chat and tells the AI', async () => {
        await openChat([{ mes: 'Hello!', is_user: false, extra: {} }]);
        expect(st.context.chatMetadata['scenario_clock']).toMatchObject({ start: '2026-11-25T13:07', startIndex: -1 });
        expect(st.prompts['scenario_clock']?.value).toContain('it is 1:07 PM on Wednesday, 25 November 2026 (afternoon), day 1');
        expect(st.macros['scenario_time']?.()).toBe('1:07 PM');
        expect(document.getElementById('scenario_clock_wand')?.textContent).toBe('Clock: Wed 25 Nov, 1:07 PM');
    });

    it('moves with tags in replies, and a swipe leaves out the reply it replaces', async () => {
        st.context.chat.push({ mes: 'Want to get dinner?', is_user: true, extra: {} });
        st.context.chat.push({ mes: '[TIME: 19:30] At the restaurant...', is_user: false, extra: {} });
        await st.emit('message_received', 2, 'normal');
        expect(st.prompts['scenario_clock']?.value).toContain('it is 7:30 PM');

        await globalThis.scenarioClockInterceptor([], 8000, () => {}, 'swipe');
        expect(st.prompts['scenario_clock']?.value).toContain('it is 1:08 PM');
        expect(st.macros['scenario_time']?.()).toBe('1:08 PM');

        await st.emit('message_received', 2, 'swipe');
        expect(st.prompts['scenario_clock']?.value).toContain('it is 7:30 PM');
    });

    it('keeps the tag instructions out of quiet prompts', async () => {
        await globalThis.scenarioClockInterceptor([], 8000, () => {}, 'quiet');
        expect(st.prompts['scenario_clock']?.value).not.toContain('[TIME:');
        await globalThis.scenarioClockInterceptor([], 8000, () => {}, 'normal');
        expect(st.prompts['scenario_clock']?.value).toContain('[TIME: +20m]');
    });

    it('handles /clock commands', async () => {
        expect(await st.commands['clock']?.callback({}, '')).toBe('Wednesday, 25 November 2026, 7:30 PM');
        expect(await st.commands['clock']?.callback({ quiet: 'true', format: 'time' }, '+1h')).toBe('8:30 PM');
        expect(await st.commands['clock-undo']?.callback({}, '')).toBe('2026-11-25T19:30');
        await expect(st.commands['clock-start']?.callback({}, 'next week')).rejects.toThrow('Use a date like');
        expect(await st.commands['clock-start']?.callback({}, '1889-10-04 18:00')).toBe('1889-10-04T18:00');
        expect(st.macros['scenario_weekday']?.()).toBe('Friday');
        await st.commands['clock-stop']?.callback({}, '');
        expect(st.prompts['scenario_clock']?.value).toBe('');
        expect(st.macros['scenario_time']?.()).toBe('');
    });

    it('changes the clock from the wand menu', async () => {
        await openChat([{ mes: 'Hi', is_user: false, extra: {} }]);
        document.getElementById('scenario_clock_wand')?.click();
        await vi.waitFor(() => expect(st.context.chat[0].extra).toEqual({ scenario_clock: { ops: ['+30m'] } }));
        expect(st.macros['scenario_time']?.()).toBe('1:37 PM');
    });

    it('leaves existing chats alone until asked', async () => {
        await openChat([
            { mes: 'a', is_user: false, extra: {} },
            { mes: 'b', is_user: true, extra: {} },
        ]);
        expect(st.context.chatMetadata).toEqual({});
        expect(st.prompts['scenario_clock']?.value).toBe('');
        expect(document.querySelector('[data-role="stopped"]')?.hasAttribute('hidden')).toBe(false);
    });
});
