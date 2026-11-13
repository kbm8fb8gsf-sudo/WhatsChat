import { describe, expect, it } from 'vitest';
import { describeLocation, mergeSegments, storyOrder, topEntities } from '../merge.js';
import { segment } from './helpers.js';

const ent = (name, kind = 'thing', description = '', aliases = []) => ({ name, kind, description, aliases });
const rel = (source, relation, target, detail = '') => ({ source, relation, target, detail });

describe('mergeSegments', () => {
    it('merges the same entity across segments, newest description first', () => {
        const out = mergeSegments([
            segment({ from: 0, to: 8, entities: [ent('Kai', 'person', 'A wounded traveller')] }),
            segment({ from: 8, to: 16, entities: [ent('kai', 'thing', 'Recovering; trusts Seraphina')] }),
        ]);
        expect(out.nodes).toHaveLength(1);
        const kai = out.nodes[0];
        expect(kai.id).toBe('kai');
        expect(kai.label).toBe('Kai');
        expect(kai.attributes).toMatchObject({
            kind: 'person',
            description: 'Recovering; trusts Seraphina',
            earlier: ['A wounded traveller'],
            first_seen: '#0–#7',
            last_seen: '#8–#15',
            mentions: 2,
        });
        expect(kai.rationale).toBe('Recovering; trusts Seraphina');
        expect(kai.source_file).toBe('corpus/aaaaaaaaaaaa_8_16.md');
        expect(kai._origin).toBe('semantic');
        expect(kai.file_type).toBe('concept');
    });

    it('lets a newer spelling replace the label only if it is not worse-capitalised', () => {
        const out = mergeSegments([
            segment({ from: 0, entities: [ent('seraphina')] }),
            segment({ from: 8, entities: [ent('Seraphina')] }),
            segment({ from: 16, entities: [ent('SERAPHINA'.toLowerCase())] }),
        ]);
        expect(out.nodes[0].label).toBe('Seraphina');
    });

    it('resolves aliases to the entity that declared them', () => {
        const out = mergeSegments([
            segment({ entities: [ent('Kai', 'person', '', ['the traveller'])], relations: [rel('the traveller', 'owns', 'Amulet')] }),
        ]);
        expect(out.nodes.map((n) => n.id).sort()).toEqual(['amulet', 'kai']);
        expect(out.edges).toHaveLength(1);
        expect(out.edges[0]).toMatchObject({ source: 'kai', target: 'amulet', relation: 'owns' });
    });

    it('never lets an alias swallow another primary entity', () => {
        const out = mergeSegments([
            segment({ entities: [ent('Kai', 'person', '', ['Ren']), ent('Ren', 'person')] }),
        ]);
        expect(out.nodes.map((n) => n.id).sort()).toEqual(['kai', 'ren']);
    });

    it('creates nodes for relation endpoints the model forgot to list', () => {
        const out = mergeSegments([segment({ relations: [rel('Seraphina', 'protects', 'Eldoria Forest')] })]);
        expect(out.nodes.map((n) => n.label).sort()).toEqual(['Eldoria Forest', 'Seraphina']);
        expect(out.nodes.every((n) => n.attributes.kind === 'thing')).toBe(true);
    });

    it('folds every relation between the same pair into one edge, newest first', () => {
        const out = mergeSegments([
            segment({ from: 0, to: 8, relations: [rel('Kai', 'distrusts', 'Seraphina'), rel('Kai', 'owes', 'Seraphina', 'his life')] }),
            segment({ from: 8, to: 16, relations: [rel('Kai', 'trusts', 'Seraphina'), rel('Kai', 'owes', 'Seraphina')] }),
        ]);
        expect(out.edges).toHaveLength(1);
        const e = out.edges[0];
        expect(e.relation).toBe('owes');
        expect(e.weight).toBe(4);
        expect(e.relations.map((r) => r.relation)).toEqual(['owes', 'trusts', 'distrusts']);
        // A repeat without detail keeps the earlier detail.
        expect(e.relations[0]).toEqual({ relation: 'owes', detail: 'his life', at: '#8–#15' });
    });

    it('keeps opposite directions as separate edges', () => {
        const out = mergeSegments([segment({ relations: [rel('A', 'helps', 'B'), rel('B', 'thanks', 'A')] })]);
        expect(out.edges.map((e) => `${e.source}>${e.target}`).sort()).toEqual(['a>b', 'b>a']);
    });

    it('names the chat in locations when a memory spans several chats', () => {
        const out = mergeSegments([
            segment({ chatKey: 'aaaaaaaaaaaa', chatLabel: 'First', entities: [ent('Kai')] }),
            segment({ chatKey: 'bbbbbbbbbbbb', chatLabel: 'Second', createdAt: '2026-02-01T00:00:00.000Z', entities: [ent('Kai')] }),
        ]);
        expect(out.nodes[0].attributes.first_seen).toBe('First #0–#7');
        expect(out.nodes[0].attributes.last_seen).toBe('Second #0–#7');
    });

    it('returns an empty extraction for no segments', () => {
        expect(mergeSegments([])).toEqual({ nodes: [], edges: [], hyperedges: [] });
    });
});

describe('storyOrder', () => {
    it('orders chats by when they were first remembered, then by message index', () => {
        const a2 = segment({ chatKey: 'aaaaaaaaaaaa', from: 8, createdAt: '2026-03-01T00:00:00.000Z' });
        const a1 = segment({ chatKey: 'aaaaaaaaaaaa', from: 0, createdAt: '2026-01-01T00:00:00.000Z' });
        const b1 = segment({ chatKey: 'bbbbbbbbbbbb', from: 0, createdAt: '2026-02-01T00:00:00.000Z' });
        expect(storyOrder([b1, a2, a1]).map((s) => s.id)).toEqual([a1.id, a2.id, b1.id]);
    });
});

describe('describeLocation', () => {
    it('uses SillyTavern message ids', () => {
        expect(describeLocation(segment({ from: 3, to: 4 }), false)).toBe('#3');
        expect(describeLocation(segment({ from: 3, to: 10, chatLabel: 'C' }), true)).toBe('C #3–#9');
    });
});

describe('topEntities', () => {
    it('ranks by mentions and connections', () => {
        const out = topEntities([
            segment({ entities: [ent('Kai', 'person'), ent('Moss')], relations: [rel('Kai', 'met', 'Seraphina')] }),
            segment({ from: 8, entities: [ent('Kai', 'person'), ent('Seraphina', 'character')] }),
        ], 2);
        expect(out).toEqual([{ name: 'Kai', kind: 'person' }, { name: 'Seraphina', kind: 'character' }]);
    });
});
