import { z } from 'zod';
import { normaliseContactId } from '../core/contact-id.js';

export const PRESET_NAMES = ['off', 'quick', 'natural', 'busy'] as const;
export const presetNameSchema = z.enum(PRESET_NAMES);
export type PresetName = z.infer<typeof presetNameSchema>;

export const DEFAULT_NOTE =
    "You're texting {{user}} on WhatsApp. Reply like a real person texting: short, casual, " +
    'no actions or narration, no markdown. Separate messages with a blank line.';

const MAX_DELAY_MS = 24 * 60 * 60 * 1000;
const ms = z.number().int().min(0).max(MAX_DELAY_MS);

const msRangeSchema = z
    .object({ min: ms, max: ms })
    .refine((r) => r.min <= r.max, { error: 'min must not exceed max' });

const pacingShape = z.object({
    readDelayMs: msRangeSchema,
    thinkMs: msRangeSchema,
    typingCharsPerSec: z.number().positive().max(100),
    typingMinMs: ms,
    typingMaxMs: ms,
    typingJitter: z.number().min(0).max(1),
    bubbleGapMs: msRangeSchema,
    split: z.boolean(),
    showTyping: z.boolean(),
});

export const pacingSchema = pacingShape.refine((p) => p.typingMinMs <= p.typingMaxMs, {
    error: 'typingMinMs must not exceed typingMaxMs',
});
export type Pacing = z.infer<typeof pacingSchema>;

/** Any subset of pacing values, layered on top of a preset. */
export const pacingOverridesSchema = pacingShape.partial();
export type PacingOverrides = z.infer<typeof pacingOverridesSchema>;

export const contactIdSchema = z.string().transform((raw, ctx) => {
    const id = normaliseContactId(raw);
    if (id === null) {
        ctx.addIssue({
            code: 'custom',
            message: `"${raw}" is not a phone number with country code (e.g. +447700900123) or a lid:<digits> id`,
        });
        return z.NEVER;
    }
    return id;
});

export const contactSchema = z.object({
    id: contactIdSchema,
    label: z.string().max(80).default(''),
    enabled: z.boolean().default(true),
    /** Character avatar file name, SillyTavern's stable character key. */
    characterAvatar: z.string().min(1),
    /** Chat file name without extension. Unset means "create a new chat on the first message". */
    chatFile: z.string().min(1).optional(),
    preset: presetNameSchema.optional(),
    overrides: pacingOverridesSchema.optional(),
});
export type ContactConfig = z.infer<typeof contactSchema>;

export const configSchema = z
    .object({
        version: z.literal(1).default(1),
        enabled: z.boolean().default(false),
        contacts: z.array(contactSchema).max(100).default([]),
        realistic: z
            .object({
                preset: presetNameSchema.default('natural'),
                injectNote: z.boolean().default(true),
                note: z.string().max(4000).default(DEFAULT_NOTE),
                overrides: pacingOverridesSchema.default({}),
            })
            .prefault({}),
        inbound: z
            .object({
                quietMs: z.number().int().min(0).max(300_000).default(6_000),
                maxWaitMs: z.number().int().min(0).max(600_000).default(45_000),
                maxMessages: z.number().int().min(1).max(100).default(10),
                mediaPlaceholders: z.boolean().default(true),
                neutraliseMacros: z.boolean().default(true),
            })
            .prefault({}),
        cleaner: z
            .object({
                actions: z.enum(['remove', 'keep', 'unwrap']).default('remove'),
                stripMarkdown: z.boolean().default(true),
                dropUnfinishedSentence: z.boolean().default(false),
                maxChars: z.number().int().min(50).max(20_000).default(2_000),
            })
            .prefault({}),
        splitter: z
            .object({
                maxBubbleChars: z.number().int().min(20).max(4_000).default(300),
                minBubbleChars: z.number().int().min(0).max(200).default(20),
                maxBubbles: z.number().int().min(1).max(20).default(6),
            })
            .prefault({}),
        dispatch: z
            .object({
                /** How long a claimed batch may go without the extension renewing its claim. */
                leaseMs: z.number().int().min(10_000).max(3_600_000).default(120_000),
                /** Batches older than this when they reach the front of the queue are dropped. */
                maxAgeMs: z.number().int().min(60_000).max(7 * 24 * 3_600_000).default(12 * 3_600_000),
            })
            .prefault({}),
        sillytavern: z
            .object({
                restorePreviousChat: z.boolean().default(true),
            })
            .prefault({}),
        background: z
            .object({
                /** Reply from a hidden copy of SillyTavern, so no browser tab needs to stay open. */
                enabled: z.boolean().default(false),
                /** A Chrome/Chromium to use instead of the one Playwright installs. Blank = Playwright's. */
                executablePath: z.string().max(1_000).default(''),
                /** SillyTavern's address as seen from this machine. Blank = work it out at startup. */
                url: z.union([z.literal(''), z.url({ protocol: /^https?$/ })]).default(''),
                /** Reload the hidden page before a reply if it has been idle this long, to pick up changes. */
                idleReloadMs: z.number().int().min(0).max(24 * 3_600_000).default(5 * 60_000),
            })
            .prefault({}),
        whatsapp: z
            .object({
                /** Staying "online" stops your phone getting notifications, so it's off by default. */
                markOnlineOnConnect: z.boolean().default(false),
            })
            .prefault({}),
    })
    .superRefine((config, ctx) => {
        const seen = new Set<string>();
        config.contacts.forEach((contact, index) => {
            if (seen.has(contact.id)) {
                ctx.addIssue({
                    code: 'custom',
                    path: ['contacts', index, 'id'],
                    message: `Contact ${contact.id} is listed more than once`,
                });
            }
            seen.add(contact.id);
        });
    });

export type Config = z.infer<typeof configSchema>;

export type ParseResult = { ok: true; config: Config } | { ok: false; issues: string[] };

/** Validate untrusted input (a file or an HTTP body) and fill in defaults. */
export function parseConfig(input: unknown): ParseResult {
    const result = configSchema.safeParse(input);
    if (result.success) return { ok: true, config: result.data };
    return {
        ok: false,
        issues: result.error.issues.map((issue) => {
            const path = issue.path.map(String).join('.');
            return path ? `${path}: ${issue.message}` : issue.message;
        }),
    };
}

export function defaultConfig(): Config {
    return configSchema.parse({});
}
