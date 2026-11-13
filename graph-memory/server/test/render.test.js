import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GraphCache, indexGraph, labelsToIds, parseGraphifyLabels, renderMemory } from '../render.js';
import { tempDir } from './helpers.js';

// Shaped like graphify's graph.json (networkx node-link data with "links").
const GRAPH = {
    directed: true,
    nodes: [
        { id: 'kai', label: 'Kai', attributes: { kind: 'person', description: 'Recovering traveller.', earlier: ['Wounded traveller.'], aliases: ['the traveller'] } },
        { id: 'seraphina', label: 'Seraphina', attributes: { kind: 'character', description: 'Guardian of the forest.' } },
        { id: 'silver_amulet', label: 'The Silver Amulet', attributes: { kind: 'item', description: '' } },
        { id: 'moss', label: 'Moss', attributes: { kind: 'thing' } },
    ],
    links: [
        { source: 'seraphina', target: 'kai', relation: 'healed', relations: [{ relation: 'healed', detail: 'with magic' }] },
        { source: 'kai', target: 'seraphina', relation: 'gave_gift_to', relations: [{ relation: 'gave_gift_to', detail: 'the amulet' }, { relation: 'distrusted' }] },
        { source: 'kai', target: 'silver_amulet', relation: 'owns' },
        { source: 'kai', target: 'ghost', relation: 'dangling' },
    ],
};

// What graphify's query_graph returns (0.9.x), including its truncation notice.
const ANSWER = `Graph: x/graph.json (4 nodes) | Traversal: BFS depth=2 | Start: ['Kai'] | 3 nodes found

[!] TRUNCATED: showing 3 of 4 nodes (~100-token budget).

NODE Kai [src=corpus/a.md loc=#0–#7 community=0 attrs={kind="person"}]
NODE The Silver Amulet [src=corpus/a.md loc=#0–#7 community=0]
NODE Seraphina [src=corpus/b.md loc=#8 community=1]
NODE Not In Graph [src=x loc=y community=0]
EDGE Kai --owns [EXTRACTED]--> The Silver Amulet at=corpus/a.md:#3
... (truncated — 1 more nodes cut by ~100-token budget.`;

describe('parseGraphifyLabels', () => {
    it('reads node labels in graphify order and ignores everything else', () => {
        expect(parseGraphifyLabels(ANSWER)).toEqual(['Kai', 'The Silver Amulet', 'Seraphina', 'Not In Graph']);
    });

    it('returns nothing for "No matching nodes found."', () => {
        expect(parseGraphifyLabels('No matching nodes found.')).toEqual([]);
    });
});

describe('labelsToIds', () => {
    it('maps labels case-insensitively and drops unknown ones', () => {
        const g = indexGraph(GRAPH);
        expect(labelsToIds(g, ['kai', 'The Silver Amulet', 'Nope'])).toEqual(['kai', 'silver_amulet']);
    });
});

describe('indexGraph', () => {
    it('drops links to missing nodes and tolerates junk', () => {
        const g = indexGraph(GRAPH);
        expect(g.links).toHaveLength(3);
        expect(indexGraph(null).nodes.size).toBe(0);
        expect(indexGraph({ nodes: [{ id: 'a' }], edges: [{ source: 'a', target: 'a' }] }).links).toHaveLength(1);
    });
});

describe('renderMemory', () => {
    const g = indexGraph(GRAPH);

    it('lists entities with their relations to entities already shown', () => {
        const out = renderMemory(g, ['kai', 'seraphina', 'silver_amulet'], { maxChars: 2000 });
        expect(out.entities).toEqual(['Kai', 'Seraphina', 'The Silver Amulet']);
        expect(out.text).toBe([
            '• Kai (person), also called the traveller: Recovering traveller. (Earlier: Wounded traveller.)',
            '• Seraphina (character): Guardian of the forest.',
            '   – Seraphina healed Kai (with magic)',
            '   – Kai gave gift to Seraphina (the amulet)',
            '   – Kai distrusted Seraphina',
            '• The Silver Amulet (item)',
            '   – Kai owns The Silver Amulet',
        ].join('\n'));
    });

    it('can leave out earlier descriptions', () => {
        expect(renderMemory(g, ['kai'], { maxChars: 2000, withHistory: false }).text).not.toContain('Earlier');
    });

    it('stays within the character budget, keeping the most relevant first', () => {
        const out = renderMemory(g, ['seraphina', 'kai', 'silver_amulet'], { maxChars: 60 });
        expect(out.text.length).toBeLessThanOrEqual(60);
        expect(out.entities[0]).toBe('Seraphina');
    });

    it('skips an entry that does not fit but keeps later ones that do', () => {
        const out = renderMemory(g, ['kai', 'moss'], { maxChars: 30 });
        expect(out.entities).toEqual(['Moss']);
        expect(out.text).toBe('• Moss');
    });

    it('honours maxEntities', () => {
        expect(renderMemory(g, ['kai', 'seraphina', 'moss'], { maxChars: 5000, maxEntities: 2 }).entities).toHaveLength(2);
    });
});

describe('GraphCache', () => {
    it('reloads when the file changes and returns null when it is missing', async () => {
        const dir = await tempDir();
        const file = path.join(dir, 'graph.json');
        const cache = new GraphCache(1);
        expect(await cache.load(file)).toBeNull();
        await fs.writeFile(file, JSON.stringify({ nodes: [{ id: 'a', label: 'A' }], links: [] }));
        expect((await cache.load(file))?.nodes.size).toBe(1);
        expect(await cache.load(file)).toBe(await cache.load(file));
        await fs.writeFile(file, JSON.stringify({ nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], links: [] }));
        await fs.utimes(file, new Date(), new Date(Date.now() + 5000));
        expect((await cache.load(file))?.nodes.size).toBe(2);
        await fs.rm(file);
        expect(await cache.load(file)).toBeNull();
    });
});
