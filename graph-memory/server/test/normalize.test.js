import { describe, expect, it } from 'vitest';
import {
    cleanKind, cleanName, cleanRelation, cleanText, entityId, LIMITS, normalizeEntities, normalizeRelations, parseSegmentInput, SCOPE_ID_RE,
} from '../normalize.js';

describe('entityId', () => {
    it('merges spelling variants of the same name', () => {
        expect(entityId('The Silver Amulet')).toBe('silver_amulet');
        expect(entityId('silver  amulet')).toBe('silver_amulet');
        expect(entityId('Silver-Amulet!')).toBe('silver_amulet');
    });

    it('folds accents and keeps non-Latin letters', () => {
        expect(entityId('Élodie')).toBe('elodie');
        expect(entityId('東京')).toBe('東京');
    });

    it('keeps a name that is only an article', () => {
        expect(entityId('The')).toBe('the');
        expect(entityId('A')).toBe('a');
    });

    it('is empty for names without letters or digits', () => {
        expect(entityId('***')).toBe('');
    });
});

describe('cleaners', () => {
    it('strips quotes, emphasis and control characters from names', () => {
        expect(cleanName('  "*Seraphina*"  ')).toBe('Seraphina');
        expect(cleanName('Kai\u0000\n')).toBe('Kai');
    });

    it('caps text length with an ellipsis', () => {
        const long = 'x'.repeat(500);
        const out = cleanText(long, 100);
        expect(out).toHaveLength(100);
        expect(out.endsWith('…')).toBe(true);
    });

    it('maps synonyms to known kinds and unknown ones to thing', () => {
        expect(cleanKind('Location')).toBe('place');
        expect(cleanKind('NPC')).toBe('person');
        expect(cleanKind('faction')).toBe('group');
        expect(cleanKind('vehicle')).toBe('thing');
        expect(cleanKind(undefined)).toBe('thing');
    });

    it('turns relations into snake_case', () => {
        expect(cleanRelation('Gave Gift To')).toBe('gave_gift_to');
        expect(cleanRelation('is-sister-of')).toBe('is_sister_of');
    });
});

describe('normalizeEntities', () => {
    it('drops junk and merges duplicates, keeping the fuller description', () => {
        const out = normalizeEntities([
            { name: 'Kai', kind: 'person', description: 'Traveller' },
            { name: 'kai', description: 'A wounded traveller from the north', aliases: ['the traveller', 'Kai'] },
            { name: '' },
            'nonsense',
            null,
        ]);
        expect(out).toEqual([
            { name: 'Kai', kind: 'person', description: 'A wounded traveller from the north', aliases: ['the traveller'] },
        ]);
    });

    it('accepts "type" and "summary" as synonyms', () => {
        expect(normalizeEntities([{ name: 'Eldoria', type: 'location', summary: 'A forest' }])[0]).toMatchObject({ kind: 'place', description: 'A forest' });
    });

    it('caps the number of entities', () => {
        const many = Array.from({ length: LIMITS.entities + 50 }, (_, i) => ({ name: `E${i}` }));
        expect(normalizeEntities(many)).toHaveLength(LIMITS.entities);
    });
});

describe('normalizeRelations', () => {
    it('cleans, de-duplicates and drops self-links', () => {
        const out = normalizeRelations([
            { source: 'Kai', relation: 'Owns', target: 'Amulet', detail: '' },
            { source: 'kai', relation: 'owns', target: 'the amulet', detail: 'from his mother' },
            { source: 'Kai', relation: 'likes', target: 'Kai' },
            { from: 'Seraphina', type: 'protects', to: 'Eldoria' },
            { source: 'X', relation: '', target: 'Y' },
        ]);
        expect(out).toEqual([
            { source: 'Kai', relation: 'owns', target: 'Amulet', detail: 'from his mother' },
            { source: 'Seraphina', relation: 'protects', target: 'Eldoria', detail: '' },
        ]);
    });
});

describe('parseSegmentInput', () => {
    const base = { chatId: 'c1', from: 0, to: 4, fingerprint: 'abc', transcript: '[#0] A: hi', entities: [], relations: [] };

    it('accepts a valid segment', () => {
        const r = parseSegmentInput(base);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value.chatLabel).toBe('c1');
    });

    it.each([
        [{ ...base, chatId: '' }, /chatId/],
        [{ ...base, from: 4, to: 4 }, /from\/to/],
        [{ ...base, from: -1 }, /from\/to/],
        [{ ...base, from: 1.5 }, /from\/to/],
        [{ ...base, to: LIMITS.segmentMessages + 1 }, /at most/],
        [{ ...base, transcript: 5 }, /transcript/],
        ['string', /object/],
    ])('rejects %j', (input, error) => {
        const r = parseSegmentInput(input);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toMatch(error);
    });
});

describe('SCOPE_ID_RE', () => {
    it('only allows safe folder names', () => {
        expect(SCOPE_ID_RE.test('chat-0123456789abcdef')).toBe(true);
        expect(SCOPE_ID_RE.test('char-deadbeef')).toBe(true);
        expect(SCOPE_ID_RE.test('../etc')).toBe(false);
        expect(SCOPE_ID_RE.test('chat-XYZ12345')).toBe(false);
        expect(SCOPE_ID_RE.test('other-0123456789')).toBe(false);
    });
});
