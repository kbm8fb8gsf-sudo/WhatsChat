import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Logger } from '../util/logger.js';

export interface Login {
    username: string;
    password: string;
}

const loginSchema = z.object({ username: z.string().max(200), password: z.string().max(500) });

/**
 * SillyTavern login for the hidden browser, kept in its own 0600 file so the password never
 * appears in config.json or in any API response.
 */
export class LoginStore {
    private current: Login | null = null;

    constructor(
        private readonly filePath: string,
        private readonly logger: Logger,
    ) {}

    async load(): Promise<void> {
        try {
            const parsed = loginSchema.safeParse(JSON.parse(await readFile(this.filePath, 'utf8')));
            this.current = parsed.success && parsed.data.username !== '' ? parsed.data : null;
        } catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
                this.logger.warn('Could not read the saved SillyTavern login', error);
            }
            this.current = null;
        }
    }

    get(): Login | null {
        return this.current;
    }

    /** What the panel may see: never the password itself. */
    describe(): { username: string; passwordSet: boolean } {
        return { username: this.current?.username ?? '', passwordSet: Boolean(this.current?.password) };
    }

    /**
     * Save a login. A blank password keeps the saved one for the same username; a blank
     * username forgets the login.
     */
    async set(username: string, password: string | undefined): Promise<void> {
        const name = username.trim();
        if (name === '') {
            this.current = null;
            await rm(this.filePath, { force: true });
            return;
        }
        const kept = this.current?.username === name ? this.current.password : '';
        const next = { username: name, password: password || kept };
        await mkdir(path.dirname(this.filePath), { recursive: true });
        const temp = `${this.filePath}.${String(process.pid)}.tmp`;
        await writeFile(temp, JSON.stringify(next), { encoding: 'utf8', mode: 0o600 });
        await rename(temp, this.filePath);
        this.current = next;
    }
}
