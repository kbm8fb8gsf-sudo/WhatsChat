import { isJidBroadcast, isJidGroup, isJidNewsletter, isLidUser, isPnUser, normalizeMessageContent, toNumber } from 'baileys';
import type { proto, WAMessage } from 'baileys';
import { normaliseContactId } from '../core/contact-id.js';
import type { InboundMessage } from './types.js';

/**
 * Converting Baileys messages into transport-neutral InboundMessages. Pure apart from the
 * injected LID → phone number lookup.
 */

export interface MappingOptions {
    /** Baileys' LID → phone-number JID lookup. Resolves null when unknown. */
    resolvePhoneJid: (lidJid: string) => Promise<string | null>;
    /** Turn photos, voice notes etc. into "[sent a photo]" text instead of ignoring them. */
    mediaPlaceholders: boolean;
}

export async function toInboundMessage(message: WAMessage, options: MappingOptions): Promise<InboundMessage | null> {
    const key = message.key;
    const chatJid = key.remoteJid;
    if (!chatJid || !key.id || key.fromMe) return null;
    if (!isOneToOneChat(chatJid)) return null;

    const text = extractText(message.message, options.mediaPlaceholders);
    if (text === null || text.trim() === '') return null;

    const contactId = await resolveContactId(chatJid, key.remoteJidAlt, options.resolvePhoneJid);
    if (contactId === null) return null;

    const pushName = message.pushName?.trim();
    const timestamp = toNumber(message.messageTimestamp);
    return {
        id: key.id,
        contactId,
        replyTo: { transport: 'whatsapp', id: chatJid },
        ref: { chatId: chatJid, messageId: key.id },
        ...(pushName ? { pushName } : {}),
        text,
        timestamp: timestamp > 0 ? timestamp * 1000 : Date.now(),
    };
}

export function isOneToOneChat(jid: string): boolean {
    if (isJidGroup(jid) || isJidBroadcast(jid) || isJidNewsletter(jid)) return false;
    return Boolean(isPnUser(jid) || isLidUser(jid));
}

/**
 * Phone number where possible, because that's what people put on the allowlist. WhatsApp v7
 * often identifies senders by LID; the phone number then comes from the message's alternate
 * JID or Baileys' mapping store. If neither knows it, fall back to "lid:<digits>".
 */
export async function resolveContactId(
    chatJid: string,
    alternateJid: string | undefined,
    resolvePhoneJid: (lidJid: string) => Promise<string | null>,
): Promise<string | null> {
    if (isPnUser(chatJid)) return normaliseContactId(chatJid);
    if (!isLidUser(chatJid)) return null;
    if (alternateJid && isPnUser(alternateJid)) return normaliseContactId(alternateJid);
    try {
        const phoneJid = await resolvePhoneJid(chatJid);
        if (phoneJid && isPnUser(phoneJid)) return normaliseContactId(phoneJid);
    } catch {
        // Unknown mapping: fall through to the LID.
    }
    return normaliseContactId(chatJid);
}

/** The text of a message, a placeholder for media, or null for things that aren't messages. */
export function extractText(raw: proto.IMessage | null | undefined, mediaPlaceholders: boolean): string | null {
    const content = normalizeMessageContent(raw);
    if (!content) return null;
    if (content.conversation) return content.conversation;
    if (content.extendedTextMessage?.text) return content.extendedTextMessage.text;

    const media = describeMedia(content);
    if (!media) return null;
    if (mediaPlaceholders) return media.caption ? `${media.placeholder}\n${media.caption}` : media.placeholder;
    return media.caption ?? null;
}

function describeMedia(content: proto.IMessage): { placeholder: string; caption?: string } | null {
    const withCaption = (placeholder: string, caption: string | null | undefined) =>
        caption?.trim() ? { placeholder, caption: caption.trim() } : { placeholder };

    if (content.imageMessage) return withCaption('[sent a photo]', content.imageMessage.caption);
    if (content.videoMessage) {
        return withCaption(content.videoMessage.gifPlayback ? '[sent a GIF]' : '[sent a video]', content.videoMessage.caption);
    }
    if (content.ptvMessage) return { placeholder: '[sent a video message]' };
    if (content.audioMessage) return { placeholder: content.audioMessage.ptt ? '[sent a voice message]' : '[sent an audio file]' };
    if (content.stickerMessage) return { placeholder: '[sent a sticker]' };
    const document = content.documentMessage ?? content.documentWithCaptionMessage?.message?.documentMessage;
    if (document) {
        const name = document.fileName?.trim();
        return withCaption(name ? `[sent a document: ${name}]` : '[sent a document]', document.caption);
    }
    if (content.locationMessage || content.liveLocationMessage) return { placeholder: '[shared a location]' };
    if (content.contactMessage || content.contactsArrayMessage) return { placeholder: '[shared a contact]' };
    const poll = content.pollCreationMessage ?? content.pollCreationMessageV2 ?? content.pollCreationMessageV3;
    if (poll) return { placeholder: poll.name ? `[sent a poll: ${poll.name}]` : '[sent a poll]' };
    return null;
}
