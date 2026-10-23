// @ts-check
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import html from '../settings.html?raw';
import { SettingsPanel } from '../settings-ui.js';
import { fakeBridge } from './fakes.js';

const CONFIG = {
    version: 1,
    enabled: true,
    contacts: [{ id: '+447700900123', label: 'Alice', enabled: true, characterAvatar: 'Seraphina.png', chatFile: 'Seraphina - WhatsApp' }],
    realistic: { preset: 'natural', injectNote: true, note: 'You are texting.', overrides: { readDelayMs: { min: 1000, max: 2000 } } },
    inbound: { quietMs: 6000, maxWaitMs: 45000, maxMessages: 10, mediaPlaceholders: true, neutraliseMacros: true },
    cleaner: { actions: 'remove', stripMarkdown: true, dropUnfinishedSentence: false, maxChars: 2000 },
    splitter: { maxBubbleChars: 300, minBubbleChars: 20, maxBubbles: 6 },
    dispatch: { leaseMs: 120000, maxAgeMs: 43200000 },
    sillytavern: { restorePreviousChat: true },
    whatsapp: { markOnlineOnConnect: false },
    background: { enabled: false, executablePath: '', url: '', idleReloadMs: 300000 },
};

/** @type {SettingsPanel} */
let panel;
/** @type {any} */
let api;
/** @type {HTMLElement} */
let container;

beforeEach(async () => {
    document.body.innerHTML = '<div id="extensions_settings2"></div>';
    container = /** @type {HTMLElement} */ (document.getElementById('extensions_settings2'));
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(html))));
    api = {
        qr: vi.fn(() => Promise.resolve({ qr: 'data:image/png;base64,AAAA' })),
        saveConfig: vi.fn((/** @type {any} */ config) => Promise.resolve(config)),
        saveLogin: vi.fn((/** @type {string} */ username) => Promise.resolve({ username, passwordSet: true })),
        restartBackground: vi.fn(() => Promise.resolve({})),
        connect: vi.fn(() => Promise.resolve({})),
        disconnect: vi.fn(() => Promise.resolve({})),
        logout: vi.fn(() => Promise.resolve({})),
    };
    panel = new SettingsPanel({ api, bridge: fakeBridge().bridge });
    await panel.mount(container);
    panel.showConfig(structuredClone(CONFIG));
    await flush();
});

/** Let pending promises (chat lists) settle. */
function flush() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

/** @param {string} selector */
function $(selector) {
    const found = container.querySelector(selector);
    if (!found) throw new Error(`missing ${selector}`);
    return /** @type {HTMLInputElement & HTMLSelectElement & HTMLTextAreaElement} */ (found);
}

/** @param {HTMLElement} element @param {string} value */
function type(element, value) {
    /** @type {HTMLInputElement} */ (element).value = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('SettingsPanel', () => {
    it('fills the form from the config', () => {
        expect($('[data-setting="preset"]').value).toBe('natural');
        expect($('[data-setting="note"]').value).toBe('You are texting.');
        expect($('[data-timing="readDelayMin"]').value).toBe('1');
        expect($('[data-setting="quietSeconds"]').value).toBe('6');
        const row = $('.whatschat-contact');
        expect(/** @type {HTMLInputElement} */ (row.querySelector('[data-field="id"]')).value).toBe('+447700900123');
        expect(/** @type {HTMLSelectElement} */ (row.querySelector('[data-field="characterAvatar"]')).value).toBe('Seraphina.png');
        const chats = /** @type {HTMLSelectElement} */ (row.querySelector('[data-field="chatFile"]'));
        expect(chats.value).toBe('Seraphina - WhatsApp');
        expect([...chats.options].map((o) => o.textContent)).toContain('New chat on the first message');
    });

    it('saves edits, keeping settings the panel does not show', async () => {
        $('[data-action="add-contact"]').click();
        await flush();
        const rows = container.querySelectorAll('.whatschat-contact');
        const row = /** @type {HTMLElement} */ (rows[1]);
        type(/** @type {HTMLElement} */ (row.querySelector('[data-field="id"]')), '+44 7700 900456');
        type(/** @type {HTMLElement} */ (row.querySelector('[data-field="characterAvatar"]')), 'Sensei.png');
        type($('[data-setting="preset"]'), 'busy');
        type($('[data-timing="typingCharsPerSec"]'), '6');
        $('[data-action="save"]').click();
        await flush();

        expect(api.saveConfig).toHaveBeenCalledOnce();
        const saved = api.saveConfig.mock.calls[0][0];
        expect(saved.contacts).toEqual([
            CONFIG.contacts[0],
            { id: '+44 7700 900456', label: '', enabled: true, characterAvatar: 'Sensei.png' },
        ]);
        expect(saved.realistic).toMatchObject({ preset: 'busy', overrides: { readDelayMs: { min: 1000, max: 2000 }, typingCharsPerSec: 6 } });
        expect(saved.cleaner).toEqual(CONFIG.cleaner);
    });

    it('shows plain-language errors instead of saving bad input', async () => {
        $('[data-action="add-contact"]').click();
        await flush();
        $('[data-action="save"]').click();
        await flush();
        expect(api.saveConfig).not.toHaveBeenCalled();
        expect($('[data-role="errors"]').textContent).toContain('enter a phone number');
    });

    it('does not overwrite edits in progress when the server config changes', () => {
        type($('[data-setting="note"]'), 'my edit');
        panel.showConfig({ ...structuredClone(CONFIG), realistic: { ...CONFIG.realistic, note: 'server change' } });
        expect($('[data-setting="note"]').value).toBe('my edit');
    });

    it('shows the QR code only while pairing', async () => {
        const status = (/** @type {any} */ transport) => ({ enabled: true, transportKind: 'whatsapp', transport, pendingBatches: 0, queuedTasks: 0 });
        await panel.showStatus(status({ state: 'pairing', pairingCode: 'code-1' }));
        expect($('[data-role="qr"]').hidden).toBe(false);
        expect(/** @type {HTMLImageElement} */ (/** @type {unknown} */ ($('[data-role="qr-image"]'))).src).toBe('data:image/png;base64,AAAA');

        await panel.showStatus(status({ state: 'pairing', pairingCode: 'code-1' }));
        expect(api.qr).toHaveBeenCalledOnce();

        await panel.showStatus(status({ state: 'connected', self: '+447700900999' }));
        expect($('[data-role="qr"]').hidden).toBe(true);
        expect($('[data-role="status-text"]').textContent).toBe('Connected as +447700900999');
        expect($('[data-role="status-dot"]').dataset['tone']).toBe('ok');
    });

    it('connects and disconnects from the toggle without needing Save', () => {
        const toggle = $('[data-role="enabled"]');
        toggle.checked = false;
        toggle.dispatchEvent(new Event('change', { bubbles: true }));
        expect(api.disconnect).toHaveBeenCalledOnce();
        toggle.checked = true;
        toggle.dispatchEvent(new Event('change', { bubbles: true }));
        expect(api.connect).toHaveBeenCalledOnce();
    });

    it('saves background settings with the rest of the form', async () => {
        $('[data-setting="backgroundEnabled"]').checked = true;
        type($('[data-setting="backgroundUrl"]'), ' http://127.0.0.1:8000/ ');
        $('[data-action="save"]').click();
        await flush();
        expect(api.saveConfig.mock.calls[0][0].background).toEqual({
            enabled: true,
            executablePath: '',
            url: 'http://127.0.0.1:8000/',
            idleReloadMs: 300000,
        });
    });

    it('shows background state in plain words', async () => {
        /** @returns {import('../api-client.js').BridgeStatus} */
        const status = (/** @type {any} */ background) => ({
            enabled: true,
            transportKind: 'whatsapp',
            transport: { state: 'connected' },
            pendingBatches: 0,
            queuedTasks: 0,
            background,
        });
        await panel.showStatus(status({ enabled: true, state: 'running' }));
        expect($('[data-role="background-text"]').textContent).toBe('Running: replies no longer need a tab open');
        expect($('[data-role="background-dot"]').dataset['tone']).toBe('ok');
        await panel.showStatus(status({ enabled: true, state: 'running', ai: { connected: true, api: 'openai' } }));
        expect($('[data-role="background-text"]').textContent).toBe(
            'Running and connected to the AI (Chat Completion): replies no longer need a tab open',
        );
        await panel.showStatus(status({ enabled: true, state: 'running', ai: { connected: false, api: 'textgenerationwebui' } }));
        expect($('[data-role="background-text"]').textContent).toContain('not connected to the AI (Text Completion)');
        expect($('[data-role="background-dot"]').dataset['tone']).toBe('error');
        expect($('[data-action="restart-background"]').hidden).toBe(true);
        await panel.showStatus(status({ enabled: true, state: 'error', error: 'Chromium is not installed.' }));
        expect($('[data-role="background-text"]').textContent).toContain('Chromium is not installed.');
        expect($('[data-role="background-dot"]').dataset['tone']).toBe('error');
        expect($('[data-action="restart-background"]').hidden).toBe(false);
        $('[data-action="restart-background"]').click();
        await flush();
        expect(api.restartBackground).toHaveBeenCalledOnce();
    });

    it('saves the login separately and never shows the saved password', async () => {
        panel.showLogin({ username: 'lewis', passwordSet: true });
        expect($('[data-role="login-username"]').value).toBe('lewis');
        expect($('[data-role="login-password"]').value).toBe('');
        expect($('[data-role="login-password"]').placeholder).toBe('Saved (type to change)');

        type($('[data-role="login-password"]'), 'new-secret');
        $('[data-action="save-login"]').click();
        await flush();
        expect(api.saveLogin).toHaveBeenCalledWith('lewis', 'new-secret');
        expect($('[data-role="login-password"]').value).toBe('');
        // Typing a login doesn't mark the settings form unsaved.
        expect($('[data-action="save"]').classList.contains('whatschat-unsaved')).toBe(false);
    });

    it('asks before logging out', async () => {
        vi.stubGlobal('confirm', vi.fn(() => false));
        $('[data-action="logout"]').click();
        await flush();
        expect(api.logout).not.toHaveBeenCalled();
        vi.stubGlobal('confirm', vi.fn(() => true));
        $('[data-action="logout"]').click();
        await flush();
        expect(api.logout).toHaveBeenCalledOnce();
    });
});
