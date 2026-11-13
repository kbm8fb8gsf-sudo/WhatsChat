// @ts-check
/**
 * graphify picks *which* memories are relevant (keyword scoring plus a walk through the
 * graph). Its answer is written for coding assistants (`NODE … [src=… loc=…]`, `EDGE …`), so
 * this module reads the chosen entities out of that answer and writes them up as plain
 * story notes for the character, using the full details stored in graph.json.
 */
import { promises as fs } from 'node:fs';

/**
 * @typedef {object} GraphNode
 * @property {string} id
 * @property {string} label
 * @property {{ kind?: string, description?: string, earlier?: string[], aliases?: string[], last_seen?: string }} [attributes]
 * @property {number} [community]
 * @property {string} [community_name]
 */

/**
 * @typedef {object} GraphLink
 * @property {string} source
 * @property {string} target
 * @property {string} [relation]
 * @property {{ relation: string, detail?: string, at?: string }[]} [relations]
 */

/**
 * @typedef {object} LoadedGraph
 * @property {Map<string, GraphNode>} nodes
 * @property {Map<string, string[]>} byLabel  lower-cased label -> node ids
 * @property {GraphLink[]} links
 * @property {Map<string, GraphLink[]>} linksOf node id -> links touching it
 */

/**
 * @param {unknown} data parsed graph.json
 * @returns {LoadedGraph}
 */
export function indexGraph(data) {
    const obj = /** @type {{ nodes?: unknown, links?: unknown, edges?: unknown }} */ (data ?? {});
    /** @type {Map<string, GraphNode>} */
    const nodes = new Map();
    /** @type {Map<string, string[]>} */
    const byLabel = new Map();
    for (const raw of Array.isArray(obj.nodes) ? obj.nodes : []) {
        if (!raw || typeof raw.id !== 'string') continue;
        const node = /** @type {GraphNode} */ ({ ...raw, label: typeof raw.label === 'string' ? raw.label : raw.id });
        nodes.set(node.id, node);
        const key = labelKey(node.label);
        byLabel.set(key, [...(byLabel.get(key) ?? []), node.id]);
    }
    const rawLinks = Array.isArray(obj.links) ? obj.links : Array.isArray(obj.edges) ? obj.edges : [];
    /** @type {GraphLink[]} */
    const links = rawLinks.filter((l) => l && nodes.has(l.source) && nodes.has(l.target));
    /** @type {Map<string, GraphLink[]>} */
    const linksOf = new Map();
    for (const l of links) {
        for (const end of [l.source, l.target]) linksOf.set(end, [...(linksOf.get(end) ?? []), l]);
    }
    return { nodes, byLabel, links, linksOf };
}

/** graphify strips control characters and caps labels; match on the same footing. */
/** @param {string} label */
function labelKey(label) {
    // eslint-disable-next-line no-control-regex
    return label.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, 256).trim().toLowerCase();
}

/**
 * Reads the entity labels graphify chose, in its order of relevance.
 * @param {string} text graphify `query_graph` / `graphify query` output
 * @returns {string[]}
 */
export function parseGraphifyLabels(text) {
    /** @type {string[]} */
    const labels = [];
    for (const line of text.split('\n')) {
        if (!line.startsWith('NODE ')) continue;
        const end = line.indexOf(' [src=');
        const label = (end > 0 ? line.slice(5, end) : line.slice(5)).trim();
        if (label && !labels.includes(label)) labels.push(label);
    }
    return labels;
}

/**
 * @param {LoadedGraph} graph
 * @param {string[]} labels
 * @returns {string[]} node ids, in the same order, unknown labels dropped
 */
export function labelsToIds(graph, labels) {
    /** @type {string[]} */
    const ids = [];
    for (const label of labels) {
        for (const id of graph.byLabel.get(labelKey(label)) ?? []) {
            if (!ids.includes(id)) ids.push(id);
        }
    }
    return ids;
}

/** @param {string} relation */
function humanRelation(relation) {
    return relation.replace(/_/g, ' ').trim();
}

/**
 * @param {GraphNode} node
 * @param {boolean} withHistory
 */
function entityLine(node, withHistory) {
    const a = node.attributes ?? {};
    const kind = a.kind && a.kind !== 'thing' ? ` (${a.kind})` : '';
    const aka = a.aliases?.length ? `, also called ${a.aliases.slice(0, 3).join(', ')}` : '';
    let line = `• ${node.label}${kind}${aka}`;
    if (a.description) line += `: ${a.description}`;
    if (withHistory && a.earlier?.length) line += ` (Earlier: ${a.earlier[0]})`;
    return line;
}

/**
 * @param {LoadedGraph} graph
 * @param {GraphLink} link
 * @returns {string[]}
 */
function relationLines(graph, link) {
    const src = graph.nodes.get(link.source)?.label ?? link.source;
    const tgt = graph.nodes.get(link.target)?.label ?? link.target;
    const entries = link.relations?.length ? link.relations : link.relation ? [{ relation: link.relation }] : [];
    return entries.map((r) => {
        const detail = r.detail ? ` (${r.detail})` : '';
        return `   – ${src} ${humanRelation(r.relation)} ${tgt}${detail}`;
    });
}

/**
 * Writes the chosen entities up as memory notes, most relevant first. Each entity is
 * followed by its relationships with the entities already listed, so the most important
 * connections survive when the budget runs out.
 * @param {LoadedGraph} graph
 * @param {string[]} ids
 * @param {{ maxChars: number, maxEntities?: number, withHistory?: boolean }} opts
 * @returns {{ text: string, entities: string[] }}
 */
export function renderMemory(graph, ids, opts) {
    const maxEntities = opts.maxEntities ?? 40;
    /** @type {string[]} */
    const lines = [];
    /** @type {string[]} */
    const shown = [];
    let used = 0;
    /** @param {string} line */
    const fits = (line) => used + line.length + 1 <= opts.maxChars;

    for (const id of ids) {
        if (shown.length >= maxEntities) break;
        const node = graph.nodes.get(id);
        if (!node) continue;
        const head = entityLine(node, opts.withHistory ?? true);
        if (!fits(head)) {
            // A long description shouldn't block shorter entries that still fit.
            continue;
        }
        lines.push(head);
        used += head.length + 1;
        shown.push(id);
        const shownSet = new Set(shown);
        for (const link of graph.linksOf.get(id) ?? []) {
            const other = link.source === id ? link.target : link.source;
            if (other === id || !shownSet.has(other)) continue;
            for (const rel of relationLines(graph, link)) {
                if (!fits(rel)) continue;
                lines.push(rel);
                used += rel.length + 1;
            }
        }
    }
    return { text: lines.join('\n'), entities: shown.map((id) => graph.nodes.get(id)?.label ?? id) };
}

/**
 * Caches parsed graph.json files by path, reloading when the file changes.
 */
export class GraphCache {
    constructor(max = 16) {
        this.max = max;
        /** @type {Map<string, { key: string, graph: LoadedGraph }>} */
        this.entries = new Map();
    }

    /**
     * @param {string} file
     * @returns {Promise<LoadedGraph | null>} null when there is no graph yet
     */
    async load(file) {
        let stat;
        try {
            stat = await fs.stat(file);
        } catch {
            this.entries.delete(file);
            return null;
        }
        const key = `${stat.mtimeMs}:${stat.size}`;
        const hit = this.entries.get(file);
        if (hit && hit.key === key) {
            this.entries.delete(file);
            this.entries.set(file, hit);
            return hit.graph;
        }
        const graph = indexGraph(JSON.parse(await fs.readFile(file, 'utf8')));
        this.entries.set(file, { key, graph });
        while (this.entries.size > this.max) {
            const oldest = this.entries.keys().next().value;
            if (oldest === undefined) break;
            this.entries.delete(oldest);
        }
        return graph;
    }

    /** @param {string} file */
    forget(file) {
        this.entries.delete(file);
    }
}
