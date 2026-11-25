// @ts-check
/** The Scenario Clock panel in SillyTavern's Extensions menu. */

import { DEFAULT_SETTINGS } from './settings.js';
import {
    dayNumber, formatDate, formatDuration, formatShort, formatTime, formatWeekday, fromIso, fromLocalDate, timeOfDay,
    toIso,
} from './time.js';

/**
 * @typedef {object} PanelDeps
 * @property {import('./controller.js').Controller} controller
 * @property {() => import('./settings.js').Settings} getSettings
 * @property {(patch: Partial<import('./settings.js').Settings>) => void} saveSettings
 * @property {() => void} onClockChanged Called after the panel changes the clock.
 * @property {(message: string, level?: 'info' | 'success' | 'warning' | 'error') => void} notify
 * @property {(message: string) => Promise<boolean>} confirm
 * @property {() => Date} [now]
 */

/**
 * Describes a clock change for a notice, e.g. "Moved forward 2 hours. It's now Thu 14 Mar, 9:42 PM."
 * @param {import('./controller.js').Change} change
 * @param {import('./time.js').FormatOptions} options
 */
export function describeChange({ before, after }, options) {
    const diff = after - before;
    const moved = diff === 0 ? 'No change.' : `Moved ${diff > 0 ? 'forward' : 'back'} ${formatDuration(diff)}.`;
    return `${moved} It's now ${formatShort(after, options)}.`;
}

export class ClockPanel {
    /** @param {PanelDeps} deps */
    constructor(deps) {
        this.deps = deps;
        /** @type {HTMLElement | null} */
        this.root = null;
        this.busy = false;
    }

    /**
     * @param {HTMLElement} container
     * @param {string} html The contents of settings.html.
     */
    mount(container, html) {
        const wrapper = container.ownerDocument.createElement('div');
        wrapper.innerHTML = html;
        const root = /** @type {HTMLElement} */ (wrapper.firstElementChild);
        container.append(root);
        this.root = root;
        this.bindEvents();
        this.refresh();
    }

    refresh() {
        if (!this.root) return;
        const { controller, getSettings } = this.deps;
        const settings = getSettings();
        const state = settings.enabled && controller.hasChat() ? controller.state() : null;

        const faceTime = this.el('[data-role="face-time"]');
        const faceDate = this.el('[data-role="face-date"]');
        const message = this.el('[data-role="message"]');
        if (state) {
            const now = state.timeline.current;
            faceTime.textContent = formatTime(now, settings);
            faceDate.textContent = `${formatWeekday(now)}, ${formatDate(now, settings)} · ${timeOfDay(now)} · day ${dayNumber(now, state.timeline.origin)}`;
            message.textContent = '';
        } else {
            faceTime.textContent = '--:--';
            faceDate.textContent = '';
            message.textContent = !settings.enabled
                ? 'Scenario Clock is turned off.'
                : controller.hasChat() ? "This chat doesn't have a clock yet." : 'Open a chat to see its clock.';
        }
        this.el('[data-role="face"]').classList.toggle('scenario-clock-face-off', !state);
        this.el('[data-role="running"]').hidden = !state;
        this.el('[data-role="stopped"]').hidden = Boolean(state) || !settings.enabled || !controller.hasChat();

        if (state) {
            const pending = controller.pendingOps();
            this.el('[data-role="pending"]').hidden = pending.length === 0;
            this.el('[data-role="pending-text"]').textContent = `Changed by hand after the latest message: ${pending.join(', ')}`;
            this.fill('[data-role="chat-rate"]', String(controller.minutesPerMessage()));
            this.fillDateTime('restart', state.timeline.current);
        } else if (!this.input('[data-role="start-date"]').value) {
            this.fillDateTime('start', controller.defaultStart());
        }

        for (const input of this.root.querySelectorAll('[data-setting]')) {
            const key = /** @type {keyof import('./settings.js').Settings} */ (input.getAttribute('data-setting'));
            const value = settings[key];
            if (input instanceof HTMLInputElement && input.type === 'checkbox') {
                input.checked = Boolean(value);
            } else {
                this.fill(input, String(value));
            }
        }
        const fixed = fromIso(settings.fixedStart);
        if (fixed !== null) this.fillDateTime('fixed', fixed);
        this.el('[data-role="fixed-start"]').hidden = settings.startMode !== 'fixed';
        this.el('[data-role="depth-box"]').hidden = settings.position !== 'chat';
        this.el('[data-role="role-box"]').hidden = settings.position !== 'chat';
    }

    bindEvents() {
        const root = /** @type {HTMLElement} */ (this.root);
        const { controller, saveSettings } = this.deps;

        root.addEventListener('click', (event) => {
            const target = /** @type {Element | null} */ (event.target);
            const button = target?.closest('[data-change], [data-action], [data-reset]');
            if (!button) return;
            const change = button.getAttribute('data-change');
            const action = button.getAttribute('data-action');
            const reset = /** @type {'promptTemplate' | 'tagTemplate' | null} */ (button.getAttribute('data-reset'));
            if (change) void this.adjust(change);
            if (action) void this.runAction(action);
            if (reset) saveSettings({ [reset]: DEFAULT_SETTINGS[reset] });
        });

        this.input('[data-role="change"]').addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                void this.runAction('apply');
            }
        });

        this.input('[data-role="chat-rate"]').addEventListener('change', (event) => {
            const value = Number(/** @type {HTMLInputElement} */ (event.target).value);
            if (!Number.isFinite(value) || value < 0) return;
            void this.guard(async () => {
                await controller.setMinutesPerMessage(Math.min(1440, value));
                this.deps.onClockChanged();
            });
        });

        for (const input of root.querySelectorAll('[data-setting]')) {
            const key = input.getAttribute('data-setting') ?? '';
            const eventName = input instanceof HTMLTextAreaElement || (input instanceof HTMLInputElement && input.type === 'text')
                ? 'input' : 'change';
            input.addEventListener(eventName, () => {
                const value = input instanceof HTMLInputElement && input.type === 'checkbox'
                    ? input.checked
                    : input instanceof HTMLInputElement && input.type === 'number'
                        ? Number(input.value)
                        : /** @type {HTMLInputElement} */ (input).value;
                saveSettings({ [key]: value });
            });
        }

        for (const part of ['date', 'time']) {
            this.input(`[data-role="fixed-${part}"]`).addEventListener('change', () => {
                const time = this.readDateTime('fixed');
                if (time !== null) saveSettings({ fixedStart: toIso(time) });
            });
        }
    }

    /** @param {string} action */
    async runAction(action) {
        const { controller, notify, confirm, now = () => new Date() } = this.deps;
        switch (action) {
            case 'apply': {
                const box = this.input('[data-role="change"]');
                if (!box.value.trim()) return;
                if (await this.adjust(box.value)) box.value = '';
                return;
            }
            case 'undo':
                await this.guard(async () => {
                    const change = await controller.undo();
                    if (change) notify(`Undone. ${describeChange(change, this.deps.getSettings())}`, 'info');
                });
                return;
            case 'use-now':
                this.fillDateTime('start', fromLocalDate(now()), true);
                return;
            case 'start':
            case 'restart': {
                const time = this.readDateTime(action);
                if (time === null) {
                    notify('Pick a date and a time first.', 'warning');
                    return;
                }
                await this.guard(async () => {
                    await controller.start(time);
                    notify(`Clock set to ${formatShort(time, this.deps.getSettings())}.`, 'success');
                });
                return;
            }
            case 'stop':
                if (!(await confirm("Remove this chat's clock? The AI will no longer be told the time here."))) return;
                await this.guard(() => controller.stop());
                return;
        }
    }

    /**
     * @param {string} text
     * @returns {Promise<boolean>} Whether it worked.
     */
    async adjust(text) {
        let ok = false;
        await this.guard(async () => {
            const change = await this.deps.controller.adjust(text);
            this.deps.notify(describeChange(change, this.deps.getSettings()), 'success');
            ok = true;
        });
        return ok;
    }

    /**
     * Runs one clock change at a time, and reports errors as notices.
     * @param {() => Promise<unknown>} work
     */
    async guard(work) {
        if (this.busy) return;
        this.busy = true;
        try {
            await work();
        } catch (error) {
            this.deps.notify(error instanceof Error ? error.message : String(error), 'error');
        } finally {
            this.busy = false;
            this.deps.onClockChanged();
        }
    }

    /**
     * @param {string} prefix "start", "restart" or "fixed"
     * @returns {number | null}
     */
    readDateTime(prefix) {
        const date = this.input(`[data-role="${prefix}-date"]`).value;
        const time = this.input(`[data-role="${prefix}-time"]`).value || '00:00';
        return date ? fromIso(`${date}T${time.slice(0, 5)}`) : null;
    }

    /**
     * @param {string} prefix
     * @param {number} time
     * @param {boolean} [force] Overwrite even if the user is editing it.
     */
    fillDateTime(prefix, time, force = false) {
        const [date, clock] = toIso(time).split('T');
        this.fill(`[data-role="${prefix}-date"]`, date ?? '', force);
        this.fill(`[data-role="${prefix}-time"]`, clock ?? '', force);
    }

    /**
     * Sets an input's value unless the user is typing in it.
     * @param {string | Element} target
     * @param {string} value
     * @param {boolean} [force]
     */
    fill(target, value, force = false) {
        const input = /** @type {HTMLInputElement} */ (typeof target === 'string' ? this.el(target) : target);
        if (!force && input.ownerDocument.activeElement === input) return;
        if (input.value !== value) input.value = value;
    }

    /** @param {string} selector */
    el(selector) {
        const found = this.root?.querySelector(selector);
        if (!(found instanceof HTMLElement)) throw new Error(`Scenario Clock: missing ${selector}`);
        return found;
    }

    /** @param {string} selector */
    input(selector) {
        return /** @type {HTMLInputElement} */ (this.el(selector));
    }
}
