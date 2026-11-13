// @ts-check
/**
 * On-disk layout of the memories. Each memory (one chat, one character or one group,
 * depending on the user's choice) is a folder that graphify treats as a project:
 *
 *   data/users/<user>/<scope>/
 *     meta.json            label and timestamps
 *     segments/<id>.json   facts extracted from one slice of a chat
 *     corpus/<id>.md       that slice's transcript (what graphify's source_file points at)
 *     extraction.json      all segments merged, in graphify's extraction format
 *     graphify-out/        graph.json and graph.html, written by graphify
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { mergeSegments, topEntities } from './merge.js';
import { SCOPE_ID_RE, USER_HANDLE_RE } from './normalize.js';
import { KeyedLock, readJson, sha256, writeJsonAtomic, writeTextAtomic } from './util.js';

/**
 * @typedef {import('./merge.js').StoredSegment} StoredSegment
 * @typedef {import('./normalize.js').SegmentInput} SegmentInput
 */

/**
 * @typedef {object} ScopeMeta
 * @property {string} scope
 * @property {string} label
 * @property {string} createdAt
 * @property {string} updatedAt
 */

export class MemoryStore {
    /**
     * @param {string} rootDir
     * @param {() => Date} [now]
     */
    constructor(rootDir, now = () => new Date()) {
        this.rootDir = rootDir;
        this.now = now;
        this.lock = new KeyedLock();
    }

    /**
     * @param {string} user
     * @param {string} scope
     * @returns {string}
     */
    dir(user, scope) {
        if (!USER_HANDLE_RE.test(user)) throw new Error('Invalid user');
        if (!SCOPE_ID_RE.test(scope)) throw new Error('Invalid memory id');
        return path.join(this.rootDir, 'users', user, scope);
    }

    /**
     * @param {string} user
     * @param {string} scope
     * @param {() => Promise<any>} fn
     */
    locked(user, scope, fn) {
        return this.lock.run(this.dir(user, scope), fn);
    }

    /**
     * @param {string} user
     * @param {string} scope
     * @returns {Promise<ScopeMeta | null>}
     */
    async meta(user, scope) {
        return readJson(path.join(this.dir(user, scope), 'meta.json'), null);
    }

    /**
     * @param {string} user
     * @param {string} scope
     * @returns {Promise<StoredSegment[]>}
     */
    async segments(user, scope) {
        const dir = path.join(this.dir(user, scope), 'segments');
        let names;
        try {
            names = await fs.readdir(dir);
        } catch {
            return [];
        }
        /** @type {StoredSegment[]} */
        const out = [];
        for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
            const seg = await readJson(path.join(dir, name), null);
            if (seg && typeof seg.id === 'string') out.push(seg);
        }
        return out;
    }

    /**
     * Which message ranges of a chat are already remembered.
     * @param {string} user
     * @param {string} scope
     * @param {string} chatId
     */
    async chatSegments(user, scope, chatId) {
        const key = chatKey(chatId);
        return (await this.segments(user, scope))
            .filter((s) => s.chatKey === key)
            .map((s) => ({ id: s.id, from: s.from, to: s.to, fingerprint: s.fingerprint, entities: s.entities.length, relations: s.relations.length }))
            .sort((a, b) => a.from - b.from);
    }

    /**
     * Stores one extracted slice. Older slices of the same chat that overlap it are replaced,
     * so re-reading part of a chat never leaves stale or duplicated facts behind.
     * @param {string} user
     * @param {string} scope
     * @param {SegmentInput} input
     * @returns {Promise<StoredSegment>}
     */
    addSegment(user, scope, input) {
        return this.locked(user, scope, async () => {
            const dir = this.dir(user, scope);
            const key = chatKey(input.chatId);
            const id = `${key}_${pad(input.from)}_${pad(input.to)}`;
            const sourceFile = `corpus/${id}.md`;
            const createdAt = this.now().toISOString();

            for (const old of await this.segments(user, scope)) {
                if (old.chatKey === key && old.from < input.to && input.from < old.to) {
                    await this.removeSegmentFiles(dir, old.id);
                }
            }

            /** @type {StoredSegment} */
            const seg = {
                id,
                chatId: input.chatId,
                chatKey: key,
                chatLabel: input.chatLabel,
                from: input.from,
                to: input.to,
                fingerprint: input.fingerprint,
                createdAt,
                sourceFile,
                entities: input.entities,
                relations: input.relations,
            };
            const header = `# ${input.chatLabel}: messages #${input.from}–#${input.to - 1}\n\n`;
            await writeTextAtomic(path.join(dir, sourceFile), header + input.transcript.trim() + '\n');
            await writeJsonAtomic(path.join(dir, 'segments', `${id}.json`), seg);

            const meta = (await this.meta(user, scope)) ?? { scope, label: '', createdAt, updatedAt: createdAt };
            if (input.scopeLabel) meta.label = input.scopeLabel;
            meta.updatedAt = createdAt;
            await writeJsonAtomic(path.join(dir, 'meta.json'), meta);
            return seg;
        });
    }

    /**
     * @param {string} dir
     * @param {string} id
     */
    async removeSegmentFiles(dir, id) {
        if (!/^[a-f0-9]+_\d+_\d+$/.test(id)) return;
        await fs.rm(path.join(dir, 'segments', `${id}.json`), { force: true });
        await fs.rm(path.join(dir, 'corpus', `${id}.md`), { force: true });
    }

    /**
     * Forgets some (or all) remembered slices of one chat.
     * @param {string} user
     * @param {string} scope
     * @param {string} chatId
     * @param {string[] | null} ids  null forgets the whole chat
     * @returns {Promise<number>} how many slices were removed
     */
    forget(user, scope, chatId, ids) {
        return this.locked(user, scope, async () => {
            const dir = this.dir(user, scope);
            const key = chatKey(chatId);
            let removed = 0;
            for (const seg of await this.segments(user, scope)) {
                if (seg.chatKey !== key) continue;
                if (ids && !ids.includes(seg.id)) continue;
                await this.removeSegmentFiles(dir, seg.id);
                removed++;
            }
            return removed;
        });
    }

    /**
     * Merges every slice into graphify's extraction format, ready for a build.
     * @param {string} user
     * @param {string} scope
     * @returns {Promise<{ file: string, nodes: number, edges: number }>}
     */
    writeExtraction(user, scope) {
        return this.locked(user, scope, async () => {
            const dir = this.dir(user, scope);
            const extraction = mergeSegments(await this.segments(user, scope));
            const file = path.join(dir, 'extraction.json');
            await writeJsonAtomic(file, extraction);
            return { file, nodes: extraction.nodes.length, edges: extraction.edges.length };
        });
    }

    /**
     * @param {string} user
     * @param {string} scope
     * @param {number} limit
     */
    async knownEntities(user, scope, limit) {
        return topEntities(await this.segments(user, scope), limit);
    }

    /**
     * @param {string} user
     * @param {string} scope
     */
    graphFile(user, scope) {
        return path.join(this.dir(user, scope), 'graphify-out', 'graph.json');
    }

    /**
     * @param {string} user
     * @param {string} scope
     */
    htmlFile(user, scope) {
        return path.join(this.dir(user, scope), 'graphify-out', 'graph.html');
    }

    /**
     * @param {string} user
     * @param {string} scope
     */
    deleteScope(user, scope) {
        return this.locked(user, scope, async () => {
            await fs.rm(this.dir(user, scope), { recursive: true, force: true });
        });
    }

    /**
     * Every memory this user has, newest first.
     * @param {string} user
     * @returns {Promise<(ScopeMeta & { segments: number })[]>}
     */
    async list(user) {
        if (!USER_HANDLE_RE.test(user)) throw new Error('Invalid user');
        const base = path.join(this.rootDir, 'users', user);
        let names;
        try {
            names = await fs.readdir(base);
        } catch {
            return [];
        }
        const out = [];
        for (const scope of names.filter((n) => SCOPE_ID_RE.test(n))) {
            const meta = await this.meta(user, scope);
            if (!meta) continue;
            let count = 0;
            try {
                count = (await fs.readdir(path.join(base, scope, 'segments'))).filter((n) => n.endsWith('.json')).length;
            } catch {
                // no segments yet
            }
            out.push({ ...meta, segments: count });
        }
        return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    }
}

/**
 * Chat file names can hold any characters, so they're hashed for use in file names.
 * @param {string} chatId
 */
export function chatKey(chatId) {
    return sha256(chatId).slice(0, 12);
}

/** @param {number} n */
function pad(n) {
    return String(n).padStart(6, '0');
}
