import { describe, expect, it } from 'vitest';
import { PROMPT_KEY, createController } from '../src/controller.js';
import { DEFAULT_PROMPT, DEFAULT_TAG_HELP, normalizeSettings } from '../src/settings.js';
import { buildPrompt, renderTemplate } from '../src/prompt.js';
import { fromIso, toIso } from '../src/time.js';

/**
 * @param {{ chat?: any[], metadata?: Record<string, unknown> | undefined, chatId?: string | undefined }} [options]
 */
function fakeContext({ chat = [], metadata = {}, chatId = 'chat-1' } = {}) {
    /** @type {Array<{ key: string, value: string, position: number, depth: number, role?: number }>} */
    const prompts = [];
    const context = {
        chat,
        chatMetadata: metadata,
        getCurrentChatId: () => chatId,
        saves: 0,
        async saveMetadata() { context.saves++; },
        async saveChat() { context.saves++; },
        /** @type {(key: string, value: string, position: number, depth: number, scan?: boolean, role?: number) => void} */
        setExtensionPrompt(key, value, position, depth, _scan, role) {
            prompts.push({ key, value, position, depth, role });
        },
        prompts,
    };
    return context;
}

/**
 * @param {ReturnType<typeof fakeContext>} context
 * @param {Record<string, unknown>} [settings]
 */
function setup(context, settings = {}) {
    const controller = createController({
        getContext: () => context,
        getSettings: () => normalizeSettings(settings),
        now: () => new Date(2026, 10, 25, 13, 7),
    });
    return controller;
}

/** @param {ReturnType<typeof fakeContext>} context */
function lastPrompt(context) {
    return context.prompts[context.prompts.length - 1];
}

/** @param {string} mes */
const ai = (mes) => ({ mes, is_user: false, extra: {} });
/** @param {string} mes */
const user = (mes) => ({ mes, is_user: true, extra: {} });

describe('starting a clock', () => {
    it('auto-starts a new chat at the real time, before the greeting', async () => {
        const context = fakeContext({ chat: [ai('Hello!')] });
        const controller = setup(context);
        expect(await controller.autoStart()).toBe(true);
        expect(context.chatMetadata.scenario_clock).toEqual({
            start: '2026-11-25T13:07', startIndex: -1, rates: [{ from: 0, minutes: 1 }],
        });
        expect(await controller.autoStart()).toBe(false);
    });

    it('uses the fixed start time when chosen', async () => {
        const context = fakeContext({ chat: [ai('Hello!')] });
        const controller = setup(context, { startMode: 'fixed', fixedStart: '1999-12-31T23:00', minutesPerMessage: 3 });
        await controller.autoStart();
        expect(context.chatMetadata.scenario_clock).toMatchObject({ start: '1999-12-31T23:00', rates: [{ from: 0, minutes: 3 }] });
    });

    it('auto-starts a new group chat with several greetings', async () => {
        const context = fakeContext({ chat: [ai('Hi from A'), ai('Hi from B')] });
        expect(await setup(context).autoStart()).toBe(true);
    });

    it("doesn't auto-start chats the user has written in, chats with no id, or when turned off", async () => {
        expect(await setup(fakeContext({ chat: [ai('a'), user('b')] })).autoStart()).toBe(false);
        expect(await setup(fakeContext({ chat: [], chatId: '' })).autoStart()).toBe(false);
        expect(await setup(fakeContext({ chat: [] }), { autoStart: false }).autoStart()).toBe(false);
        expect(await setup(fakeContext({ chat: [] }), { enabled: false }).autoStart()).toBe(false);
    });

    it('starts an existing chat as of its latest message', async () => {
        const context = fakeContext({ chat: [ai('[TIME: +5d]'), user('hi'), ai('[TIME: +5d]')] });
        const controller = setup(context);
        await controller.start(/** @type {number} */ (fromIso('2024-03-14T21:00')));
        expect(toIso(controller.state()?.timeline.current ?? 0)).toBe('2024-03-14T21:00');
        context.chat.push(user('[TIME: +1h] Later'));
        expect(toIso(controller.state()?.timeline.current ?? 0)).toBe('2024-03-14T22:00');
    });

    it('can be removed again', async () => {
        const context = fakeContext({ chat: [ai('a')] });
        const controller = setup(context);
        await controller.autoStart();
        await controller.stop();
        expect(context.chatMetadata).toEqual({});
        expect(controller.state()).toBeNull();
    });
});

describe('the prompt', () => {
    const clock = { start: '2024-03-14T21:00', startIndex: -1, rates: [{ from: 0, minutes: 1 }] };

    it('tells the AI the time after the latest message, with the tag instructions', () => {
        const context = fakeContext({ chat: [ai('Hi'), user('[TIME: +2h] Later')], metadata: { scenario_clock: clock } });
        setup(context).updatePrompt('normal');
        const prompt = lastPrompt(context);
        expect(prompt).toMatchObject({ key: PROMPT_KEY, position: 1, depth: 0, role: 0 });
        expect(prompt?.value).toContain('it is 11:00 PM on Thursday, 14 March 2024 (night), day 1 of the story');
        expect(prompt?.value).toContain('[TIME: +20m]');
    });

    it('leaves out the message being swiped away', () => {
        const context = fakeContext({ chat: [ai('Hi'), ai('[TIME: +8h] Morning')], metadata: { scenario_clock: clock } });
        setup(context).updatePrompt('swipe');
        expect(lastPrompt(context)?.value).toContain('it is 9:00 PM');
    });

    it('drops the tag instructions for quiet prompts (summaries and the like)', () => {
        const context = fakeContext({ chat: [ai('Hi')], metadata: { scenario_clock: clock } });
        setup(context).updatePrompt('quiet');
        expect(lastPrompt(context)?.value).toContain('Story clock');
        expect(lastPrompt(context)?.value).not.toContain('[TIME:');
    });

    it('drops them when the AI may not move the clock', () => {
        const context = fakeContext({ chat: [ai('Hi')], metadata: { scenario_clock: clock } });
        setup(context, { aiTags: false }).updatePrompt('normal');
        expect(lastPrompt(context)?.value).not.toContain('[TIME:');
    });

    it('is cleared when there is no clock or the extension is off', () => {
        const noClock = fakeContext({ chat: [ai('Hi')] });
        setup(noClock).updatePrompt();
        expect(lastPrompt(noClock)?.value).toBe('');

        const off = fakeContext({ chat: [ai('Hi')], metadata: { scenario_clock: clock } });
        setup(off, { enabled: false }).updatePrompt();
        expect(lastPrompt(off)?.value).toBe('');
    });

    it('follows the position, depth and role settings', () => {
        const context = fakeContext({ chat: [ai('Hi')], metadata: { scenario_clock: clock } });
        setup(context, { position: 'before', depth: 4, role: 'assistant' }).updatePrompt();
        expect(lastPrompt(context)).toMatchObject({ position: 2, depth: 4, role: 2 });
    });

    it('gives macro values that follow the generation type', () => {
        const context = fakeContext({ chat: [ai('Hi'), ai('[TIME: +1d]')], metadata: { scenario_clock: clock } });
        const controller = setup(context);
        expect(controller.currentMacroValues()?.scenario_day).toBe('2');
        controller.setGenerationType('swipe');
        expect(controller.currentMacroValues()?.scenario_day).toBe('1');
        expect(controller.currentMacroValues()?.scenario_iso).toBe('2024-03-14T21:00');
    });
});

describe('manual changes', () => {
    const clock = { start: '2024-03-14T21:00', startIndex: -1, rates: [{ from: 0, minutes: 0 }] };

    it('stores the change on the latest message and its swipe', async () => {
        const last = { ...ai('Night falls.'), swipe_id: 0, swipe_info: [{ extra: {} }] };
        const context = fakeContext({ chat: [ai('Hi'), last], metadata: { scenario_clock: clock } });
        const controller = setup(context);
        const change = await controller.adjust('+8h');
        expect(toIso(change.before)).toBe('2024-03-14T21:00');
        expect(toIso(change.after)).toBe('2024-03-15T05:00');
        expect(last.extra).toEqual({ scenario_clock: { ops: ['+8h'] } });
        expect(last.swipe_info[0]?.extra).toEqual({ scenario_clock: { ops: ['+8h'] } });
        expect(controller.pendingOps()).toEqual(['+8h']);
        expect(context.saves).toBe(1);
    });

    it('can be undone', async () => {
        const context = fakeContext({ chat: [ai('Hi'), ai('Ok')], metadata: { scenario_clock: clock } });
        const controller = setup(context);
        await controller.adjust('+1h');
        await controller.adjust('07:00');
        const change = await controller.undo();
        expect(toIso(change?.after ?? 0)).toBe('2024-03-14T22:00');
        await controller.undo();
        expect(context.chat[1]?.extra).toEqual({});
        expect(await controller.undo()).toBeNull();
    });

    it('moves the start itself when nothing comes after it', async () => {
        const context = fakeContext({ chat: [ai('Hi')], metadata: { scenario_clock: { ...clock, startIndex: 0 } } });
        const controller = setup(context);
        await controller.adjust('2024-12-25 08:00');
        expect(context.chatMetadata.scenario_clock).toMatchObject({ start: '2024-12-25T08:00', startIndex: 0 });
    });

    it('rejects nonsense and missing clocks with a readable error', async () => {
        const context = fakeContext({ chat: [ai('Hi')], metadata: { scenario_clock: clock } });
        await expect(setup(context).adjust('whenever')).rejects.toThrow("isn't a time change I understand");
        await expect(setup(fakeContext({ chat: [ai('Hi')] })).adjust('+1h')).rejects.toThrow('no clock');
    });
});

describe('housekeeping', () => {
    it('changes minutes-per-message for future messages only', async () => {
        const context = fakeContext({
            chat: [ai('a'), ai('b')],
            metadata: { scenario_clock: { start: '2024-03-14T21:00', startIndex: -1, rates: [{ from: 0, minutes: 1 }] } },
        });
        const controller = setup(context);
        await controller.setMinutesPerMessage(10);
        expect(controller.minutesPerMessage()).toBe(10);
        expect(toIso(controller.state()?.timeline.current ?? 0)).toBe('2024-03-14T21:01');
        context.chat.push(ai('c'));
        expect(toIso(controller.state()?.timeline.current ?? 0)).toBe('2024-03-14T21:11');
    });

    it('repairs the clock after messages before its start are deleted', async () => {
        const context = fakeContext({
            chat: [ai('a'), ai('b')],
            metadata: { scenario_clock: { start: '2024-03-14T21:00', startIndex: 5, rates: [{ from: 0, minutes: 1 }] } },
        });
        const controller = setup(context);
        expect(await controller.repair()).toBe(true);
        expect(context.chatMetadata.scenario_clock).toMatchObject({ startIndex: 1 });
        expect(await controller.repair()).toBe(false);
    });
});

describe('templates', () => {
    it('fills only scenario macros and leaves the rest to SillyTavern', () => {
        expect(renderTemplate('{{user}} at {{ Scenario_Time }} {{scenario_nope}}', { scenario_time: '9:00 AM' }))
            .toBe('{{user}} at 9:00 AM {{scenario_nope}}');
    });

    it('builds the default prompt', () => {
        const time = /** @type {number} */ (fromIso('2024-03-15T07:30'));
        const origin = /** @type {number} */ (fromIso('2024-03-14T21:00'));
        const text = buildPrompt({ time, origin, settings: normalizeSettings({ hour24: true }), withTagHelp: true });
        expect(text.split('\n')).toEqual([
            renderTemplate(DEFAULT_PROMPT, {
                scenario_time: '07:30', scenario_weekday: 'Friday', scenario_date: '15 March 2024',
                scenario_timeofday: 'early morning', scenario_day: '2',
            }),
            DEFAULT_TAG_HELP,
        ]);
    });

    it('repairs bad settings', () => {
        expect(normalizeSettings({ depth: '-3', tagDisplay: 'nope', fixedStart: 'x', minutesPerMessage: 99999 }))
            .toMatchObject({ depth: 0, tagDisplay: 'hide', fixedStart: '2025-06-01T09:00', minutesPerMessage: 1440 });
    });
});
