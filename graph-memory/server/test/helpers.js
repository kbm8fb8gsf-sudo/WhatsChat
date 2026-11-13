import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** @param {string} prefix */
export async function tempDir(prefix = 'gm-test-') {
    return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * A StoredSegment for merge/store tests.
 * @param {Partial<import('../merge.js').StoredSegment>} over
 * @returns {import('../merge.js').StoredSegment}
 */
export function segment(over) {
    const from = over.from ?? 0;
    const to = over.to ?? from + 8;
    const chatKey = over.chatKey ?? 'aaaaaaaaaaaa';
    return {
        id: `${chatKey}_${from}_${to}`,
        chatId: over.chatId ?? 'chat-1',
        chatKey,
        chatLabel: over.chatLabel ?? 'Chat 1',
        from,
        to,
        fingerprint: 'f',
        createdAt: over.createdAt ?? '2026-01-01T00:00:00.000Z',
        sourceFile: `corpus/${chatKey}_${from}_${to}.md`,
        entities: [],
        relations: [],
        ...over,
    };
}

/**
 * Writes an executable Node script and returns its path, to stand in for Python.
 * @param {string} dir
 * @param {string} name
 * @param {string} body
 */
export async function fakeExecutable(dir, name, body) {
    const file = path.join(dir, name);
    await fs.writeFile(file, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
    return file;
}
