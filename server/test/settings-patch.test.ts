import { describe, expect, it } from 'vitest';
import { withAutoConnect } from '../src/background/settings-patch.js';

describe('withAutoConnect', () => {
    it('turns auto-connect on, keeping everything else', () => {
        const input = JSON.stringify({ main_api: 'openai', power_user: { auto_connect: false, theme: 'dark' }, x: [1] });
        expect(JSON.parse(withAutoConnect(input))).toEqual({
            main_api: 'openai',
            power_user: { auto_connect: true, theme: 'dark' },
            x: [1],
        });
    });

    it('adds power_user if it is missing', () => {
        expect(JSON.parse(withAutoConnect('{"main_api":"novel"}'))).toEqual({ main_api: 'novel', power_user: { auto_connect: true } });
    });

    it('leaves anything that is not a settings object alone', () => {
        expect(withAutoConnect('not json')).toBe('not json');
        expect(withAutoConnect('[1,2]')).toBe('[1,2]');
        expect(withAutoConnect('null')).toBe('null');
    });
});
