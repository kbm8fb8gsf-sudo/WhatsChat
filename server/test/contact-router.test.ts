import { describe, expect, it } from 'vitest';
import { parseConfig, type Config } from '../src/config/schema.js';
import { routeInbound } from '../src/core/contact-router.js';

function config(input: unknown): Config {
    const result = parseConfig(input);
    if (!result.ok) throw new Error(result.issues.join('; '));
    return result.config;
}

const base = {
    enabled: true,
    contacts: [
        { id: '+447700900123', characterAvatar: 'Alice.png' },
        { id: '+447700900456', characterAvatar: 'Bob.png', enabled: false },
        { id: 'lid:987654321', characterAvatar: 'Carol.png' },
    ],
};

describe('routeInbound', () => {
    it('accepts an allowlisted, enabled contact', () => {
        const decision = routeInbound(config(base), '+447700900123');
        expect(decision).toMatchObject({ kind: 'accept', contact: { characterAvatar: 'Alice.png' } });
    });

    it('matches regardless of how the id is formatted', () => {
        expect(routeInbound(config(base), '447700900123@s.whatsapp.net').kind).toBe('accept');
        expect(routeInbound(config(base), '987654321@lid').kind).toBe('accept');
    });

    it.each([
        ['+447700900999', 'not-allowlisted'],
        ['+447700900456', 'contact-disabled'],
        ['not a number', 'invalid-id'],
    ])('ignores %s (%s)', (id, reason) => {
        expect(routeInbound(config(base), id)).toEqual({ kind: 'ignore', reason });
    });

    it('ignores everyone while the bridge is disabled', () => {
        expect(routeInbound(config({ ...base, enabled: false }), '+447700900123')).toEqual({
            kind: 'ignore',
            reason: 'bridge-disabled',
        });
    });
});
