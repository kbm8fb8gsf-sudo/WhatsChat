/**
 * The address the hidden browser should use to reach SillyTavern on this machine.
 * SillyTavern announces a URL for humans (possibly a public hostname); the hidden browser
 * keeps its protocol and port but always connects over loopback. Pure.
 */
export function localServerUrl(announced: string | URL): string | null {
    let url: URL;
    try {
        url = new URL(announced);
    } catch {
        return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const host = url.hostname === '[::1]' ? '[::1]' : '127.0.0.1';
    const port = url.port || (url.protocol === 'https:' ? '443' : '80');
    return `${url.protocol}//${host}:${port}/`;
}

/** Whether the browser ended up on SillyTavern's login page rather than the app. */
export function isLoginPage(pageUrl: string): boolean {
    try {
        return new URL(pageUrl).pathname.replace(/\/+$/, '').endsWith('/login');
    } catch {
        return false;
    }
}
