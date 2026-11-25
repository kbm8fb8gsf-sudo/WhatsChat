// @ts-check
/**
 * On-screen touches in the chat: hides (or restyles) [TIME: ...] tags and shows the story time
 * in each message's header. The stored messages are never changed.
 *
 * SillyTavern re-renders messages from many places (streaming, swipes, edits, loading more), so
 * rather than hooking each one, a MutationObserver re-applies the touches whenever the chat's
 * DOM changes.
 */

import { findTags } from './tags.js';

const SHOW_TEXT = 4;
const FILTER_ACCEPT = 1;
const FILTER_REJECT = 2;
const FILTER_SKIP = 3;
const SKIP_INSIDE = '.scenario-clock-tag, textarea, code, pre, script, style';
const MODES = ['hide', 'badge', 'raw'];

/**
 * @typedef {object} ChatView
 * @property {boolean} enabled
 * @property {'hide' | 'badge' | 'raw'} tagDisplay
 * @property {(number | null)[] | null} times The time after each message, by message id.
 * @property {(time: number) => { text: string, title: string }} formatStamp
 */

/**
 * Wraps each valid tag in a span the stylesheet can hide or restyle.
 * @param {Element} container
 */
export function wrapTags(container) {
    const doc = container.ownerDocument;
    const walker = doc.createTreeWalker(container, SHOW_TEXT, {
        acceptNode(node) {
            const parent = node.parentElement;
            if (!parent || parent.closest(SKIP_INSIDE)) return FILTER_REJECT;
            return /\[\s*time\s*:/i.test(node.nodeValue ?? '') ? FILTER_ACCEPT : FILTER_SKIP;
        },
    });
    /** @type {Text[]} */
    const nodes = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(/** @type {Text} */ (node));

    let changed = false;
    for (const node of nodes) {
        const text = node.data;
        const tags = findTags(text);
        if (tags.length === 0) continue;
        const parent = node.parentElement;
        const fragment = doc.createDocumentFragment();
        let position = 0;
        for (const tag of tags) {
            if (tag.index > position) fragment.append(text.slice(position, tag.index));
            const span = doc.createElement('span');
            span.className = 'scenario-clock-tag';
            span.dataset['label'] = `\u{1F552} ${tag.instruction}`;
            span.title = `Story clock: ${tag.instruction}`;
            span.textContent = tag.raw;
            fragment.append(span);
            position = tag.index + tag.raw.length;
        }
        if (position < text.length) fragment.append(text.slice(position));
        node.replaceWith(fragment);
        changed = true;
        if (parent && isOnlyTags(parent)) parent.classList.add('scenario-clock-tag-only');
    }
    return changed;
}

/**
 * True if an element holds nothing but tags and whitespace, so hiding the tags would leave
 * an empty paragraph behind.
 * @param {Element} element
 */
function isOnlyTags(element) {
    for (const child of element.childNodes) {
        if (child.nodeType === 3 && (child.nodeValue ?? '').trim() !== '') return false;
        if (child.nodeType === 1) {
            const el = /** @type {Element} */ (child);
            if (!el.classList.contains('scenario-clock-tag') && el.tagName !== 'BR') return false;
        }
    }
    return true;
}

/**
 * Adds, updates or removes the time label in each message header.
 * @param {Element} root The #chat element.
 * @param {ChatView} view
 */
export function labelMessages(root, view) {
    for (const message of root.querySelectorAll('.mes[mesid]')) {
        const id = Number(message.getAttribute('mesid'));
        const time = view.enabled && view.times && Number.isInteger(id) ? view.times[id] ?? null : null;
        let label = message.querySelector('.scenario-clock-stamp');
        if (time === null) {
            label?.remove();
            continue;
        }
        if (!label) {
            const anchor = message.querySelector('.ch_name .timestamp') ?? message.querySelector('.ch_name .name_text');
            if (!anchor) continue;
            label = message.ownerDocument.createElement('small');
            label.className = 'scenario-clock-stamp';
            anchor.after(label);
        }
        const { text, title } = view.formatStamp(time);
        if (label.textContent !== text) label.textContent = text;
        if (label.getAttribute('title') !== title) label.setAttribute('title', title);
    }
}

/**
 * @param {Element} root
 * @param {ChatView['tagDisplay']} mode
 */
function setMode(root, mode) {
    for (const other of MODES) {
        const name = `scenario-clock-tags-${other}`;
        if (other === mode) {
            if (!root.classList.contains(name)) root.classList.add(name);
        } else if (root.classList.contains(name)) {
            root.classList.remove(name);
        }
    }
}

/**
 * @param {object} deps
 * @param {Element} deps.root The #chat element.
 * @param {() => ChatView} deps.getView
 * @param {(callback: () => void) => void} [deps.schedule] Batches label updates (default: next frame).
 */
export function createChatDecorator({ root, getView, schedule }) {
    const view = root.ownerDocument.defaultView;
    const later = schedule ?? ((callback) => {
        if (view?.requestAnimationFrame) view.requestAnimationFrame(() => callback());
        else setTimeout(callback, 16);
    });
    const options = { childList: true, subtree: true, characterData: true };
    let labelsPending = false;
    /** @type {MutationObserver | null} */
    let observer = null;

    /** @param {() => void} work */
    function quietly(work) {
        observer?.disconnect();
        try {
            work();
        } finally {
            observer?.observe(root, options);
        }
    }

    function updateLabels() {
        labelsPending = false;
        quietly(() => {
            const current = getView();
            setMode(root, current.enabled ? current.tagDisplay : 'raw');
            labelMessages(root, current);
        });
    }

    function scheduleLabels() {
        if (labelsPending) return;
        labelsPending = true;
        later(updateLabels);
    }

    /** @param {MutationRecord[]} records */
    function onMutations(records) {
        /** @type {Set<Element>} */
        const containers = new Set();
        for (const record of records) {
            const target = record.target.nodeType === 1 ? /** @type {Element} */ (record.target) : record.target.parentElement;
            const text = target?.closest('.mes_text');
            if (text) containers.add(text);
            for (const added of record.addedNodes) {
                if (added.nodeType !== 1) continue;
                const el = /** @type {Element} */ (added);
                if (el.matches('.mes_text')) containers.add(el);
                for (const inner of el.querySelectorAll('.mes_text')) containers.add(inner);
            }
        }
        if (containers.size > 0) quietly(() => containers.forEach((container) => wrapTags(container)));
        scheduleLabels();
    }

    /** Re-applies everything now, e.g. after the clock or the settings changed. */
    function refresh() {
        quietly(() => root.querySelectorAll('.mes_text').forEach((container) => wrapTags(container)));
        updateLabels();
    }

    function start() {
        if (observer) return;
        const Observer = view?.MutationObserver ?? MutationObserver;
        observer = new Observer(onMutations);
        observer.observe(root, options);
        refresh();
    }

    function stop() {
        observer?.disconnect();
        observer = null;
    }

    return { start, stop, refresh };
}
