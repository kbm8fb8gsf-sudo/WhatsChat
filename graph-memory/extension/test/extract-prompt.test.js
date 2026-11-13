import { describe, expect, it } from 'vitest';
import { buildExtractionPrompt, parseExtraction, SYSTEM_PROMPT } from '../extract-prompt.js';

describe('buildExtractionPrompt', () => {
    it('includes the cast, known names, context and the story', () => {
        const p = buildExtractionPrompt({
            story: '[#4] Kai: hi',
            context: '[#3] Seraphina: hello',
            known: [{ name: 'Kai', kind: 'person' }, { name: 'Moss', kind: 'thing' }],
            charName: 'Seraphina',
            userName: 'Kai',
        });
        expect(p.system).toBe(SYSTEM_PROMPT);
        expect(p.user).toContain("Main characters: Seraphina and Kai (Kai is the user's character).");
        expect(p.user).toContain('Already remembered: Kai (person); Moss.');
        expect(p.user).toContain('<context>\n[#3] Seraphina: hello\n</context>');
        expect(p.user).toContain('<story>\n[#4] Kai: hi\n</story>');
    });

    it('leaves out empty sections', () => {
        const p = buildExtractionPrompt({ story: 'x' });
        expect(p.user).not.toContain('Already remembered');
        expect(p.user).not.toContain('<context>');
    });
});

describe('parseExtraction', () => {
    const json = '{"entities":[{"name":"Kai"}],"relations":[{"source":"Kai","relation":"owns","target":"Amulet"}]}';

    it('reads plain JSON', () => {
        expect(parseExtraction(json)).toEqual({ entities: [{ name: 'Kai' }], relations: [{ source: 'Kai', relation: 'owns', target: 'Amulet' }] });
    });

    it('reads JSON in a code fence after reasoning and chatter', () => {
        const text = `<think>Let me think {about} it</think>Sure! Here you go:\n\`\`\`json\n${json}\n\`\`\`\nHope that helps.`;
        expect(parseExtraction(text).entities).toEqual([{ name: 'Kai' }]);
    });

    it('finds the object among other braces and tolerates trailing commas', () => {
        const text = 'Notes {not json} then {"entities":[{"name":"Kai",},],"relations":[],}';
        expect(parseExtraction(text)).toEqual({ entities: [{ name: 'Kai' }], relations: [] });
    });

    it('handles braces inside strings', () => {
        expect(parseExtraction('{"entities":[{"name":"A {weird} name"}]}').entities[0]).toEqual({ name: 'A {weird} name' });
    });

    it('accepts graph-style key names', () => {
        expect(parseExtraction('{"nodes":[{"name":"A"}],"edges":[]}')).toEqual({ entities: [{ name: 'A' }], relations: [] });
    });

    it('accepts the empty answer', () => {
        expect(parseExtraction('{"entities":[],"relations":[]}')).toEqual({ entities: [], relations: [] });
    });

    it('throws when there is no usable JSON', () => {
        expect(() => parseExtraction('I cannot do that.')).toThrow(/expected JSON/);
        expect(() => parseExtraction('{"foo": 1}')).toThrow();
        expect(() => parseExtraction('{"entities": [ {"name": "cut off')).toThrow();
    });
});
