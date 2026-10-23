// @ts-check
import { vi } from 'vitest';

/**
 * A fake Bridge that records what the batch processor asks SillyTavern to do.
 * @param {Partial<import('../st-bridge.js').Bridge>} [overrides]
 */
export function fakeBridge(overrides = {}) {
    /** @type {string[]} */
    const log = [];
    /** @type {import('../st-bridge.js').Bridge} */
    const bridge = {
        requestHeaders: () => ({ 'X-CSRF-Token': 'token' }),
        listCharacters: () => [
            { avatar: 'Seraphina.png', name: 'Seraphina' },
            { avatar: 'Sensei.png', name: 'Coding Sensei' },
        ],
        listChats: vi.fn(() => Promise.resolve(['Seraphina - WhatsApp', 'Seraphina - old'])),
        getActiveChat: () => ({ kind: 'character', characterAvatar: 'Other.png', chatFile: 'Other - chat' }),
        waitUntilIdle: vi.fn(() => {
            log.push('waitUntilIdle');
            return Promise.resolve();
        }),
        openChat: vi.fn((target) => {
            log.push(`openChat ${target.characterAvatar} ${String(target.chatFile)}`);
            return Promise.resolve({ chatFile: target.chatFile ?? 'Seraphina - new', characterName: 'Seraphina' });
        }),
        addUserMessage: vi.fn((text) => {
            log.push(`addUserMessage ${text}`);
            return Promise.resolve();
        }),
        setNote: vi.fn((note) => {
            log.push(`setNote ${note}`);
        }),
        clearNote: vi.fn(() => {
            log.push('clearNote');
        }),
        generateReply: vi.fn(() => {
            log.push('generateReply');
            return Promise.resolve('Seraphina: hello!');
        }),
        restoreChat: vi.fn((previous) => {
            log.push(`restoreChat ${previous ? String(previous.chatFile) : 'none'}`);
            return Promise.resolve();
        }),
        userName: () => 'Lewis',
        notify: vi.fn(),
        onReady: (callback) => {
            callback();
        },
        reloadChatIfOpen: vi.fn(() => Promise.resolve(true)),
        reloadOpenChat: vi.fn(() => {
            log.push('reloadOpenChat');
            return Promise.resolve();
        }),
        onSillyTavernChange: vi.fn(),
        ...overrides,
    };
    return { bridge, log };
}

/**
 * @param {Partial<import('../api-client.js').BatchView>} [overrides]
 * @returns {import('../api-client.js').BatchView}
 */
export function batch(overrides = {}) {
    return {
        id: 'batch-1',
        contactId: '+447700900123',
        contactLabel: 'Alice',
        pushName: 'Al',
        characterAvatar: 'Seraphina.png',
        chatFile: 'Seraphina - WhatsApp',
        text: 'hey\nyou there?',
        note: 'You are texting.',
        messageCount: 2,
        receivedAt: 0,
        ...overrides,
    };
}
