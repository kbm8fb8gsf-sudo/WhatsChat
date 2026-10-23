// @ts-check
/**
 * The WhatsChat panel in SillyTavern's Extensions menu. All state lives on the server; this
 * renders it and sends changes back.
 */

import {
    checkContacts,
    contactToForm,
    describeBackground,
    describeStatus,
    emptyContact,
    formToContact,
    formToOverrides,
    overridesToForm,
    PRESETS,
    TIMING_FIELDS,
} from './settings-model.js';

/**
 * @typedef {import('./api-client.js').ApiClient} ApiClient
 * @typedef {import('./api-client.js').BridgeStatus} BridgeStatus
 * @typedef {import('./st-bridge.js').Bridge} Bridge
 * @typedef {import('./settings-model.js').ContactForm} ContactForm
 */

const TEMPLATE_URL = new URL('./settings.html', import.meta.url);

export class SettingsPanel {
    /**
     * @param {{ api: ApiClient, bridge: Bridge }} deps
     */
    constructor(deps) {
        this.api = deps.api;
        this.bridge = deps.bridge;
        /** @type {HTMLElement | null} */
        this.root = null;
        /** @type {Record<string, any> | null} The config the form was last filled from. */
        this.config = null;
        /** @type {Record<string, any> | null} The newest config the server has sent. */
        this.latest = null;
        this.dirty = false;
        /** @type {string | null} */
        this.shownPairingCode = null;
    }

    /** @param {HTMLElement} container */
    async mount(container) {
        const response = await fetch(TEMPLATE_URL);
        const wrapper = document.createElement('div');
        wrapper.innerHTML = await response.text();
        const root = /** @type {HTMLElement} */ (wrapper.firstElementChild);
        container.append(root);
        this.root = root;

        fillOptions(this.select('[data-setting="preset"]'), PRESETS.map((p) => [p.value, p.label]));
        this.renderTimingFields();
        this.bindEvents();
    }

    /** @param {string} message */
    showNotice(message) {
        const notice = this.el('[data-role="notice"]');
        notice.textContent = message;
        notice.hidden = message === '';
    }

    /** @param {BridgeStatus} status */
    async showStatus(status) {
        const { text, tone } = describeStatus(status);
        this.el('[data-role="status-text"]').textContent = text;
        this.el('[data-role="status-dot"]').dataset['tone'] = tone;
        this.input('[data-role="enabled"]').checked = status.enabled;
        const background = describeBackground(status.background);
        this.el('[data-role="background-text"]').textContent = background.text;
        this.el('[data-role="background-dot"]').dataset['tone'] = background.tone;

        const pairing = status.transport.state === 'pairing' ? (status.transport.pairingCode ?? null) : null;
        const qrBox = this.el('[data-role="qr"]');
        if (!pairing) {
            qrBox.hidden = true;
            this.shownPairingCode = null;
            return;
        }
        if (pairing === this.shownPairingCode) return;
        this.shownPairingCode = pairing;
        try {
            const { qr } = await this.api.qr();
            if (qr && this.shownPairingCode === pairing) {
                /** @type {HTMLImageElement} */ (this.el('[data-role="qr-image"]')).src = qr;
                qrBox.hidden = false;
            }
        } catch (error) {
            console.warn('[WhatsChat] Could not load the QR code', error);
        }
    }

    /** @param {{ username: string, passwordSet: boolean }} login */
    showLogin(login) {
        this.input('[data-role="login-username"]').value = login.username;
        const password = this.input('[data-role="login-password"]');
        password.value = '';
        password.placeholder = login.passwordSet ? 'Saved (type to change)' : '';
    }

    /**
     * New config from the server. Re-fill the form unless the user is mid-edit.
     * @param {Record<string, any>} config
     */
    showConfig(config) {
        this.latest = config;
        if (this.dirty && this.config) return;
        this.config = config;
        this.fillForm(config);
    }

    // ---- form ----

    /** @param {Record<string, any>} config */
    fillForm(config) {
        this.select('[data-setting="preset"]').value = config['realistic']['preset'];
        this.input('[data-setting="injectNote"]').checked = config['realistic']['injectNote'];
        /** @type {HTMLTextAreaElement} */ (this.el('[data-setting="note"]')).value = config['realistic']['note'];
        const timing = overridesToForm(config['realistic']['overrides']);
        for (const field of TIMING_FIELDS) this.input(`[data-timing="${field.key}"]`).value = timing[field.key];
        this.input('[data-setting="restorePreviousChat"]').checked = config['sillytavern']['restorePreviousChat'];
        this.input('[data-setting="neutraliseMacros"]').checked = config['inbound']['neutraliseMacros'];
        this.input('[data-setting="mediaPlaceholders"]').checked = config['inbound']['mediaPlaceholders'];
        this.input('[data-setting="markOnlineOnConnect"]').checked = config['whatsapp']['markOnlineOnConnect'];
        this.input('[data-setting="quietSeconds"]').value = String(config['inbound']['quietMs'] / 1000);
        this.input('[data-setting="backgroundEnabled"]').checked = config['background']['enabled'];
        this.input('[data-setting="backgroundExecutablePath"]').value = config['background']['executablePath'];
        this.input('[data-setting="backgroundUrl"]').value = config['background']['url'];

        const list = this.el('[data-role="contacts"]');
        list.replaceChildren();
        for (const contact of config['contacts']) this.addContactRow(contactToForm(contact));
        this.setDirty(false);
        this.showErrors([]);
    }

    /** @param {ContactForm} form */
    addContactRow(form) {
        const template = /** @type {HTMLTemplateElement} */ (this.el('[data-role="contact-template"]'));
        const row = /** @type {HTMLElement} */ (
            /** @type {DocumentFragment} */ (template.content.cloneNode(true)).firstElementChild
        );
        row.dataset['originalId'] = form.id;
        const field = (/** @type {string} */ name) =>
            /** @type {HTMLInputElement & HTMLSelectElement} */ (row.querySelector(`[data-field="${name}"]`));

        field('id').value = form.id;
        field('label').value = form.label;
        field('enabled').checked = form.enabled;
        fillOptions(field('preset'), [['', 'Default style'], ...PRESETS.map((p) => /** @type {[string, string]} */ ([p.value, p.label.split(':')[0] ?? p.value]))]);
        field('preset').value = form.preset;

        const characterSelect = field('characterAvatar');
        const chatSelect = field('chatFile');
        this.fillCharacters(characterSelect, form.characterAvatar);
        void this.fillChats(chatSelect, form.characterAvatar, form.chatFile);

        // Characters can change while the panel is open, so refresh the lists when opened.
        characterSelect.addEventListener('focus', () => {
            this.fillCharacters(characterSelect, characterSelect.value);
        });
        characterSelect.addEventListener('change', () => {
            void this.fillChats(chatSelect, characterSelect.value, '');
        });
        chatSelect.addEventListener('focus', () => {
            void this.fillChats(chatSelect, characterSelect.value, chatSelect.value);
        });
        row.querySelector('[data-action="remove"]')?.addEventListener('click', () => {
            row.remove();
            this.setDirty(true);
        });
        this.el('[data-role="contacts"]').append(row);
    }

    /**
     * @param {HTMLSelectElement} select
     * @param {string} selected
     */
    fillCharacters(select, selected) {
        /** @type {[string, string][]} */
        const options = [['', 'Choose a character\u2026'], ...this.bridge.listCharacters().map((c) => /** @type {[string, string]} */ ([c.avatar, c.name]))];
        if (selected && !options.some(([value]) => value === selected)) options.push([selected, `${selected} (not found)`]);
        fillOptions(select, options);
        select.value = selected;
    }

    /**
     * @param {HTMLSelectElement} select
     * @param {string} avatar
     * @param {string} selected
     */
    async fillChats(select, avatar, selected) {
        /** @type {[string, string][]} */
        const options = [['', 'New chat on the first message']];
        if (avatar) {
            try {
                for (const chat of await this.bridge.listChats(avatar)) options.push([chat, chat]);
            } catch (error) {
                console.warn('[WhatsChat] Could not list chats', error);
            }
        }
        if (selected && !options.some(([value]) => value === selected)) options.push([selected, `${selected} (not found)`]);
        fillOptions(select, options);
        select.value = selected;
    }

    /** @returns {ContactForm[]} */
    readContacts() {
        return [...this.el('[data-role="contacts"]').querySelectorAll('.whatschat-contact')].map((row) => {
            const value = (/** @type {string} */ name) =>
                /** @type {HTMLInputElement} */ (row.querySelector(`[data-field="${name}"]`));
            return {
                id: value('id').value,
                label: value('label').value,
                enabled: value('enabled').checked,
                characterAvatar: value('characterAvatar').value,
                chatFile: value('chatFile').value,
                preset: value('preset').value,
            };
        });
    }

    async save() {
        const base = this.config;
        if (!base) return;
        const rows = this.readContacts();
        /** @type {Record<string, string>} */
        const timingForm = {};
        for (const field of TIMING_FIELDS) timingForm[field.key] = this.input(`[data-timing="${field.key}"]`).value;
        const timing = formToOverrides(/** @type {any} */ (timingForm), base['realistic']['overrides']);
        const quiet = Number(this.input('[data-setting="quietSeconds"]').value);
        const errors = [...checkContacts(rows), ...timing.errors];
        if (!Number.isFinite(quiet) || quiet < 0) errors.push('The wait for more messages must be a number of seconds');
        if (errors.length > 0) {
            this.showErrors(errors);
            return;
        }

        const latest = this.latest ?? base;
        /** @type {Record<string, any>} */
        const config = structuredClone(latest);
        const originals = /** @type {Record<string, any>[]} */ (base['contacts']);
        const latestContacts = /** @type {Record<string, any>[]} */ (latest['contacts']);
        const rowElements = [...this.el('[data-role="contacts"]').querySelectorAll('.whatschat-contact')];
        config['contacts'] = rows.map((row, i) => {
            const originalId = /** @type {HTMLElement | undefined} */ (rowElements[i])?.dataset['originalId'] ?? '';
            return formToContact(
                row,
                originals.find((c) => c['id'] === originalId),
                latestContacts.find((c) => c['id'] === originalId),
            );
        });
        config['realistic'] = {
            ...config['realistic'],
            preset: this.select('[data-setting="preset"]').value,
            injectNote: this.input('[data-setting="injectNote"]').checked,
            note: /** @type {HTMLTextAreaElement} */ (this.el('[data-setting="note"]')).value,
            overrides: timing.overrides,
        };
        config['sillytavern'] = {
            ...config['sillytavern'],
            restorePreviousChat: this.input('[data-setting="restorePreviousChat"]').checked,
        };
        config['inbound'] = {
            ...config['inbound'],
            neutraliseMacros: this.input('[data-setting="neutraliseMacros"]').checked,
            mediaPlaceholders: this.input('[data-setting="mediaPlaceholders"]').checked,
            quietMs: Math.round(quiet * 1000),
        };
        config['whatsapp'] = {
            ...config['whatsapp'],
            markOnlineOnConnect: this.input('[data-setting="markOnlineOnConnect"]').checked,
        };
        config['background'] = {
            ...config['background'],
            enabled: this.input('[data-setting="backgroundEnabled"]').checked,
            executablePath: this.input('[data-setting="backgroundExecutablePath"]').value.trim(),
            url: this.input('[data-setting="backgroundUrl"]').value.trim(),
        };

        try {
            const saved = await this.api.saveConfig(config);
            this.dirty = false;
            this.config = saved;
            this.latest = saved;
            this.fillForm(saved);
            this.bridge.notify('Settings saved', 'success');
        } catch (error) {
            this.showErrors([error instanceof Error ? error.message : String(error)]);
        }
    }

    // ---- wiring ----

    bindEvents() {
        const root = /** @type {HTMLElement} */ (this.root);
        root.addEventListener('input', (event) => {
            if (
                /** @type {HTMLElement} */ (event.target).closest('.inline-drawer-content') &&
                !isEnabledToggle(event.target) &&
                !isLoginField(event.target)
            ) {
                this.setDirty(true);
            }
        });
        this.input('[data-role="enabled"]').addEventListener('change', (event) => {
            const on = /** @type {HTMLInputElement} */ (event.target).checked;
            (on ? this.api.connect() : this.api.disconnect()).catch((/** @type {unknown} */ error) => {
                this.bridge.notify(error instanceof Error ? error.message : String(error), 'error');
            });
        });
        this.on('logout', async () => {
            if (!window.confirm('Log out of WhatsApp? You will need to scan a QR code again to reconnect.')) return;
            await this.api.logout();
        });
        this.on('add-contact', () => {
            this.addContactRow(emptyContact());
            this.setDirty(true);
        });
        this.on('save', () => this.save());
        this.on('save-login', async () => {
            const username = this.input('[data-role="login-username"]').value;
            const password = this.input('[data-role="login-password"]').value;
            this.showLogin(await this.api.saveLogin(username, password || undefined));
            this.bridge.notify(username.trim() ? 'Login saved' : 'Login removed', 'success');
        });
    }

    /**
     * @param {string} action
     * @param {() => unknown} handler
     */
    on(action, handler) {
        this.el(`[data-action="${action}"]`).addEventListener('click', () => {
            Promise.resolve()
                .then(handler)
                .catch((/** @type {unknown} */ error) => {
                    this.bridge.notify(error instanceof Error ? error.message : String(error), 'error');
                });
        });
    }

    renderTimingFields() {
        const box = this.el('[data-role="timing"]');
        for (const field of TIMING_FIELDS) {
            const label = document.createElement('label');
            const text = document.createElement('span');
            text.textContent = field.label;
            const input = document.createElement('input');
            input.className = 'text_pole';
            input.type = 'number';
            input.min = '0';
            input.step = 'any';
            input.dataset['timing'] = field.key;
            label.append(text, input);
            box.append(label);
        }
    }

    /** @param {string[]} errors */
    showErrors(errors) {
        const box = this.el('[data-role="errors"]');
        box.replaceChildren(
            ...errors.map((message) => {
                const line = document.createElement('div');
                line.textContent = message;
                return line;
            }),
        );
    }

    /** @param {boolean} dirty */
    setDirty(dirty) {
        this.dirty = dirty;
        this.el('[data-action="save"]').classList.toggle('whatschat-unsaved', dirty);
    }

    /** @param {string} selector */
    el(selector) {
        const found = this.root?.querySelector(selector);
        if (!(found instanceof HTMLElement)) throw new Error(`WhatsChat panel is missing ${selector}`);
        return found;
    }

    /** @param {string} selector */
    input(selector) {
        return /** @type {HTMLInputElement} */ (this.el(selector));
    }

    /** @param {string} selector */
    select(selector) {
        return /** @type {HTMLSelectElement} */ (this.el(selector));
    }
}

/**
 * @param {HTMLSelectElement} select
 * @param {[string, string][]} options value/label pairs
 */
function fillOptions(select, options) {
    select.replaceChildren(
        ...options.map(([value, label]) => {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = label;
            return option;
        }),
    );
}

/** @param {EventTarget | null} target */
function isLoginField(target) {
    return target instanceof HTMLElement && (target.dataset['role'] ?? '').startsWith('login-');
}

/** @param {EventTarget | null} target */
function isEnabledToggle(target) {
    return target instanceof HTMLElement && target.dataset['role'] === 'enabled';
}
