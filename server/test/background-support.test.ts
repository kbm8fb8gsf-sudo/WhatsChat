import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LoginStore } from '../src/background/login-store.js';
import { isLoginPage, localServerUrl } from '../src/background/server-url.js';
import { silentLogger } from '../src/util/logger.js';

describe('localServerUrl', () => {
    it.each([
        ['http://localhost:8000', 'http://127.0.0.1:8000/'],
        ['http://127.0.0.1:8000/', 'http://127.0.0.1:8000/'],
        ['https://st.example.com:8443', 'https://127.0.0.1:8443/'],
        ['http://[::1]:8000', 'http://[::1]:8000/'],
        ['https://example.com', 'https://127.0.0.1:443/'],
        ['http://example.com', 'http://127.0.0.1:80/'],
    ])('turns %s into %s', (input, expected) => {
        expect(localServerUrl(input)).toBe(expected);
    });

    it('rejects nonsense', () => {
        expect(localServerUrl('not a url')).toBeNull();
        expect(localServerUrl('ftp://127.0.0.1:21')).toBeNull();
    });
});

describe('isLoginPage', () => {
    it('recognises SillyTavern’s login page', () => {
        expect(isLoginPage('http://127.0.0.1:8000/login')).toBe(true);
        expect(isLoginPage('http://127.0.0.1:8000/login/')).toBe(true);
        expect(isLoginPage('http://127.0.0.1:8000/')).toBe(false);
        expect(isLoginPage('about:blank')).toBe(false);
    });
});

describe('LoginStore', () => {
    let dir: string;
    let file: string;

    beforeEach(async () => {
        dir = await mkdtemp(path.join(os.tmpdir(), 'whatschat-login-'));
        file = path.join(dir, 'background-login.json');
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it('starts empty and never reveals the password', async () => {
        const store = new LoginStore(file, silentLogger);
        await store.load();
        expect(store.get()).toBeNull();
        await store.set('lewis', 'secret');
        expect(store.describe()).toEqual({ username: 'lewis', passwordSet: true });
        expect(JSON.stringify(store.describe())).not.toContain('secret');
    });

    it('persists privately and reloads', async () => {
        const store = new LoginStore(file, silentLogger);
        await store.set('lewis', 'secret');
        expect((await stat(file)).mode & 0o777).toBe(0o600);
        const again = new LoginStore(file, silentLogger);
        await again.load();
        expect(again.get()).toEqual({ username: 'lewis', password: 'secret' });
        expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ username: 'lewis', password: 'secret' });
    });

    it('keeps the saved password when only the username is resent', async () => {
        const store = new LoginStore(file, silentLogger);
        await store.set('lewis', 'secret');
        await store.set('lewis', undefined);
        expect(store.get()?.password).toBe('secret');
        await store.set('lewis', '');
        expect(store.get()?.password).toBe('secret');
        await store.set('someone-else', undefined);
        expect(store.get()).toEqual({ username: 'someone-else', password: '' });
    });

    it('forgets the login when the username is cleared', async () => {
        const store = new LoginStore(file, silentLogger);
        await store.set('lewis', 'secret');
        await store.set('  ', undefined);
        expect(store.get()).toBeNull();
        await expect(stat(file)).rejects.toThrow();
    });
});
