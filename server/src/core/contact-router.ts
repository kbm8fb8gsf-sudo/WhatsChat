import type { Config, ContactConfig } from '../config/schema.js';
import { normaliseContactId } from './contact-id.js';

export type IgnoreReason = 'bridge-disabled' | 'invalid-id' | 'not-allowlisted' | 'contact-disabled';

export type RouteDecision =
    | { readonly kind: 'accept'; readonly contact: ContactConfig }
    | { readonly kind: 'ignore'; readonly reason: IgnoreReason };

export function findContact(config: Config, contactId: string): ContactConfig | undefined {
    const id = normaliseContactId(contactId);
    if (id === null) return undefined;
    return config.contacts.find((contact) => contact.id === id);
}

/** Decide whether an inbound message from `contactId` should reach SillyTavern. */
export function routeInbound(config: Config, contactId: string): RouteDecision {
    if (!config.enabled) return { kind: 'ignore', reason: 'bridge-disabled' };
    if (normaliseContactId(contactId) === null) return { kind: 'ignore', reason: 'invalid-id' };
    const contact = findContact(config, contactId);
    if (!contact) return { kind: 'ignore', reason: 'not-allowlisted' };
    if (!contact.enabled) return { kind: 'ignore', reason: 'contact-disabled' };
    return { kind: 'accept', contact };
}
