// @ts-check
/**
 * WhatsChat UI extension entry point. SillyTavern loads this as an ES module and calls
 * the exported `onActivate` hook named in manifest.json.
 */

let activated = false;

/** Manifest `activate` hook. */
export async function onActivate() {
    if (activated) return;
    activated = true;
    console.info('[WhatsChat] extension loaded');
}
