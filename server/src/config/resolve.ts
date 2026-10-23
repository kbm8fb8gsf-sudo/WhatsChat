import { PRESETS } from './presets.js';
import type { Config, ContactConfig, Pacing, PresetName } from './schema.js';

export function effectivePreset(config: Config, contact: ContactConfig | undefined): PresetName {
    return contact?.preset ?? config.realistic.preset;
}

/**
 * Pacing for a contact: its preset (or the global one), then global overrides, then the
 * contact's own overrides. The "off" preset ignores overrides, because off means off.
 */
export function resolvePacing(config: Config, contact: ContactConfig | undefined): Pacing {
    const preset = effectivePreset(config, contact);
    const base = PRESETS[preset];
    if (preset === 'off') return { ...base };

    const merged: Pacing = { ...base, ...definedOnly(config.realistic.overrides), ...definedOnly(contact?.overrides) };
    // Overrides are validated individually, so a layered min/max pair can still end up inverted.
    return {
        ...merged,
        readDelayMs: ordered(merged.readDelayMs),
        thinkMs: ordered(merged.thinkMs),
        bubbleGapMs: ordered(merged.bubbleGapMs),
        typingMinMs: Math.min(merged.typingMinMs, merged.typingMaxMs),
        typingMaxMs: Math.max(merged.typingMinMs, merged.typingMaxMs),
    };
}

/** The realistic-text system note to inject, or null if none should be injected. */
export function resolveNote(config: Config, contact: ContactConfig | undefined): string | null {
    if (!config.realistic.injectNote) return null;
    if (effectivePreset(config, contact) === 'off') return null;
    const note = config.realistic.note.trim();
    return note === '' ? null : note;
}

/** Drop keys whose value is undefined, so spreading can't overwrite a preset value with undefined. */
function definedOnly<T extends object>(value: T | undefined): { [K in keyof T]?: Exclude<T[K], undefined> } {
    const result: { [K in keyof T]?: Exclude<T[K], undefined> } = {};
    if (!value) return result;
    for (const key of Object.keys(value) as (keyof T)[]) {
        const entry = value[key];
        if (entry !== undefined) result[key] = entry as Exclude<T[keyof T], undefined>;
    }
    return result;
}

function ordered(range: { min: number; max: number }): { min: number; max: number } {
    return range.min <= range.max ? range : { min: range.max, max: range.min };
}
