// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { createChatDecorator, labelMessages, wrapTags } from '../src/dom.js';

/** @param {string} html */
function element(html) {
    const div = document.createElement('div');
    div.innerHTML = html;
    return div;
}

/**
 * @param {number} id
 * @param {string} text
 */
function messageHtml(id, text) {
    return `<div class="mes" mesid="${id}"><div class="mes_block"><div class="ch_name"><div><span class="name_text">A</span><small class="timestamp">x</small></div></div><div class="mes_text">${text}</div></div></div>`;
}

describe('wrapTags', () => {
    it('wraps valid tags and leaves the rest of the text alone', () => {
        const box = element('<p>[TIME: +2h] She waits. [TIME: soonish] [OOC: hi]</p>');
        expect(wrapTags(box)).toBe(true);
        const tag = box.querySelector('.scenario-clock-tag');
        expect(tag?.textContent).toBe('[TIME: +2h]');
        expect(tag?.getAttribute('data-label')).toBe('\u{1F552} +2h');
        expect(box.textContent).toBe('[TIME: +2h] She waits. [TIME: soonish] [OOC: hi]');
        expect(box.querySelectorAll('.scenario-clock-tag')).toHaveLength(1);
    });

    it('marks paragraphs that hold nothing but tags', () => {
        const box = element('<p>[TIME: +8h]</p><p>Morning.</p>');
        wrapTags(box);
        expect(box.querySelector('p')?.classList.contains('scenario-clock-tag-only')).toBe(true);
        expect(box.querySelectorAll('.scenario-clock-tag-only')).toHaveLength(1);
    });

    it('skips code blocks, edit boxes, and tags it already wrapped', () => {
        const box = element('<pre><code>[TIME: +1h]</code></pre><textarea>[TIME: +1h]</textarea>');
        expect(wrapTags(box)).toBe(false);
        const done = element('<p>[TIME: +1h]</p>');
        wrapTags(done);
        expect(wrapTags(done)).toBe(false);
        expect(done.querySelectorAll('.scenario-clock-tag')).toHaveLength(1);
    });
});

describe('labelMessages', () => {
    const view = {
        enabled: true,
        tagDisplay: /** @type {const} */ ('hide'),
        times: /** @type {(number | null)[]} */ ([null, 1000]),
        formatStamp: (/** @type {number} */ t) => ({ text: `T${t}`, title: `Title ${t}` }),
    };

    it('labels messages that have a time, after the timestamp', () => {
        const root = element(messageHtml(0, 'a') + messageHtml(1, 'b'));
        labelMessages(root, view);
        const labels = root.querySelectorAll('.scenario-clock-stamp');
        expect(labels).toHaveLength(1);
        expect(labels[0]?.textContent).toBe('T1000');
        expect(labels[0]?.previousElementSibling?.className).toBe('timestamp');
    });

    it('removes labels when times go away', () => {
        const root = element(messageHtml(1, 'b'));
        labelMessages(root, view);
        labelMessages(root, { ...view, times: null });
        expect(root.querySelector('.scenario-clock-stamp')).toBeNull();
    });
});

describe('createChatDecorator', () => {
    /** @type {HTMLElement} */
    let root;
    /** @type {Array<() => void>} */
    let queued;

    beforeEach(() => {
        document.body.innerHTML = `<div id="chat">${messageHtml(0, '<p>[TIME: +1h] Hi</p>')}</div>`;
        root = /** @type {HTMLElement} */ (document.getElementById('chat'));
        queued = [];
    });

    function decorator(tagDisplay = /** @type {'hide' | 'badge' | 'raw'} */ ('hide')) {
        return createChatDecorator({
            root,
            schedule: (callback) => queued.push(callback),
            getView: () => ({
                enabled: true,
                tagDisplay,
                times: [5],
                formatStamp: (t) => ({ text: `T${t}`, title: '' }),
            }),
        });
    }

    it('decorates what is already there and sets the display mode', () => {
        decorator('badge').start();
        expect(root.classList.contains('scenario-clock-tags-badge')).toBe(true);
        expect(root.querySelector('.scenario-clock-tag')).not.toBeNull();
        expect(root.querySelector('.scenario-clock-stamp')?.textContent).toBe('T5');
    });

    it('re-applies when SillyTavern re-renders a message', async () => {
        const instance = decorator();
        instance.start();
        const text = /** @type {HTMLElement} */ (root.querySelector('.mes_text'));
        text.innerHTML = '<p>Swiped. [TIME: 07:30]</p>';
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(text.querySelector('.scenario-clock-tag')?.textContent).toBe('[TIME: 07:30]');
        expect(queued.length).toBeGreaterThan(0);
        instance.stop();
    });

    it('handles messages added later', async () => {
        decorator().start();
        root.insertAdjacentHTML('beforeend', messageHtml(1, '<p>[TIME: +2d]</p>'));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(root.querySelectorAll('.scenario-clock-tag')).toHaveLength(2);
        queued.forEach((callback) => callback());
        expect(root.querySelectorAll('.scenario-clock-stamp')).toHaveLength(1);
    });
});
