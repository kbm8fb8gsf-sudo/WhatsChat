// @ts-check
/**
 * SillyTavern server plugin entry point (loaded from package.json "main").
 * Exports `info`, `init(router)` and `exit()`, as SillyTavern expects.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GraphifyService } from './graphify.js';
import { GraphCache } from './render.js';
import { registerRoutes } from './routes.js';
import { MemoryStore } from './store.js';
import { consoleLogger, errorMessage, readJson } from './util.js';

const PLUGIN_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const info = {
    id: 'graph-memory',
    name: 'Graph Memory',
    description: 'Long-term memory for characters, stored as a graphify knowledge graph.',
};

/** @type {GraphifyService | null} */
let service = null;

/**
 * @param {import('express').Router} router
 * @param {{ dataDir?: string, logger?: import('./util.js').Logger }} [options]
 */
export async function init(router, options = {}) {
    const logger = options.logger ?? consoleLogger;
    const dataDir = options.dataDir ?? process.env.GRAPH_MEMORY_DATA_DIR ?? path.join(PLUGIN_DIR, 'data');
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });

    // The Python path is set on the server only (data/config.json or GRAPH_MEMORY_PYTHON),
    // never over HTTP: choosing which program the server runs is not a browser setting.
    const config = await readJson(path.join(dataDir, 'config.json'), {}).catch((err) => {
        logger.warn(`Ignoring data/config.json: ${errorMessage(err)}`);
        return {};
    });
    const pkg = await readJson(path.join(PLUGIN_DIR, 'package.json'), {});

    const store = new MemoryStore(dataDir);
    service = new GraphifyService({
        store,
        workDir: path.join(dataDir, 'mcp'),
        logger,
        configuredPython: typeof config?.python === 'string' && config.python ? config.python : undefined,
    });
    registerRoutes(router, { store, graphify: service, graphs: new GraphCache(), logger, version: String(pkg?.version ?? '') });

    // Look for graphify in the background so SillyTavern's start-up isn't held up.
    void service.runtime().catch((err) => logger.error(errorMessage(err)));
    logger.info('Loaded.');
}

export async function exit() {
    service?.close();
    service = null;
}
