/**
 * Canonical contact ids are either an E.164 phone number ("+447700900123") or, when WhatsApp
 * only gives us its internal id and no phone number can be resolved, "lid:<digits>".
 */

const E164 = /^\+[1-9]\d{6,14}$/;

/** Normalise user- or transport-supplied contact ids. Returns null if the input isn't usable. */
export function normaliseContactId(raw: string): string | null {
    const trimmed = raw.trim();

    const lid = /^(?:lid:(\d+)|(\d+)(?::\d+)?@lid)$/i.exec(trimmed);
    if (lid) return `lid:${lid[1] ?? lid[2] ?? ''}`;

    // WhatsApp phone JIDs, optionally with a device suffix: 447700900123:12@s.whatsapp.net
    const jid = /^(\d+)(?::\d+)?@s\.whatsapp\.net$/i.exec(trimmed);
    let phone = jid ? `+${jid[1] ?? ''}` : trimmed.replace(/[\s\-().]/g, '');

    if (phone.startsWith('00')) phone = `+${phone.slice(2)}`;
    else if (/^[1-9]\d+$/.test(phone)) phone = `+${phone}`;

    return E164.test(phone) ? phone : null;
}
