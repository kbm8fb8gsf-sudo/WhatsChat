// @ts-check
import { describe, expect, it } from 'vitest';
import {
    checkContacts,
    contactToForm,
    describeStatus,
    emptyContact,
    formToContact,
    formToOverrides,
    overridesToForm,
} from '../settings-model.js';

/** @param {any} transport @param {boolean} [enabled] */
const status = (transport, enabled = true) => ({ enabled, transportKind: 'whatsapp', transport, pendingBatches: 0, queuedTasks: 0 });

describe('describeStatus', () => {
    it.each([
        [status({ state: 'connected', self: '+447700900999' }), 'Connected as +447700900999', 'ok'],
        [status({ state: 'pairing', pairingCode: 'x' }), 'Scan the QR code with the phone to link it', 'busy'],
        [status({ state: 'reconnecting', attempt: 3, error: 'timed out' }), 'Reconnecting (attempt 3)\u2026 Last error: timed out', 'busy'],
        [status({ state: 'disabled' }, false), 'Off', 'off'],
        [status({ state: 'error', error: 'Another session took over' }), 'Another session took over', 'error'],
    ])('describes %j', (input, text, tone) => {
        expect(describeStatus(/** @type {any} */ (input))).toEqual({ text, tone });
    });
});

describe('timing overrides', () => {
    it('round-trips seconds and milliseconds', () => {
        const overrides = { readDelayMs: { min: 5000, max: 40000 }, typingCharsPerSec: 4.5, split: false };
        const form = overridesToForm(overrides);
        expect(form).toEqual({ readDelayMin: '5', readDelayMax: '40', typingCharsPerSec: '4.5', gapMin: '', gapMax: '' });
        expect(formToOverrides(form, overrides)).toEqual({ overrides, errors: [] });
    });

    it('removes overrides that were cleared, keeping ones the panel does not show', () => {
        const result = formToOverrides(
            { readDelayMin: '', readDelayMax: '', typingCharsPerSec: '', gapMin: '1', gapMax: '2.5' },
            { readDelayMs: { min: 1, max: 2 }, typingCharsPerSec: 3, showTyping: false },
        );
        expect(result).toEqual({ overrides: { showTyping: false, bubbleGapMs: { min: 1000, max: 2500 } }, errors: [] });
    });

    it('explains mistakes in plain words', () => {
        const result = formToOverrides({ readDelayMin: '10', readDelayMax: '', typingCharsPerSec: '0', gapMin: '5', gapMax: '1' });
        expect(result.errors).toEqual([
            'Seen after: fill in both the least and the most, or neither',
            "Pause between messages: the least can't be more than the most",
            'Typing speed must be more than zero',
        ]);
    });
});

describe('contacts', () => {
    it('converts between config and form, keeping fields the panel does not edit', () => {
        const original = { id: '+447700900123', label: 'Alice', enabled: true, characterAvatar: 'A.png', overrides: { split: false } };
        const form = contactToForm(original);
        expect(form).toEqual({ ...emptyContact(), id: '+447700900123', label: 'Alice', characterAvatar: 'A.png' });
        expect(formToContact({ ...form, preset: 'busy' }, original, original)).toEqual({ ...original, preset: 'busy' });
    });

    it('keeps a chat the server assigned after the panel was opened', () => {
        const form = { ...emptyContact(), id: '+447700900123', characterAvatar: 'A.png' };
        const latest = { id: '+447700900123', characterAvatar: 'A.png', chatFile: 'A - 2026' };
        expect(formToContact(form, undefined, latest)['chatFile']).toBe('A - 2026');
        // ...unless the character was changed, which needs a fresh chat.
        expect(formToContact({ ...form, characterAvatar: 'B.png' }, undefined, latest)['chatFile']).toBeUndefined();
    });

    it('checks for missing numbers and characters', () => {
        expect(checkContacts([{ ...emptyContact(), label: 'Bob' }])).toEqual([
            'Bob: enter a phone number',
            'Bob: choose a character',
        ]);
    });
});
