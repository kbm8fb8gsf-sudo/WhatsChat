// @ts-check
/**
 * Turns every stored segment of a memory into one graphify extraction
 * (`{nodes, edges, hyperedges}`, the format graphify's `build_from_json` reads).
 *
 * The same character or place shows up in many segments. graphify would keep those as
 * separate nodes (its ids normally include the source file), so entities are merged here by
 * canonical name first: one node per entity, its newest description on top and a short
 * history of older ones. Relationships between the same two entities are folded into one
 * graph edge that lists every relation, because graphify's directed graph keeps a single
 * edge per (source, target) pair.
 */
import { entityId } from './normalize.js';

/**
 * @typedef {import('./normalize.js').Entity} Entity
 * @typedef {import('./normalize.js').Relation} Relation
 */

/**
 * @typedef {object} StoredSegment
 * @property {string} id
 * @property {string} chatId
 * @property {string} chatKey
 * @property {string} chatLabel
 * @property {number} from
 * @property {number} to
 * @property {string} fingerprint
 * @property {string} createdAt
 * @property {string} sourceFile   corpus file, relative to the memory folder
 * @property {Entity[]} entities
 * @property {Relation[]} relations
 */

/**
 * @typedef {object} GraphifyNode
 * @property {string} id
 * @property {string} label
 * @property {'concept'} file_type
 * @property {string} source_file
 * @property {string} source_location
 * @property {string | null} rationale
 * @property {{ kind: string, description: string, earlier: string[], aliases: string[], first_seen: string, last_seen: string, mentions: number }} attributes
 * @property {'semantic'} _origin
 */

/**
 * @typedef {object} RelationEntry
 * @property {string} relation
 * @property {string} detail
 * @property {string} at
 */

/**
 * @typedef {object} GraphifyEdge
 * @property {string} source
 * @property {string} target
 * @property {string} relation
 * @property {'EXTRACTED'} confidence
 * @property {number} confidence_score
 * @property {number} weight
 * @property {string} source_file
 * @property {string} source_location
 * @property {RelationEntry[]} relations
 * @property {'semantic'} _origin
 */

const MAX_EARLIER = 3;
const MAX_RELATIONS_PER_PAIR = 6;

/**
 * Where a fact was seen, in SillyTavern's own message numbering (the `#12` badges).
 * @param {StoredSegment} seg
 * @param {boolean} withChat
 */
export function describeLocation(seg, withChat) {
    const range = seg.to - seg.from > 1 ? `#${seg.from}–#${seg.to - 1}` : `#${seg.from}`;
    return withChat ? `${seg.chatLabel} ${range}` : range;
}

/**
 * Story order: chats in the order they were first remembered, then by message index.
 * @param {StoredSegment[]} segments
 * @returns {StoredSegment[]}
 */
export function storyOrder(segments) {
    /** @type {Map<string, string>} */
    const chatStart = new Map();
    for (const s of segments) {
        const seen = chatStart.get(s.chatKey);
        if (seen === undefined || s.createdAt < seen) chatStart.set(s.chatKey, s.createdAt);
    }
    return [...segments].sort((a, b) => {
        const ca = chatStart.get(a.chatKey) ?? '';
        const cb = chatStart.get(b.chatKey) ?? '';
        if (ca !== cb) return ca < cb ? -1 : 1;
        if (a.chatKey !== b.chatKey) return a.chatKey < b.chatKey ? -1 : 1;
        return a.from - b.from;
    });
}

/**
 * @param {StoredSegment[]} segments
 * @returns {{ nodes: GraphifyNode[], edges: GraphifyEdge[], hyperedges: never[] }}
 */
export function mergeSegments(segments) {
    const ordered = storyOrder(segments);
    const multiChat = new Set(ordered.map((s) => s.chatKey)).size > 1;

    // Pass 1: every name used as a primary entity name owns its id.
    /** @type {Set<string>} */
    const primaryIds = new Set();
    for (const seg of ordered) for (const e of seg.entities) primaryIds.add(entityId(e.name));

    // Pass 2: aliases point at a primary entity, unless the alias is itself a primary name.
    /** @type {Map<string, string>} */
    const aliasOf = new Map();
    for (const seg of ordered) {
        for (const e of seg.entities) {
            const id = entityId(e.name);
            for (const alias of e.aliases) {
                const aid = entityId(alias);
                if (aid && !primaryIds.has(aid) && !aliasOf.has(aid)) aliasOf.set(aid, id);
            }
        }
    }
    /** @param {string} name */
    const resolve = (name) => {
        const id = entityId(name);
        return aliasOf.get(id) ?? id;
    };

    /** @type {Map<string, GraphifyNode>} */
    const nodes = new Map();

    /**
     * @param {string} id
     * @param {string} name
     * @param {StoredSegment} seg
     */
    const touch = (id, name, seg) => {
        const where = describeLocation(seg, multiChat);
        let node = nodes.get(id);
        if (!node) {
            node = {
                id,
                label: name,
                file_type: 'concept',
                source_file: seg.sourceFile,
                source_location: where,
                rationale: null,
                attributes: { kind: 'thing', description: '', earlier: [], aliases: [], first_seen: where, last_seen: where, mentions: 0 },
                _origin: 'semantic',
            };
            nodes.set(id, node);
        }
        node.source_file = seg.sourceFile;
        node.source_location = where;
        node.attributes.last_seen = where;
        node.attributes.mentions += 1;
        return node;
    };

    for (const seg of ordered) {
        for (const e of seg.entities) {
            const id = resolve(e.name);
            if (!id) continue;
            const node = touch(id, e.name, seg);
            // Newer spellings win, but never trade "Kai" for a lower-case "kai".
            if (primaryIds.has(entityId(e.name)) && capitals(e.name) >= capitals(node.label)) node.label = e.name;
            if (e.kind !== 'thing' || node.attributes.kind === 'thing') node.attributes.kind = e.kind;
            if (e.description && e.description !== node.attributes.description) {
                if (node.attributes.description) {
                    node.attributes.earlier = [node.attributes.description, ...node.attributes.earlier.filter((d) => d !== e.description)].slice(0, MAX_EARLIER);
                }
                node.attributes.description = e.description;
            }
            for (const alias of e.aliases) {
                if (!node.attributes.aliases.includes(alias) && alias !== node.label) node.attributes.aliases.push(alias);
            }
            node.attributes.aliases = node.attributes.aliases.slice(-6);
            // graphify searches the rationale text too, so descriptions help a question find the node.
            node.rationale = node.attributes.description || null;
        }
    }

    /** @type {Map<string, GraphifyEdge>} */
    const edges = new Map();
    for (const seg of ordered) {
        const where = describeLocation(seg, multiChat);
        for (const r of seg.relations) {
            const src = resolve(r.source);
            const tgt = resolve(r.target);
            if (!src || !tgt || src === tgt) continue;
            // A relation can name something the model forgot to list as an entity.
            if (!nodes.has(src)) touch(src, r.source, seg);
            if (!nodes.has(tgt)) touch(tgt, r.target, seg);
            const key = `${src}\u0000${tgt}`;
            let edge = edges.get(key);
            if (!edge) {
                edge = {
                    source: src,
                    target: tgt,
                    relation: r.relation,
                    confidence: 'EXTRACTED',
                    confidence_score: 1,
                    weight: 0,
                    source_file: seg.sourceFile,
                    source_location: where,
                    relations: [],
                    _origin: 'semantic',
                };
                edges.set(key, edge);
            }
            edge.weight += 1;
            edge.relation = r.relation;
            edge.source_file = seg.sourceFile;
            edge.source_location = where;
            // Newest first; a repeated relation moves to the front with its newest detail.
            const previous = edge.relations.find((x) => x.relation === r.relation);
            const detail = r.detail || previous?.detail || '';
            edge.relations = [{ relation: r.relation, detail, at: where }, ...edge.relations.filter((x) => x.relation !== r.relation)].slice(0, MAX_RELATIONS_PER_PAIR);
        }
    }

    return { nodes: [...nodes.values()], edges: [...edges.values()], hyperedges: [] };
}

/** @param {string} text */
function capitals(text) {
    return (text.match(/\p{Lu}/gu) ?? []).length;
}

/**
 * The best-known names in a memory, so the extraction prompt can reuse them
 * ("Sera" stays "Seraphina") instead of inventing variants.
 * @param {StoredSegment[]} segments
 * @param {number} limit
 * @returns {{ name: string, kind: string }[]}
 */
export function topEntities(segments, limit) {
    const { nodes, edges } = mergeSegments(segments);
    /** @type {Map<string, number>} */
    const degree = new Map();
    for (const e of edges) {
        degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
        degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    }
    return nodes
        .map((n) => ({ n, score: n.attributes.mentions * 2 + (degree.get(n.id) ?? 0) }))
        .sort((a, b) => b.score - a.score || a.n.label.localeCompare(b.n.label))
        .slice(0, limit)
        .map(({ n }) => ({ name: n.label, kind: n.attributes.kind }));
}
