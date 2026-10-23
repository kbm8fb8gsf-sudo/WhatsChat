import { describe, expect, it } from 'vitest';
import { PRESETS } from '../src/config/presets.js';
import { resolveNote, resolvePacing } from '../src/config/resolve.js';
import { DEFAULT_NOTE, defaultConfig, PRESET_NAMES, pacingSchema, parseConfig } from '../src/config/schema.js';

const contact = { id: '+447700900123', characterAvatar: 'Alice.png' };

describe('config schema', () => {
    it('produces complete defaults from an empty object', () => {
        const config = defaultConfig();
        expect(config.enabled).toBe(false);
        expect(config.contacts).toEqual([]);
        expect(config.realistic.preset).toBe('natural');
        expect(config.realistic.note).toBe(DEFAULT_NOTE);
        expect(config.inbound.neutraliseMacros).toBe(true);
        expect(config.whatsapp.markOnlineOnConnect).toBe(false);
    });

    it('fills defaults inside partially specified sections', () => {
        const result = parseConfig({ inbound: { quietMs: 1000 } });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.config.inbound.quietMs).toBe(1000);
        expect(result.config.inbound.maxMessages).toBe(10);
    });

    it('normalises contact ids and fills contact defaults', () => {
        const result = parseConfig({ contacts: [{ id: '+44 7700 900123', characterAvatar: 'Alice.png' }] });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.config.contacts[0]).toEqual({
            id: '+447700900123',
            label: '',
            enabled: true,
            characterAvatar: 'Alice.png',
        });
    });

    it('reports readable issues with paths', () => {
        const result = parseConfig({
            enabled: 'yes',
            contacts: [{ id: '07700900123', characterAvatar: '' }],
        });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.issues.some((i) => i.startsWith('enabled:'))).toBe(true);
        expect(result.issues.some((i) => i.startsWith('contacts.0.id:') && i.includes('country code'))).toBe(true);
        expect(result.issues.some((i) => i.startsWith('contacts.0.characterAvatar:'))).toBe(true);
    });

    it('rejects duplicate contacts after normalisation', () => {
        const result = parseConfig({
            contacts: [contact, { id: '0044 7700 900123', characterAvatar: 'Bob.png' }],
        });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.issues).toContain('contacts.1.id: Contact +447700900123 is listed more than once');
    });

    it('rejects inverted ranges in overrides', () => {
        const result = parseConfig({ realistic: { overrides: { readDelayMs: { min: 10, max: 5 } } } });
        expect(result.ok).toBe(false);
    });

    it('rejects unknown presets', () => {
        expect(parseConfig({ realistic: { preset: 'sleepy' } }).ok).toBe(false);
    });

    it('accepts its own output (round trip)', () => {
        const first = parseConfig({ contacts: [contact], realistic: { preset: 'quick' } });
        expect(first.ok).toBe(true);
        if (!first.ok) return;
        const second = parseConfig(JSON.parse(JSON.stringify(first.config)));
        expect(second).toEqual(first);
    });
});

describe('presets', () => {
    it.each(PRESET_NAMES)('%s is a valid pacing', (name) => {
        expect(pacingSchema.safeParse(PRESETS[name]).success).toBe(true);
    });

    it('off disables delays, splitting and typing', () => {
        expect(PRESETS.off).toMatchObject({ split: false, showTyping: false, typingMaxMs: 0 });
    });
});

describe('resolvePacing', () => {
    it('uses the global preset by default', () => {
        expect(resolvePacing(defaultConfig(), undefined)).toEqual(PRESETS.natural);
    });

    it('layers preset, global overrides and contact overrides', () => {
        const result = parseConfig({
            realistic: { preset: 'quick', overrides: { typingCharsPerSec: 10, split: false } },
            contacts: [{ ...contact, preset: 'busy', overrides: { split: true, bubbleGapMs: { min: 1, max: 2 } } }],
        });
        if (!result.ok) throw new Error(result.issues.join());
        const pacing = resolvePacing(result.config, result.config.contacts[0]);
        expect(pacing).toEqual({
            ...PRESETS.busy,
            typingCharsPerSec: 10,
            split: true,
            bubbleGapMs: { min: 1, max: 2 },
        });
    });

    it('ignores overrides when the effective preset is off', () => {
        const result = parseConfig({
            realistic: { overrides: { showTyping: true } },
            contacts: [{ ...contact, preset: 'off', overrides: { split: true } }],
        });
        if (!result.ok) throw new Error(result.issues.join());
        expect(resolvePacing(result.config, result.config.contacts[0])).toEqual(PRESETS.off);
    });

    it('re-orders a min/max pair that layering inverted', () => {
        const result = parseConfig({ realistic: { overrides: { typingMinMs: 30_000 } } });
        if (!result.ok) throw new Error(result.issues.join());
        const pacing = resolvePacing(result.config, undefined);
        expect(pacing.typingMinMs).toBe(PRESETS.natural.typingMaxMs);
        expect(pacing.typingMaxMs).toBe(30_000);
    });
});

describe('resolveNote', () => {
    it('returns the note when enabled', () => {
        expect(resolveNote(defaultConfig(), undefined)).toBe(DEFAULT_NOTE);
    });

    it('returns null when disabled, blank or the preset is off', () => {
        const off = parseConfig({ realistic: { preset: 'off' } });
        const disabled = parseConfig({ realistic: { injectNote: false } });
        const blank = parseConfig({ realistic: { note: '   ' } });
        for (const result of [off, disabled, blank]) {
            if (!result.ok) throw new Error(result.issues.join());
            expect(resolveNote(result.config, undefined)).toBeNull();
        }
    });
});
