export interface Logger {
    debug(message: string, ...details: unknown[]): void;
    info(message: string, ...details: unknown[]): void;
    warn(message: string, ...details: unknown[]): void;
    error(message: string, ...details: unknown[]): void;
}

const PREFIX = '[WhatsChat]';

/** Console logger with a fixed prefix. Debug output only appears when WHATSCHAT_DEBUG is set. */
export function createConsoleLogger(debugEnabled = Boolean(process.env['WHATSCHAT_DEBUG'])): Logger {
    return {
        debug: (message, ...details) => {
            if (debugEnabled) console.debug(PREFIX, message, ...details);
        },
        info: (message, ...details) => { console.info(PREFIX, message, ...details); },
        warn: (message, ...details) => { console.warn(PREFIX, message, ...details); },
        error: (message, ...details) => { console.error(PREFIX, message, ...details); },
    };
}

/** Logger that discards everything. Used by tests. */
export const silentLogger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
};
