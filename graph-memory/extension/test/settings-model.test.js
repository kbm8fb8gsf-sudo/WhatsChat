import { describe, expect, it } from 'vitest';
import { DEFAULT_TEMPLATE, DEFAULTS, normalizeSettings } from '../settings-model.js';

describe('normalizeSettings', () => {
    it('fills in defaults', () => {
        expect(normalizeSettings(undefined)).toEqual(JSON.parse(JSON.stringify(DEFAULTS)));
    });

    it('clamps numbers and rejects unknown choices', () => {
        const s = normalizeSettings({
            scope: 'everything',
            recall: { recentMessages: 99, graphDepth: '3', maxChars: 5, position: 'nowhere', role: 'user' },
            extract: { every: 0, holdBack: -4, responseTokens: 'lots' },
        });
        expect(s.scope).toBe('chat');
        expect(s.recall).toMatchObject({ recentMessages: 20, graphDepth: 3, maxChars: 200, position: 'in_chat', role: 'user' });
        expect(s.extract).toMatchObject({ every: 1, holdBack: 0, responseTokens: 1500 });
    });

    it('keeps a custom template only if it has the {{memory}} slot', () => {
        expect(normalizeSettings({ recall: { template: 'Memories:\n{{memory}}' } }).recall.template).toBe('Memories:\n{{memory}}');
        expect(normalizeSettings({ recall: { template: 'no slot' } }).recall.template).toBe(DEFAULT_TEMPLATE);
    });

    it('keeps booleans and the chosen profile', () => {
        const s = normalizeSettings({ enabled: false, scope: 'character', extract: { auto: false, profileId: 'p1' } });
        expect(s.enabled).toBe(false);
        expect(s.scope).toBe('character');
        expect(s.extract.auto).toBe(false);
        expect(s.extract.profileId).toBe('p1');
    });
});
