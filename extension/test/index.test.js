// @ts-check
import { describe, expect, it } from 'vitest';
import manifest from '../../manifest.json' with { type: 'json' };
import { onActivate } from '../index.js';

describe('extension entry point', () => {
    it('exports the activate hook named in manifest.json', () => {
        expect(manifest.hooks.activate).toBe('onActivate');
        expect(manifest.js).toBe('extension/index.js');
        expect(typeof onActivate).toBe('function');
    });
});
