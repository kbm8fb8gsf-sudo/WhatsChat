// Vite/Vitest "?raw" imports, used by the settings panel test.
declare module '*.html?raw' {
    const content: string;
    export default content;
}
