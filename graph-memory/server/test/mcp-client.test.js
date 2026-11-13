import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { McpClient, toolText } from '../mcp-client.js';
import { fakeExecutable, tempDir } from './helpers.js';

// A stand-in for graphify's MCP server: line-delimited JSON-RPC on stdin/stdout.
const FAKE_SERVER = String.raw`
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
let pinged = false;
process.stdout.write('not json, should be ignored\n');
rl.on('line', (line) => {
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
        send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: {}, serverInfo: { name: 'graphify', version: '9.9.9' } } });
    } else if (msg.method === 'notifications/initialized') {
        // a server-initiated request the client must answer
        send({ jsonrpc: '2.0', id: 'srv-1', method: 'ping' });
    } else if (msg.id === 'srv-1') {
        pinged = msg.result !== undefined;
    } else if (msg.method === 'tools/call') {
        const { name, arguments: args } = msg.params;
        if (args.question === 'crash') process.exit(3);
        if (args.question === 'hang') return;
        if (args.question === 'pinged?') return send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: String(pinged) }] } });
        send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: name + ':' + args.question }, { type: 'image', data: '' }] } });
    } else if (msg.id !== undefined) {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'nope' } });
    }
});
`;

describe('McpClient', () => {
    /** @type {string} */
    let server;
    /** @type {McpClient | null} */
    let client = null;

    beforeAll(async () => {
        server = await fakeExecutable(await tempDir(), 'fake-mcp.cjs', FAKE_SERVER);
    });

    afterEach(() => client?.close());

    it('performs the handshake and calls tools', async () => {
        client = new McpClient({ command: process.execPath, args: [server] });
        const result = await client.callTool('query_graph', { question: 'who is Kai?' });
        expect(toolText(result)).toBe('query_graph:who is Kai?');
        expect(client.serverInfo?.version).toBe('9.9.9');
    });

    it('answers requests the server sends', async () => {
        client = new McpClient({ command: process.execPath, args: [server] });
        await client.start();
        await new Promise((r) => setTimeout(r, 100));
        expect(toolText(await client.callTool('x', { question: 'pinged?' }))).toBe('true');
    });

    it('turns JSON-RPC errors into exceptions', async () => {
        client = new McpClient({ command: process.execPath, args: [server] });
        await client.start();
        await expect(client.request('unknown/method', {}, 2000)).rejects.toThrow(/nope/);
    });

    it('times out a call that never returns', async () => {
        client = new McpClient({ command: process.execPath, args: [server] });
        await expect(client.callTool('x', { question: 'hang' }, 200)).rejects.toThrow(/did not answer/);
    });

    it('fails pending calls when the server dies, then restarts on a later call', async () => {
        let now = 0;
        client = new McpClient({ command: process.execPath, args: [server], restartDelayMs: 1000, now: () => now });
        await expect(client.callTool('x', { question: 'crash' })).rejects.toThrow(/exited \(3\)/);
        expect(client.running).toBe(false);
        await expect(client.callTool('x', { question: 'again' })).rejects.toThrow(/retrying/);
        now = 5000;
        expect(toolText(await client.callTool('x', { question: 'again' }))).toBe('x:again');
    });

    it('reports a command that cannot start', async () => {
        client = new McpClient({ command: '/nonexistent/python', args: [] });
        await expect(client.callTool('x', {})).rejects.toThrow(/could not start|not running/);
    });

    it('refuses calls after close', async () => {
        client = new McpClient({ command: process.execPath, args: [server] });
        client.close();
        await expect(client.callTool('x', {})).rejects.toThrow(/closed/);
    });
});
