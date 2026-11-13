// @ts-check
/**
 * Finds a Python interpreter that has graphify installed and runs short Python jobs with it.
 *
 * graphify is usually installed as a uv/pipx "tool", which puts the `graphify` command on
 * PATH but hides its Python in a private virtualenv. The `graphify` launcher script's first
 * line names that Python, so it is read from there. The path is never symlink-resolved:
 * a virtualenv's python is a symlink, and following it loses the virtualenv.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { errorMessage } from './util.js';

export const BRIDGE_SCRIPT = fileURLToPath(new URL('../python/gm_bridge.py', import.meta.url));

/**
 * @typedef {object} RunResult
 * @property {number | null} code
 * @property {string} stdout
 * @property {string} stderr
 * @property {boolean} timedOut
 */

/**
 * Runs a command (never through a shell) and collects its output.
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, timeoutMs: number, env?: NodeJS.ProcessEnv, spawn?: typeof nodeSpawn }} opts
 * @returns {Promise<RunResult>}
 */
export function run(command, args, opts) {
    const spawn = opts.spawn ?? nodeSpawn;
    return new Promise((resolve) => {
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let settled = false;
        /** @param {number | null} code */
        const finish = (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ code, stdout, stderr, timedOut });
        };
        let child;
        try {
            child = spawn(command, args, {
                cwd: opts.cwd,
                env: { ...process.env, ...opts.env, PYTHONIOENCODING: 'utf-8' },
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
            });
        } catch (err) {
            stderr = errorMessage(err);
            resolve({ code: null, stdout, stderr, timedOut });
            return;
        }
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill();
            finish(null);
        }, opts.timeoutMs);
        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        child.stdout?.on('data', (d) => {
            if (stdout.length < 4_000_000) stdout += d;
        });
        child.stderr?.on('data', (d) => {
            stderr = (stderr + d).slice(-8000);
        });
        child.on('error', (err) => {
            stderr += errorMessage(err);
            finish(null);
        });
        child.on('close', (code) => finish(code));
    });
}

/**
 * The bridge prints one JSON object as its last stdout line.
 * @param {RunResult} result
 * @returns {Record<string, any> | null}
 */
export function lastJsonLine(result) {
    const lines = result.stdout.trim().split('\n').reverse();
    for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('{')) continue;
        try {
            return JSON.parse(t);
        } catch {
            // keep looking
        }
    }
    return null;
}

/**
 * @param {RunResult} result
 * @param {string} what
 */
export function describeFailure(result, what) {
    const json = lastJsonLine(result);
    if (json && typeof json.error === 'string') return json.error;
    if (result.timedOut) return `${what} took too long and was stopped.`;
    const tail = result.stderr.trim().split('\n').slice(-2).join(' ').trim();
    return tail || `${what} failed (exit code ${result.code}).`;
}

/**
 * Interpreter named on a launcher's `#!` line. Handles `#!/usr/bin/env python3` and
 * uv/pipx's `#!/bin/sh` + `exec` trampolines.
 * @param {string} text first few hundred bytes of the launcher
 * @returns {string | null}
 */
export function interpreterFromLauncher(text) {
    const first = text.split('\n')[0] ?? '';
    if (first.startsWith('#!')) {
        const parts = first.slice(2).trim().split(/\s+/);
        const exe = parts[0] ?? '';
        if (path.basename(exe) === 'env') {
            const named = parts.slice(1).find((p) => !p.startsWith('-'));
            if (named && /python/i.test(named)) return named;
        } else if (/python/i.test(path.basename(exe))) {
            return exe;
        }
    }
    // Some installers write `#!/bin/sh` and then `'''exec' "/path/to/python" "$0" "$@"`.
    const m = text.match(/exec'?\s+"?([^"\s]*python[^"\s]*)"?\s+"\$0"/);
    return m?.[1] ?? null;
}

/**
 * Places to look for graphify's Python, best first.
 * @param {{ configured?: string | undefined, env: NodeJS.ProcessEnv, home: string, platform: NodeJS.Platform, readHead: (file: string) => Promise<string | null> }} ctx
 * @returns {Promise<string[]>}
 */
export async function candidatePythons(ctx) {
    /** @type {string[]} */
    const out = [];
    /** @param {string | null | undefined} p */
    const add = (p) => {
        if (p && !out.includes(p)) out.push(p);
    };
    add(ctx.configured);
    add(ctx.env.GRAPH_MEMORY_PYTHON);

    const win = ctx.platform === 'win32';
    const pathDirs = (ctx.env.PATH ?? ctx.env.Path ?? '').split(win ? ';' : ':').filter(Boolean);
    const extraDirs = win ? [] : [path.join(ctx.home, '.local', 'bin'), '/usr/local/bin', '/opt/homebrew/bin'];
    if (!win) {
        for (const dir of [...pathDirs, ...extraDirs]) {
            const head = await ctx.readHead(path.join(dir, 'graphify'));
            if (head) add(interpreterFromLauncher(head));
        }
    }

    // uv and pipx keep each tool in its own virtualenv.
    const venvs = win
        ? [
            path.join(ctx.env.APPDATA ?? path.join(ctx.home, 'AppData', 'Roaming'), 'uv', 'tools', 'graphifyy'),
            path.join(ctx.home, 'pipx', 'venvs', 'graphifyy'),
            path.join(ctx.env.LOCALAPPDATA ?? path.join(ctx.home, 'AppData', 'Local'), 'pipx', 'pipx', 'venvs', 'graphifyy'),
        ]
        : [
            path.join(ctx.env.XDG_DATA_HOME ?? path.join(ctx.home, '.local', 'share'), 'uv', 'tools', 'graphifyy'),
            path.join(ctx.home, '.local', 'share', 'pipx', 'venvs', 'graphifyy'),
            path.join(ctx.home, '.local', 'pipx', 'venvs', 'graphifyy'),
        ];
    for (const venv of venvs) add(win ? path.join(venv, 'Scripts', 'python.exe') : path.join(venv, 'bin', 'python'));

    if (win) {
        add('python');
        add('py');
    } else {
        add('python3');
        add('python');
    }
    return out;
}

/**
 * @typedef {object} GraphifyRuntime
 * @property {boolean} ok
 * @property {string} [python]        the command to run (as found, not resolved)
 * @property {string} [pythonVersion]
 * @property {string} [graphifyVersion]
 * @property {boolean} [mcp]           graphify's MCP server can run (the `mcp` extra is installed)
 * @property {string} [error]
 * @property {{ python: string, error: string }[]} tried
 * @property {string} checkedAt
 */

/**
 * @param {{ configured?: string | undefined, env?: NodeJS.ProcessEnv, home?: string, platform?: NodeJS.Platform, spawn?: typeof nodeSpawn, timeoutMs?: number }} [opts]
 * @returns {Promise<GraphifyRuntime>}
 */
export async function locateGraphify(opts = {}) {
    const env = opts.env ?? process.env;
    const candidates = await candidatePythons({
        configured: opts.configured,
        env,
        home: opts.home ?? os.homedir(),
        platform: opts.platform ?? process.platform,
        readHead: async (file) => {
            try {
                const handle = await fs.open(file, 'r');
                try {
                    const buf = Buffer.alloc(512);
                    const { bytesRead } = await handle.read(buf, 0, 512, 0);
                    return buf.subarray(0, bytesRead).toString('utf8');
                } finally {
                    await handle.close();
                }
            } catch {
                return null;
            }
        },
    });
    /** @type {{ python: string, error: string }[]} */
    const tried = [];
    for (const python of candidates) {
        const args = python === 'py' ? ['-3', BRIDGE_SCRIPT, 'probe'] : [BRIDGE_SCRIPT, 'probe'];
        const result = await run(python, args, { timeoutMs: opts.timeoutMs ?? 30_000, spawn: opts.spawn });
        const json = lastJsonLine(result);
        if (result.code === 0 && json?.ok) {
            return {
                ok: true,
                python,
                pythonVersion: String(json.pythonVersion ?? ''),
                graphifyVersion: String(json.graphifyVersion ?? ''),
                mcp: Boolean(json.mcp),
                tried,
                checkedAt: new Date().toISOString(),
            };
        }
        tried.push({ python, error: describeFailure(result, 'Probe') });
    }
    return {
        ok: false,
        error: 'graphify was not found. Install it with: uv tool install "graphifyy[mcp]"  (or: pipx install "graphifyy[mcp]")',
        tried,
        checkedAt: new Date().toISOString(),
    };
}

/**
 * Arguments that start Python for a given launcher (the Windows `py` launcher needs `-3`).
 * @param {string} python
 * @param {string[]} args
 */
export function pythonArgs(python, args) {
    return python === 'py' ? ['-3', ...args] : args;
}
