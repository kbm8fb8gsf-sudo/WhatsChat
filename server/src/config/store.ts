import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '../util/logger.js';
import { type Config, defaultConfig, parseConfig } from './schema.js';

export type SaveResult = { ok: true; config: Config } | { ok: false; issues: string[] };
type Listener = (next: Config, previous: Config) => void;

/**
 * Holds the current config in memory and persists it as JSON. Writes are atomic (temp file
 * then rename) and serialised, so concurrent saves can't interleave.
 */
export class ConfigStore {
    private current: Config = defaultConfig();
    private readonly listeners = new Set<Listener>();
    private writeChain: Promise<unknown> = Promise.resolve();
    private tempCounter = 0;

    constructor(
        private readonly filePath: string,
        private readonly logger: Logger,
    ) {}

    /** Load from disk. A missing file means defaults; an invalid one is set aside and replaced by defaults. */
    async load(): Promise<Config> {
        let text: string;
        try {
            text = await readFile(this.filePath, 'utf8');
        } catch (error) {
            if (isNotFound(error)) {
                this.current = defaultConfig();
                return this.current;
            }
            throw error;
        }

        let raw: unknown;
        try {
            raw = JSON.parse(text);
        } catch {
            await this.setAside('it is not valid JSON');
            this.current = defaultConfig();
            return this.current;
        }

        const parsed = parseConfig(raw);
        if (!parsed.ok) {
            await this.setAside(parsed.issues.join('; '));
            this.current = defaultConfig();
            return this.current;
        }
        this.current = parsed.config;
        return this.current;
    }

    get(): Config {
        return this.current;
    }

    /** Validate and persist a whole new config. The in-memory copy only changes if the write succeeds. */
    save(input: unknown): Promise<SaveResult> {
        return this.enqueue(() => this.commit(input));
    }

    /** Apply a change to the latest config. The updater receives a deep copy it may mutate. */
    update(updater: (draft: Config) => void): Promise<SaveResult> {
        return this.enqueue(() => {
            const draft = structuredClone(this.current);
            updater(draft);
            return this.commit(draft);
        });
    }

    onChange(listener: Listener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private enqueue<T>(task: () => Promise<T>): Promise<T> {
        const result = this.writeChain.then(task, task);
        this.writeChain = result.catch(() => undefined);
        return result;
    }

    private async commit(input: unknown): Promise<SaveResult> {
        const parsed = parseConfig(input);
        if (!parsed.ok) return parsed;
        await this.write(parsed.config);
        const previous = this.current;
        this.current = parsed.config;
        for (const listener of this.listeners) {
            try {
                listener(parsed.config, previous);
            } catch (error) {
                this.logger.error('Config listener failed', error);
            }
        }
        return { ok: true, config: parsed.config };
    }

    private async write(config: Config): Promise<void> {
        await mkdir(path.dirname(this.filePath), { recursive: true });
        const temp = `${this.filePath}.${String(process.pid)}.${String(++this.tempCounter)}.tmp`;
        // Mode 0600: the file contains phone numbers.
        await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
        await rename(temp, this.filePath);
    }

    private async setAside(reason: string): Promise<void> {
        const target = `${this.filePath}.invalid-${new Date().toISOString().replace(/[:.]/g, '-')}`;
        this.logger.warn(`Config file is unusable (${reason}). Moved it to ${target} and using defaults.`);
        try {
            await rename(this.filePath, target);
        } catch (error) {
            this.logger.error('Could not move the unusable config file aside', error);
        }
    }
}

function isNotFound(error: unknown): boolean {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
