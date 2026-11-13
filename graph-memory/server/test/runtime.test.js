import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { candidatePythons, describeFailure, interpreterFromLauncher, lastJsonLine, locateGraphify, pythonArgs, run } from '../runtime.js';
import { fakeExecutable, tempDir } from './helpers.js';

describe('interpreterFromLauncher', () => {
    it.each([
        ['#!/home/u/.local/share/uv/tools/graphifyy/bin/python\nimport sys', '/home/u/.local/share/uv/tools/graphifyy/bin/python'],
        ['#!/usr/bin/env python3\n', 'python3'],
        ['#!/usr/bin/env -S python3.12 -u\n', 'python3.12'],
        ['#!/bin/sh\n\'\'\'exec\' "/opt/venv/bin/python3" "$0" "$@"\n\' \'\'\'', '/opt/venv/bin/python3'],
        ['#!/bin/bash\necho hi', null],
        ['', null],
    ])('%j -> %j', (text, expected) => {
        expect(interpreterFromLauncher(text)).toBe(expected);
    });
});

describe('candidatePythons', () => {
    it('puts the configured python first, then launchers, tool venvs and system pythons', async () => {
        const heads = { '/bin1/graphify': '#!/venv/bin/python\n', '/home/u/.local/bin/graphify': '#!/venv/bin/python\n' };
        const out = await candidatePythons({
            configured: '/my/python',
            env: { PATH: '/bin1:/bin2', GRAPH_MEMORY_PYTHON: '/env/python' },
            home: '/home/u',
            platform: 'linux',
            readHead: async (f) => heads[/** @type {keyof typeof heads} */ (f)] ?? null,
        });
        expect(out).toEqual([
            '/my/python',
            '/env/python',
            '/venv/bin/python',
            path.join('/home/u', '.local', 'share', 'uv', 'tools', 'graphifyy', 'bin', 'python'),
            path.join('/home/u', '.local', 'share', 'pipx', 'venvs', 'graphifyy', 'bin', 'python'),
            path.join('/home/u', '.local', 'pipx', 'venvs', 'graphifyy', 'bin', 'python'),
            'python3',
            'python',
        ]);
    });

    it('uses Windows locations on Windows', async () => {
        const out = await candidatePythons({ env: { APPDATA: 'C:\\AppData' }, home: 'C:\\Users\\u', platform: 'win32', readHead: async () => null });
        expect(out.at(-2)).toBe('python');
        expect(out.at(-1)).toBe('py');
        expect(out[0]).toContain('graphifyy');
        expect(pythonArgs('py', ['x'])).toEqual(['-3', 'x']);
    });
});

describe('run / lastJsonLine', () => {
    it('collects output and reads the last JSON line', async () => {
        const r = await run(process.execPath, ['-e', 'console.log("log"); console.log(JSON.stringify({ok:true,n:1}))'], { timeoutMs: 5000 });
        expect(r.code).toBe(0);
        expect(lastJsonLine(r)).toEqual({ ok: true, n: 1 });
    });

    it('times out', async () => {
        const r = await run(process.execPath, ['-e', 'setTimeout(()=>{}, 10000)'], { timeoutMs: 100 });
        expect(r.timedOut).toBe(true);
        expect(describeFailure(r, 'Job')).toMatch(/took too long/);
    });

    it('reports a missing program', async () => {
        const r = await run('/nonexistent/python', [], { timeoutMs: 1000 });
        expect(r.code).toBeNull();
        expect(describeFailure(r, 'Job')).toMatch(/ENOENT/);
    });

    it('prefers the bridge\'s own error message', () => {
        expect(describeFailure({ code: 1, stdout: '{"ok":false,"error":"boom"}\n', stderr: 'trace', timedOut: false }, 'Job')).toBe('boom');
    });
});

describe('locateGraphify', () => {
    it('returns the first interpreter whose probe succeeds', async () => {
        const dir = await tempDir();
        const bad = await fakeExecutable(dir, 'bad-python', 'console.log(JSON.stringify({ ok: false, error: "No module named graphify" })); process.exit(1);');
        const good = await fakeExecutable(dir, 'good-python', 'console.log(JSON.stringify({ ok: true, python: "x", pythonVersion: "3.12.1", graphifyVersion: "0.9.108", mcp: true }));');
        const rt = await locateGraphify({ configured: bad, env: { GRAPH_MEMORY_PYTHON: good, PATH: '' }, home: dir, platform: 'linux' });
        expect(rt).toMatchObject({ ok: true, python: good, graphifyVersion: '0.9.108', mcp: true, pythonVersion: '3.12.1' });
        expect(rt.tried).toEqual([{ python: bad, error: 'No module named graphify' }]);
    });

    it('explains how to install graphify when nothing works', async () => {
        const dir = await tempDir();
        const rt = await locateGraphify({ configured: path.join(dir, 'missing'), env: { PATH: '' }, home: dir, platform: 'linux', timeoutMs: 2000 });
        expect(rt.ok).toBe(false);
        expect(rt.error).toMatch(/uv tool install "graphifyy\[mcp\]"/);
        expect(rt.tried.length).toBeGreaterThan(0);
    });
});
