import { describe, expect, it } from 'vitest';
import { normaliseContactId } from '../src/core/contact-id.js';

describe('normaliseContactId', () => {
    it.each([
        ['+447700900123', '+447700900123'],
        ['+44 7700 900123', '+447700900123'],
        ['+1 (555) 010-9999', '+15550109999'],
        ['0044 7700 900123', '+447700900123'],
        ['447700900123', '+447700900123'],
        ['447700900123@s.whatsapp.net', '+447700900123'],
        ['447700900123:12@s.whatsapp.net', '+447700900123'],
        ['  +447700900123  ', '+447700900123'],
        ['lid:123456789', 'lid:123456789'],
        ['LID:123456789', 'lid:123456789'],
        ['123456789@lid', 'lid:123456789'],
        ['123456789:3@lid', 'lid:123456789'],
    ])('normalises %s to %s', (input, expected) => {
        expect(normaliseContactId(input)).toBe(expected);
    });

    it.each([
        ['07700900123'], // national format, no country code
        [''],
        ['hello'],
        ['+0123456789'],
        ['+12345'], // too short
        ['+1234567890123456'], // too long
        ['lid:'],
        ['12345@g.us'], // group
    ])('rejects %s', (input) => {
        expect(normaliseContactId(input)).toBeNull();
    });
});
