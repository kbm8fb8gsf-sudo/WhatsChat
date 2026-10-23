import type { WAMessage } from 'baileys';
import { describe, expect, it, vi } from 'vitest';
import { extractText, resolveContactId, toInboundMessage } from '../src/transport/whatsapp-mapping.js';

const PN = '447700900123@s.whatsapp.net';
const LID = '123456789012345@lid';

function message(overrides: Partial<WAMessage> & { message?: WAMessage['message'] }): WAMessage {
    return {
        key: { remoteJid: PN, id: 'ABC', fromMe: false },
        messageTimestamp: 1_760_000_000,
        pushName: 'Alice',
        message: { conversation: 'hello' },
        ...overrides,
    };
}

const noLookup = { resolvePhoneJid: () => Promise.resolve(null), mediaPlaceholders: true };

describe('toInboundMessage', () => {
    it('maps a plain 1:1 text message', async () => {
        expect(await toInboundMessage(message({}), noLookup)).toEqual({
            id: 'ABC',
            contactId: '+447700900123',
            replyTo: { transport: 'whatsapp', id: PN },
            ref: { chatId: PN, messageId: 'ABC' },
            pushName: 'Alice',
            text: 'hello',
            timestamp: 1_760_000_000_000,
        });
    });

    it('replies to the LID chat but identifies the contact by phone number', async () => {
        const inbound = await toInboundMessage(
            message({ key: { remoteJid: LID, remoteJidAlt: PN, id: 'X', fromMe: false } }),
            noLookup,
        );
        expect(inbound).toMatchObject({ contactId: '+447700900123', replyTo: { id: LID }, ref: { chatId: LID } });
    });

    it.each([
        ['our own messages', { key: { remoteJid: PN, id: 'A', fromMe: true } }],
        ['groups', { key: { remoteJid: '120363000000000000@g.us', id: 'A', fromMe: false } }],
        ['status updates', { key: { remoteJid: 'status@broadcast', id: 'A', fromMe: false } }],
        ['newsletters', { key: { remoteJid: '120363000000000000@newsletter', id: 'A', fromMe: false } }],
        ['reactions', { message: { reactionMessage: { text: '\u2764\uFE0F' } } }],
        ['deletes and edits', { message: { protocolMessage: { type: 0 } } }],
        ['empty messages', { message: null }],
    ])('ignores %s', async (_name, overrides) => {
        expect(await toInboundMessage(message(overrides as Partial<WAMessage>), noLookup)).toBeNull();
    });
});

describe('resolveContactId', () => {
    it('uses the phone number of a phone JID, ignoring the device suffix', async () => {
        expect(await resolveContactId('447700900123:7@s.whatsapp.net', undefined, vi.fn())).toBe('+447700900123');
    });

    it('prefers the alternate phone JID for a LID chat', async () => {
        const lookup = vi.fn();
        expect(await resolveContactId(LID, PN, lookup)).toBe('+447700900123');
        expect(lookup).not.toHaveBeenCalled();
    });

    it('asks the LID mapping store when there is no alternate', async () => {
        expect(await resolveContactId(LID, undefined, () => Promise.resolve(PN))).toBe('+447700900123');
    });

    it('falls back to the LID when the phone number is unknown or the lookup fails', async () => {
        expect(await resolveContactId(LID, undefined, () => Promise.resolve(null))).toBe('lid:123456789012345');
        expect(await resolveContactId(LID, undefined, () => Promise.reject(new Error('x')))).toBe('lid:123456789012345');
    });

    it('rejects anything that is not a person', async () => {
        expect(await resolveContactId('120363000000000000@g.us', undefined, vi.fn())).toBeNull();
    });
});

describe('extractText', () => {
    it.each([
        ['conversation', { conversation: 'hi' }, 'hi'],
        ['extended text (links, replies)', { extendedTextMessage: { text: 'see https://x.test' } }, 'see https://x.test'],
        ['disappearing message', { ephemeralMessage: { message: { conversation: 'poof' } } }, 'poof'],
        ['view-once photo', { viewOnceMessageV2: { message: { imageMessage: { caption: 'look' } } } }, '[sent a photo]\nlook'],
        ['photo with caption', { imageMessage: { caption: ' nice view ' } }, '[sent a photo]\nnice view'],
        ['photo', { imageMessage: {} }, '[sent a photo]'],
        ['GIF', { videoMessage: { gifPlayback: true } }, '[sent a GIF]'],
        ['voice note', { audioMessage: { ptt: true } }, '[sent a voice message]'],
        ['audio file', { audioMessage: {} }, '[sent an audio file]'],
        ['sticker', { stickerMessage: {} }, '[sent a sticker]'],
        ['document', { documentMessage: { fileName: 'notes.pdf' } }, '[sent a document: notes.pdf]'],
        ['location', { locationMessage: { degreesLatitude: 1 } }, '[shared a location]'],
        ['contact card', { contactMessage: { displayName: 'Bob' } }, '[shared a contact]'],
        ['poll', { pollCreationMessageV3: { name: 'Pizza?' } }, '[sent a poll: Pizza?]'],
    ])('handles a %s', (_name, content, expected) => {
        expect(extractText(content, true)).toBe(expected);
    });

    it('keeps only captions when media placeholders are off', () => {
        expect(extractText({ imageMessage: { caption: 'look' } }, false)).toBe('look');
        expect(extractText({ imageMessage: {} }, false)).toBeNull();
        expect(extractText({ conversation: 'hi' }, false)).toBe('hi');
    });
});
