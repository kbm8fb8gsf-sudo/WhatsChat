// @ts-check
/**
 * Graph Memory: long-term memory for SillyTavern characters, kept as a graphify knowledge
 * graph by the companion server plugin.
 */
import { createApi } from './api.js';
import { MemoryController } from './controller.js';
import { mountSettings } from './settings-ui.js';
import { normalizeSettings, SETTINGS_KEY } from './settings-model.js';
import { createSt } from './st.js';

const st = createSt();

/** @returns {import('./settings-model.js').Settings} */
function settings() {
    const root = st.settingsRoot();
    root[SETTINGS_KEY] = normalizeSettings(root[SETTINGS_KEY]);
    return root[SETTINGS_KEY];
}

/** @param {(raw: any) => void} mutate */
function update(mutate) {
    const root = st.settingsRoot();
    const raw = structuredClone(root[SETTINGS_KEY] ?? {});
    mutate(raw);
    root[SETTINGS_KEY] = normalizeSettings(raw);
    st.saveSettings();
}

/**
 * @param {'info' | 'warning' | 'error' | 'success'} level
 * @param {string} msg
 */
function notify(level, msg) {
    const t = /** @type {any} */ (globalThis).toastr;
    if (t?.[level]) t[level](msg, 'Graph Memory');
    else console.log(`[Graph Memory] ${msg}`);
}

const api = createApi({ headers: () => st.requestHeaders() });
/** @type {ReturnType<typeof mountSettings> | null} */
let ui = null;
const controller = new MemoryController({ st, api, settings, notify, onChange: () => ui?.changed() });

// SillyTavern calls this (named in manifest.json) before building each prompt.
/** @type {any} */ (globalThis).graphMemoryInterceptor = async (/** @type {any[]} */ chat, /** @type {number} */ _contextSize, /** @type {Function} */ _abort, /** @type {string} */ type) => {
    try {
        await controller.beforeGeneration(chat, type);
    } catch (err) {
        console.warn('[Graph Memory] Recall skipped:', err);
    }
};

async function mountUi() {
    const container = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    if (!container) return;
    const res = await fetch(new URL('./settings.html', import.meta.url));
    const wrapper = document.createElement('div');
    wrapper.innerHTML = await res.text();
    const root = /** @type {HTMLElement} */ (wrapper.firstElementChild);
    container.append(root);
    ui = mountSettings({ root, controller, api, st, settings, update, notify });
}

settings();
st.on('MESSAGE_RECEIVED', () => controller.scheduleAuto());
st.on('MESSAGE_SENT', () => controller.scheduleAuto());
st.on('CHAT_CHANGED', () => {
    controller.chatChanged();
    ui?.refresh();
    controller.scheduleAuto();
});
for (const event of ['CONNECTION_PROFILE_CREATED', 'CONNECTION_PROFILE_DELETED', 'CONNECTION_PROFILE_UPDATED']) {
    st.on(event, () => ui?.fillProfiles());
}
st.on('APP_READY', () => ui?.fillProfiles());
void mountUi().catch((err) => console.error('[Graph Memory] Could not show settings:', err));
