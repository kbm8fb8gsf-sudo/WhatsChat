// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeSettings } from '../settings-model.js';
import { mountSettings } from '../settings-ui.js';

// jsdom gives import.meta.url an http: scheme, so resolve from the package root instead.
const HTML = readFileSync(path.resolve('extension/settings.html'), 'utf8');

function setup() {
    document.body.innerHTML = HTML;
    const root = /** @type {HTMLElement} */ (document.body.firstElementChild);
    let raw = /** @type {any} */ ({});
    const settings = () => normalizeSettings(raw);
    const update = (/** @type {(r: any) => void} */ mutate) => {
        const copy = structuredClone(raw);
        mutate(copy);
        raw = normalizeSettings(copy);
    };
    const scope = { id: 'chat-0123456789abcdef', label: 'Seraphina: chat', chat: { chatId: 'chat' } };
    const controller = /** @type {any} */ ({
        currentScope: vi.fn(() => scope),
        extracting: false,
        progress: null,
        lastRecall: null,
        autoError: null,
        rememberPending: vi.fn(async () => ({ segments: 2, entities: 5, relations: 3 })),
        preview: vi.fn(async () => ({ memory: '• Kai', entities: ['Kai'], engine: 'mcp', ms: 2 })),
        stop: vi.fn(),
    });
    const api = /** @type {any} */ ({
        status: vi.fn(async () => ({ version: '0.1.0', graphify: { ok: true, graphifyVersion: '0.9.108', mcp: true } })),
        refreshStatus: vi.fn(async () => ({ version: '0.1.0', graphify: { ok: false, error: 'graphify was not found.', tried: [{ python: 'python3', error: 'No module named graphify' }] } })),
        memory: vi.fn(async () => ({ meta: { label: 'x' }, build: { state: 'idle', builtAt: new Date().toISOString(), nodes: 5, edges: 3, communities: 2, html: true, error: null }, segments: [{ from: 0, to: 8 }] })),
        forget: vi.fn(async () => ({ removed: 1 })),
        remove: vi.fn(async () => ({ ok: true })),
        rebuild: vi.fn(async () => ({ build: { nodes: 5, edges: 3, error: null } })),
        graphUrl: vi.fn(() => '/graph.html'),
    });
    const st = /** @type {any} */ ({
        profiles: vi.fn(() => [{ id: 'p1', name: 'Cheap model' }]),
        chat: vi.fn(() => new Array(10).fill({ mes: 'x' })),
        confirm: vi.fn(async () => true),
    });
    const notify = vi.fn();
    const ui = mountSettings({ root, controller, api, st, settings, update, notify });
    /** @param {string} name */
    const q = (name) => /** @type {HTMLElement} */ (root.querySelector(`[data-gm="${name}"]`));
    /** @param {string} path */
    const input = (path) => /** @type {HTMLInputElement} */ (root.querySelector(`[data-setting="${path}"]`));
    return { root, ui, controller, api, st, notify, settings, q, input };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('settings panel', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    it('shows current settings and saves clamped changes', async () => {
        const { input, settings } = setup();
        expect(input('recall.maxChars').value).toBe('2000');
        expect(input('enabled').checked).toBe(true);
        input('recall.maxChars').value = '50';
        input('recall.maxChars').dispatchEvent(new Event('change'));
        expect(settings().recall.maxChars).toBe(200);
        expect(input('recall.maxChars').value).toBe('200');
        input('extract.auto').checked = false;
        input('extract.auto').dispatchEvent(new Event('change'));
        expect(settings().extract.auto).toBe(false);
    });

    it('lists connection profiles', () => {
        const { q } = setup();
        const options = [.../** @type {HTMLSelectElement} */ (q('profiles')).options].map((o) => [o.value, o.text]);
        expect(options).toEqual([['', 'The current connection'], ['p1', 'Cheap model']]);
    });

    it('shows graphify and memory status', async () => {
        const { q } = setup();
        await flush();
        expect(q('graphify-status').textContent).toBe('graphify 0.9.108 is connected through its MCP server.');
        expect(q('memory-status').textContent).toContain('5 things remembered, 3 connections, 2 groups.');
        expect(q('memory-status').textContent).toContain('messages #0–#7 of 10 remembered');
    });

    it('explains what was tried when graphify is missing', async () => {
        const { q } = setup();
        q('check').click();
        await flush();
        await flush();
        expect(q('graphify-status').textContent).toContain('graphify was not found.');
        expect(q('graphify-status').textContent).toContain('python3: No module named graphify');
    });

    it('runs the buttons', async () => {
        const { q, controller, api, notify } = setup();
        q('remember').click();
        await flush();
        expect(controller.rememberPending).toHaveBeenCalledWith({ manual: true });
        expect(notify).toHaveBeenCalledWith('success', expect.stringContaining('5 things and 3 connections'));

        q('preview').click();
        await flush();
        expect(q('preview-out').textContent).toContain('• Kai');
        expect(q('preview-out').textContent).toContain('[Long-term memory');

        q('forget-chat').click();
        await flush();
        await flush();
        expect(api.forget).toHaveBeenCalledWith('chat-0123456789abcdef', 'chat', null);
    });

    it('does not forget without confirmation', async () => {
        const { q, api, st } = setup();
        st.confirm.mockResolvedValue(false);
        q('delete').click();
        await flush();
        await flush();
        expect(api.remove).not.toHaveBeenCalled();
    });

    it('shows the last recall', () => {
        const { ui, controller, q } = setup();
        controller.lastRecall = { memory: '• Kai', entities: ['Kai'], engine: 'mcp', ms: 4, at: '' };
        ui.changed();
        expect(q('last-recall').textContent).toBe('1 things recalled in 4 ms via mcp:\n\n• Kai');
    });
});
