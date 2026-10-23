// @ts-check
/**
 * Pure helpers for the settings panel: status wording and converting between the server
 * config and the form. No DOM, no SillyTavern.
 */

/** @typedef {import('./api-client.js').BridgeStatus} BridgeStatus */

export const PRESETS = /** @type {const} */ ([
    { value: 'off', label: 'Off: replies arrive instantly, in one message' },
    { value: 'quick', label: 'Quick: phone in hand, replies within seconds' },
    { value: 'natural', label: 'Natural: reads within half a minute, a few short messages' },
    { value: 'busy', label: 'Busy: sees your messages minutes later' },
]);

/**
 * Pacing fields the panel exposes, shown in seconds (the config stores milliseconds).
 * Blank means "use the preset".
 */
export const TIMING_FIELDS = /** @type {const} */ ([
    { key: 'readDelayMin', label: 'Seen after at least (s)' },
    { key: 'readDelayMax', label: 'Seen after at most (s)' },
    { key: 'typingCharsPerSec', label: 'Typing speed (letters per second)' },
    { key: 'gapMin', label: 'Pause between messages, at least (s)' },
    { key: 'gapMax', label: 'Pause between messages, at most (s)' },
]);

/** @typedef {Record<(typeof TIMING_FIELDS)[number]['key'], string>} TimingForm */

/**
 * @param {BridgeStatus | null} status
 * @returns {{ text: string, tone: 'ok' | 'busy' | 'off' | 'error' }}
 */
export function describeStatus(status) {
    if (!status) return { text: 'Loading\u2026', tone: 'off' };
    const t = status.transport;
    switch (t.state) {
        case 'connected':
            return { text: t.self ? `Connected as ${t.self}` : 'Connected', tone: 'ok' };
        case 'pairing':
            return { text: 'Scan the QR code with the phone to link it', tone: 'busy' };
        case 'connecting':
            return { text: 'Connecting\u2026', tone: 'busy' };
        case 'reconnecting': {
            const attempt = t.attempt ? ` (attempt ${String(t.attempt)})` : '';
            return { text: `Reconnecting${attempt}\u2026${t.error ? ` Last error: ${t.error}` : ''}`, tone: 'busy' };
        }
        case 'logged_out':
            return { text: t.error ?? 'Logged out. Turn it on again to link a phone.', tone: 'off' };
        case 'error':
            return { text: t.error ?? 'Something went wrong', tone: 'error' };
        case 'disabled':
            return { text: status.enabled ? 'Starting\u2026' : 'Off', tone: 'off' };
    }
}

/**
 * @param {Record<string, any> | undefined} overrides Pacing overrides from the config (ms).
 * @returns {TimingForm}
 */
export function overridesToForm(overrides = {}) {
    const seconds = (/** @type {unknown} */ ms) => (typeof ms === 'number' ? String(ms / 1000) : '');
    return {
        readDelayMin: seconds(overrides['readDelayMs']?.min),
        readDelayMax: seconds(overrides['readDelayMs']?.max),
        typingCharsPerSec: typeof overrides['typingCharsPerSec'] === 'number' ? String(overrides['typingCharsPerSec']) : '',
        gapMin: seconds(overrides['bubbleGapMs']?.min),
        gapMax: seconds(overrides['bubbleGapMs']?.max),
    };
}

/**
 * Turn the timing form back into overrides, keeping any overrides the panel doesn't show.
 * A range needs both ends; leave both blank to use the preset.
 * @param {TimingForm} form
 * @param {Record<string, any>} [existing]
 * @returns {{ overrides: Record<string, any>, errors: string[] }}
 */
export function formToOverrides(form, existing = {}) {
    /** @type {Record<string, any>} */
    const overrides = { ...existing };
    /** @type {string[]} */
    const errors = [];

    /** @param {string} value @param {string} label */
    const number = (value, label) => {
        const n = Number(value.trim());
        if (!Number.isFinite(n) || n < 0) {
            errors.push(`${label} must be a number of zero or more`);
            return null;
        }
        return n;
    };

    /** @param {'readDelayMs' | 'bubbleGapMs'} key @param {string} min @param {string} max @param {string} label */
    const range = (key, min, max, label) => {
        delete overrides[key];
        if (min.trim() === '' && max.trim() === '') return;
        if (min.trim() === '' || max.trim() === '') {
            errors.push(`${label}: fill in both the least and the most, or neither`);
            return;
        }
        const low = number(min, label);
        const high = number(max, label);
        if (low === null || high === null) return;
        if (low > high) {
            errors.push(`${label}: the least can't be more than the most`);
            return;
        }
        overrides[key] = { min: Math.round(low * 1000), max: Math.round(high * 1000) };
    };

    range('readDelayMs', form.readDelayMin, form.readDelayMax, 'Seen after');
    range('bubbleGapMs', form.gapMin, form.gapMax, 'Pause between messages');
    delete overrides['typingCharsPerSec'];
    if (form.typingCharsPerSec.trim() !== '') {
        const speed = number(form.typingCharsPerSec, 'Typing speed');
        if (speed !== null && speed > 0) overrides['typingCharsPerSec'] = speed;
        else if (speed !== null) errors.push('Typing speed must be more than zero');
    }
    return { overrides, errors };
}

/**
 * @typedef {object} ContactForm
 * @property {string} id
 * @property {string} label
 * @property {boolean} enabled
 * @property {string} characterAvatar
 * @property {string} chatFile "" means "start a new chat on the first message"
 * @property {string} preset "" means "use the default style"
 */

/** @returns {ContactForm} */
export function emptyContact() {
    return { id: '', label: '', enabled: true, characterAvatar: '', chatFile: '', preset: '' };
}

/**
 * @param {Record<string, any>} contact
 * @returns {ContactForm}
 */
export function contactToForm(contact) {
    return {
        id: String(contact['id'] ?? ''),
        label: String(contact['label'] ?? ''),
        enabled: contact['enabled'] !== false,
        characterAvatar: String(contact['characterAvatar'] ?? ''),
        chatFile: String(contact['chatFile'] ?? ''),
        preset: String(contact['preset'] ?? ''),
    };
}

/**
 * Build the config contact from a form row, keeping fields the panel doesn't edit.
 * @param {ContactForm} form
 * @param {Record<string, any> | undefined} original
 * @param {Record<string, any> | undefined} latest The server's current copy of this contact, if any.
 */
export function formToContact(form, original, latest) {
    /** @type {Record<string, any>} */
    const contact = { ...(original ?? {}) };
    contact['id'] = form.id.trim();
    contact['label'] = form.label.trim();
    contact['enabled'] = form.enabled;
    contact['characterAvatar'] = form.characterAvatar;
    // The server fills in the chat it created for a contact on its first message. Don't
    // overwrite that with a stale blank if the panel was opened before it happened.
    const sameCharacter = latest?.['characterAvatar'] === form.characterAvatar;
    const chatFile = form.chatFile || (sameCharacter ? latest?.['chatFile'] : undefined);
    if (chatFile) contact['chatFile'] = chatFile;
    else delete contact['chatFile'];
    if (form.preset) contact['preset'] = form.preset;
    else delete contact['preset'];
    return contact;
}

/**
 * Check rows before saving, in plain words. The server validates again.
 * @param {ContactForm[]} rows
 * @returns {string[]}
 */
export function checkContacts(rows) {
    /** @type {string[]} */
    const errors = [];
    rows.forEach((row, i) => {
        const name = row.label || row.id || `Contact ${String(i + 1)}`;
        if (!row.id.trim()) errors.push(`${name}: enter a phone number`);
        if (!row.characterAvatar) errors.push(`${name}: choose a character`);
    });
    return errors;
}
