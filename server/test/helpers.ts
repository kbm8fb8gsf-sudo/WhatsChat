import { type Config, parseConfig } from '../src/config/schema.js';
import type { SaveResult } from '../src/config/store.js';
import type { ConfigSource } from '../src/core/bridge-service.js';

export function makeConfig(input: unknown): Config {
    const result = parseConfig(input);
    if (!result.ok) throw new Error(result.issues.join('; '));
    return result.config;
}

/** ConfigSource kept in memory, validating updates like ConfigStore does. */
export class MemoryConfig implements ConfigSource {
    private readonly listeners = new Set<(next: Config, previous: Config) => void>();

    constructor(private config: Config) {}

    get(): Config {
        return this.config;
    }

    update(updater: (draft: Config) => void): Promise<SaveResult> {
        const draft = structuredClone(this.config);
        updater(draft);
        return Promise.resolve(this.set(draft));
    }

    set(input: unknown): SaveResult {
        const result = parseConfig(input);
        if (!result.ok) return result;
        const previous = this.config;
        this.config = result.config;
        for (const listener of this.listeners) listener(result.config, previous);
        return result;
    }

    onChange(listener: (next: Config, previous: Config) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
}

export function idSequence(prefix = 'batch'): () => string {
    let n = 0;
    return () => `${prefix}-${String(++n)}`;
}
