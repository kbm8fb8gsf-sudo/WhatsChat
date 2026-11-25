// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createController } from '../src/controller.js';
import { ClockPanel, describeChange } from '../src/panel.js';
import { normalizeSettings } from '../src/settings.js';
import { fromIso } from '../src/time.js';
import HTML from '../settings.html?raw';

function setup({ withClock = true } = {}) {
    let settings = normalizeSettings({});
    const context = {
        chat: [{ mes: 'Hello', is_user: false, extra: {} }],
        /** @type {Record<string, unknown>} */
        chatMetadata: withClock
            ? { scenario_clock: { start: '2024-03-14T21:00', startIndex: -1, rates: [{ from: 0, minutes: 1 }] } }
            : {},
        getCurrentChatId: () => 'chat',
        saveMetadata: vi.fn(async () => {}),
        saveChat: vi.fn(async () => {}),
        setExtensionPrompt: vi.fn(),
    };
    const now = () => new Date(2026, 0, 2, 3, 4);
    const controller = createController({ getContext: () => context, getSettings: () => settings, now });
    const notify = vi.fn();
    const panel = new ClockPanel({
        controller,
        getSettings: () => settings,
        saveSettings: (patch) => {
            settings = normalizeSettings({ ...settings, ...patch });
            panel.refresh();
        },
        onClockChanged: () => panel.refresh(),
        notify,
        confirm: async () => true,
        now,
    });
    panel.mount(document.body, HTML);
    const $ = (/** @type {string} */ selector) => /** @type {HTMLInputElement} */ (document.querySelector(selector));
    return { panel, context, notify, $, getSettings: () => settings };
}

/** Lets the panel's async click handlers finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('ClockPanel', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    it('shows the clock of the open chat', () => {
        const { $ } = setup();
        expect($('[data-role="face-time"]').textContent).toBe('9:00 PM');
        expect($('[data-role="face-date"]').textContent).toBe('Thursday, 14 March 2024 · night · day 1');
        expect($('[data-role="running"]').hidden).toBe(false);
        expect($('[data-role="stopped"]').hidden).toBe(true);
    });

    it('moves the clock with the quick buttons and the box', async () => {
        const { $, context, notify } = setup();
        $('[data-change="+1h"]').click();
        await settle();
        expect($('[data-role="face-time"]').textContent).toBe('10:00 PM');
        expect(notify).toHaveBeenLastCalledWith("Moved forward 1 hour. It's now Thu 14 Mar, 10:00 PM.", 'success');

        $('[data-role="change"]').value = 'tomorrow 7am';
        $('[data-action="apply"]').click();
        await settle();
        expect($('[data-role="face-time"]').textContent).toBe('7:00 AM');
        expect($('[data-role="change"]').value).toBe('');
        expect(context.chat[0]?.extra).toEqual({ scenario_clock: { ops: ['+1h', 'tomorrow 7am'] } });
        expect($('[data-role="pending"]').hidden).toBe(false);
    });

    it('reports bad input instead of throwing', async () => {
        const { $, notify } = setup();
        $('[data-role="change"]').value = 'eventually';
        $('[data-action="apply"]').click();
        await settle();
        expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("isn't a time change"), 'error');
        expect($('[data-role="change"]').value).toBe('eventually');
    });

    it('starts a clock in a chat without one', async () => {
        const { $, context } = setup({ withClock: false });
        expect($('[data-role="stopped"]').hidden).toBe(false);
        $('[data-action="use-now"]').click();
        expect($('[data-role="start-date"]').value).toBe('2026-01-02');
        $('[data-role="start-date"]').value = '1889-10-04';
        $('[data-role="start-time"]').value = '18:30';
        $('[data-action="start"]').click();
        await settle();
        expect(context.chatMetadata['scenario_clock']).toMatchObject({ start: '1889-10-04T18:30', startIndex: 0 });
        expect($('[data-role="face-time"]').textContent).toBe('6:30 PM');
    });

    it('saves settings as they change', () => {
        const { $, getSettings } = setup();
        const hour24 = $('[data-setting="hour24"]');
        hour24.checked = true;
        hour24.dispatchEvent(new Event('change'));
        expect(getSettings().hour24).toBe(true);
        expect($('[data-role="face-time"]').textContent).toBe('21:00');

        const position = /** @type {HTMLSelectElement} */ (/** @type {unknown} */ ($('[data-setting="position"]')));
        position.value = 'before';
        position.dispatchEvent(new Event('change'));
        expect(getSettings().position).toBe('before');
        expect($('[data-role="depth-box"]').hidden).toBe(true);

        const template = /** @type {HTMLTextAreaElement} */ (/** @type {unknown} */ ($('[data-setting="promptTemplate"]')));
        template.value = 'It is {{scenario_time}}.';
        template.dispatchEvent(new Event('input'));
        expect(getSettings().promptTemplate).toBe('It is {{scenario_time}}.');
        $('[data-reset="promptTemplate"]').click();
        expect(getSettings().promptTemplate).toContain('Story clock');
    });

    it('describes changes in both directions', () => {
        const before = /** @type {number} */ (fromIso('2024-03-14T21:00'));
        const options = { hour24: false, dateOrder: /** @type {const} */ ('dmy') };
        expect(describeChange({ before, after: before - 30 * 60_000 }, options)).toBe("Moved back 30 minutes. It's now Thu 14 Mar, 8:30 PM.");
        expect(describeChange({ before, after: before }, options)).toBe("No change. It's now Thu 14 Mar, 9:00 PM.");
    });
});
