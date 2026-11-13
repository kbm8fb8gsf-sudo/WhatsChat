// @ts-check
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * @typedef {object} Logger
 * @property {(msg: string, ...rest: unknown[]) => void} info
 * @property {(msg: string, ...rest: unknown[]) => void} warn
 * @property {(msg: string, ...rest: unknown[]) => void} error
 */

/** @type {Logger} */
export const consoleLogger = {
    info: (msg, ...rest) => console.log(`[Graph Memory] ${msg}`, ...rest),
    warn: (msg, ...rest) => console.warn(`[Graph Memory] ${msg}`, ...rest),
    error: (msg, ...rest) => console.error(`[Graph Memory] ${msg}`, ...rest),
};

/** @type {Logger} */
export const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

/** @param {string} text */
export function sha256(text) {
    return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Writes JSON (or text) so readers never see a half-written file: temp file in the same
 * folder, then rename. Files are only readable by the user that runs SillyTavern.
 * @param {string} file
 * @param {unknown} data
 */
export async function writeJsonAtomic(file, data) {
    await writeTextAtomic(file, JSON.stringify(data, null, 2) + '\n');
}

/**
 * @param {string} file
 * @param {string} text
 */
export async function writeTextAtomic(file, text) {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    try {
        await fs.writeFile(tmp, text, { encoding: 'utf8', mode: 0o600 });
        await fs.rename(tmp, file);
    } finally {
        await fs.rm(tmp, { force: true });
    }
}

/**
 * @template T
 * @param {string} file
 * @param {T} fallback
 * @returns {Promise<T | any>}
 */
export async function readJson(file, fallback) {
    try {
        return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (err) {
        if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return fallback;
        throw err;
    }
}

/** @param {string} file */
export async function exists(file) {
    try {
        await fs.access(file);
        return true;
    } catch {
        return false;
    }
}

/**
 * Serialises async work per key, so two requests for the same memory never interleave
 * their file changes.
 */
export class KeyedLock {
    constructor() {
        /** @type {Map<string, Promise<unknown>>} */
        this.tails = new Map();
    }

    /**
     * @template T
     * @param {string} key
     * @param {() => Promise<T>} fn
     * @returns {Promise<T>}
     */
    run(key, fn) {
        const prev = this.tails.get(key) ?? Promise.resolve();
        const next = prev.then(fn, fn);
        const tail = next.catch(() => {});
        this.tails.set(key, tail);
        void tail.then(() => {
            if (this.tails.get(key) === tail) this.tails.delete(key);
        });
        return next;
    }
}

/**
 * @param {unknown} err
 * @returns {string}
 */
export function errorMessage(err) {
    if (err instanceof Error) return err.message;
    return String(err);
}
