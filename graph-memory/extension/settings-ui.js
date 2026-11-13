// @ts-check
/**
 * The Graph Memory drawer in SillyTavern's Extensions panel.
 */
import { coveredUpTo } from './transcript.js';

/**
 * @typedef {import('./settings-model.js').Settings} Settings
 * @typedef {import('./controller.js').MemoryController} MemoryController
 * @typedef {import('./api.js').Api} Api
 * @typedef {import('./st.js').St} St
 */

/**
 * @param {any} obj
 * @param {string} path
 */
function getPath(obj, path) {
    return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/**
 * @param {any} obj
 * @param {string} path
 * @param {unknown} value
 */
function setPath(obj, path, value) {
    const keys = path.split('.');
    const last = /** @type {string} */ (keys.pop());
    let o = obj;
    for (const k of keys) {
        if (!o[k] || typeof o[k] !== 'object') o[k] = {};
        o = o[k];
    }
    o[last] = value;
}

/**
 * @param {string | null} iso
 */
function ago(iso) {
    if (!iso) return 'never';
    const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return new Date(iso).toLocaleDateString();
}

/**
 * @param {{
 *   root: HTMLElement,
 *   controller: MemoryController,
 *   api: Api,
 *   st: St,
 *   settings: () => Settings,
 *   update: (mutate: (raw: any) => void) => void,
 *   notify: (level: 'info' | 'warning' | 'error' | 'success', msg: string) => void,
 * }} deps
 */
export function mountSettings(deps) {
    const { root, controller, api, st } = deps;
    /** @param {string} name */
    const el = (name) => /** @type {HTMLElement} */ (root.querySelector(`[data-gm="${name}"]`));

    // ----- bind inputs to settings -----
    /** @type {NodeListOf<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>} */
    const inputs = root.querySelectorAll('[data-setting]');
    const fill = () => {
        const s = deps.settings();
        for (const input of inputs) {
            const value = getPath(s, /** @type {string} */ (input.dataset.setting));
            if (input instanceof HTMLInputElement && input.type === 'checkbox') input.checked = Boolean(value);
            else input.value = value == null ? '' : String(value);
        }
        el('stop').hidden = !controller.extracting;
    };
    for (const input of inputs) {
        input.addEventListener('change', () => {
            const path = /** @type {string} */ (input.dataset.setting);
            /** @type {unknown} */
            let value = input.value;
            if (input instanceof HTMLInputElement && input.type === 'checkbox') value = input.checked;
            else if (input instanceof HTMLInputElement && input.type === 'number') value = Number(input.value);
            deps.update((raw) => setPath(raw, path, value));
            fill(); // show the clamped value
            if (path === 'scope' || path === 'enabled') void refreshMemory();
        });
    }

    // ----- connection profiles -----
    const fillProfiles = () => {
        const select = /** @type {HTMLSelectElement} */ (el('profiles'));
        const chosen = deps.settings().extract.profileId;
        const profiles = st.profiles();
        select.replaceChildren(new Option('The current connection', ''));
        for (const p of profiles) select.add(new Option(p.name, p.id));
        if (chosen && !profiles.some((p) => p.id === chosen)) select.add(new Option('(missing profile)', chosen));
        select.value = chosen;
    };

    // ----- graphify status -----
    /** @param {{ version: string, graphify: import('./api.js').GraphifyStatus } | null} status @param {string} [error] */
    const showGraphify = (status, error) => {
        const box = el('graphify-status');
        box.classList.remove('gm-good', 'gm-bad');
        if (error || !status) {
            box.textContent = error ?? 'Unknown';
            box.classList.add('gm-bad');
            return;
        }
        const g = status.graphify;
        if (g.ok) {
            box.textContent = `graphify ${g.graphifyVersion} is connected${g.mcp ? ' through its MCP server' : ' (command line; install graphifyy[mcp] for faster recall)'}.`;
            box.classList.add('gm-good');
        } else {
            const tried = (g.tried ?? []).slice(0, 4).map((t) => `  ${t.python}: ${t.error}`).join('\n');
            box.textContent = `${g.error ?? 'graphify was not found.'}${tried ? `\nTried:\n${tried}` : ''}`;
            box.classList.add('gm-bad');
        }
    };

    const refreshGraphify = async (refresh = false) => {
        try {
            showGraphify(refresh ? await api.refreshStatus() : await api.status());
        } catch (err) {
            showGraphify(null, err instanceof Error ? err.message : String(err));
        }
    };

    // ----- memory status -----
    let refreshing = 0;
    const refreshMemory = async () => {
        const ticket = ++refreshing;
        const box = el('memory-status');
        const scope = controller.currentScope();
        if (!scope) {
            box.textContent = 'No chat open.';
            return;
        }
        if (!deps.settings().enabled) {
            box.textContent = 'Graph Memory is turned off.';
            return;
        }
        try {
            const info = await api.memory(scope.id, scope.chat.chatId);
            if (ticket !== refreshing) return;
            const chatLength = st.chat().length;
            const covered = Math.min(chatLength, coveredUpTo(info.segments ?? []));
            const b = info.build;
            const lines = [
                `${scope.label}`,
                b.nodes || b.edges
                    ? `${b.nodes} things remembered, ${b.edges} connections, ${b.communities} groups. Updated ${ago(b.builtAt)}.`
                    : 'Nothing remembered yet.',
                chatLength ? `This chat: messages #0–#${Math.max(0, covered - 1)} of ${chatLength} remembered${covered === 0 ? ' (none yet)' : ''}.` : 'This chat is empty.',
            ];
            if (b.state !== 'idle') lines.push('graphify is updating the graph…');
            if (b.error) lines.push(`Last build failed: ${b.error}`);
            if (controller.autoError) lines.push(`Remembering is paused for this chat: ${controller.autoError}`);
            box.textContent = lines.join('\n');
            box.classList.toggle('gm-bad', Boolean(b.error || controller.autoError));
            /** @type {HTMLButtonElement} */ (el('graph')).disabled = !b.html;
        } catch (err) {
            if (ticket !== refreshing) return;
            box.textContent = err instanceof Error ? err.message : String(err);
            box.classList.add('gm-bad');
        }
    };

    const showProgress = () => {
        const box = el('progress');
        const p = controller.progress;
        box.hidden = !p;
        if (p) box.textContent = `Remembering… ${p.done}${p.total ? ` of about ${p.total}` : ''} part(s) done.`;
        el('stop').hidden = !controller.extracting;
        /** @type {HTMLButtonElement} */ (el('remember')).disabled = controller.extracting;
    };

    const showLastRecall = () => {
        const r = controller.lastRecall;
        const box = el('last-recall');
        if (!r) {
            box.textContent = 'Nothing recalled yet.';
            return;
        }
        if (r.error) box.textContent = `Recall failed: ${r.error}`;
        else if (!r.memory) box.textContent = `Nothing relevant found (${r.ms} ms).`;
        else box.textContent = `${r.entities.length} things recalled in ${r.ms} ms via ${r.engine}:\n\n${r.memory}`;
    };

    // ----- buttons -----
    /**
     * @param {string} name
     * @param {() => Promise<void>} fn
     */
    const button = (name, fn) => {
        const b = /** @type {HTMLButtonElement} */ (el(name));
        b.addEventListener('click', async () => {
            if (b.disabled) return;
            b.disabled = true;
            try {
                await fn();
            } catch (err) {
                deps.notify('error', err instanceof Error ? err.message : String(err));
            } finally {
                b.disabled = false;
                showProgress();
                void refreshMemory();
            }
        });
    };

    button('check', () => refreshGraphify(true));

    button('remember', async () => {
        if (!controller.currentScope()) throw new Error('Open a chat first.');
        const totals = await controller.rememberPending({ manual: true });
        if (totals.segments === 0) deps.notify('info', 'Everything in this chat is already remembered.');
        else deps.notify('success', `Read ${totals.segments} part(s): ${totals.entities} things and ${totals.relations} connections noted. graphify is updating the graph.`);
    });

    el('stop').addEventListener('click', () => controller.stop());

    button('preview', async () => {
        const r = await controller.preview();
        const box = /** @type {HTMLDetailsElement} */ (el('preview-box'));
        box.hidden = false;
        box.open = true;
        el('preview-out').textContent = r.error
            ? `Recall failed: ${r.error}`
            : r.memory
                ? deps.settings().recall.template.replace('{{memory}}', r.memory)
                : 'Nothing relevant to the latest messages yet.';
    });

    button('graph', async () => {
        const scope = controller.currentScope();
        if (!scope) throw new Error('Open a chat first.');
        window.open(api.graphUrl(scope.id), '_blank', 'noopener');
    });

    button('rebuild', async () => {
        const scope = controller.currentScope();
        if (!scope) throw new Error('Open a chat first.');
        const { build } = await api.rebuild(scope.id);
        if (build.error) throw new Error(build.error);
        deps.notify('success', `graphify rebuilt the graph: ${build.nodes} things, ${build.edges} connections.`);
    });

    button('forget-chat', async () => {
        const scope = controller.currentScope();
        if (!scope) throw new Error('Open a chat first.');
        if (!(await st.confirm('Forget everything Graph Memory learned from this chat? Other chats sharing this memory are kept.'))) return;
        const { removed } = await api.forget(scope.id, scope.chat.chatId, null);
        deps.notify('success', removed ? `Forgot ${removed} part(s) of this chat.` : 'Nothing from this chat was remembered.');
    });

    button('delete', async () => {
        const scope = controller.currentScope();
        if (!scope) throw new Error('Open a chat first.');
        if (!(await st.confirm(`Delete the whole memory "${scope.label}"? This can't be undone.`))) return;
        await api.remove(scope.id);
        deps.notify('success', 'Memory deleted.');
    });

    fill();
    fillProfiles();
    void refreshGraphify();
    void refreshMemory();

    return {
        /** Re-reads everything (chat switched, settings changed elsewhere). */
        refresh() {
            fill();
            fillProfiles();
            showProgress();
            showLastRecall();
            void refreshMemory();
        },
        /** Cheap update while remembering is running or after a recall. */
        changed() {
            showProgress();
            showLastRecall();
            if (!controller.extracting) void refreshMemory();
        },
        fillProfiles,
    };
}
