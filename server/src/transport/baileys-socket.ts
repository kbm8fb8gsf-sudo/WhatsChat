import makeWASocket, {
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    useMultiFileAuthState,
    type WAVersion,
} from 'baileys';
import type { ILogger } from 'baileys/lib/Utils/logger.js';
import type { Logger } from '../util/logger.js';
import type { SocketFactory } from './whatsapp.js';

const VERSION_TIMEOUT_MS = 5_000;
let cachedVersion: WAVersion | undefined;

/**
 * Creates real Baileys sockets. Kept apart from WhatsAppTransport so the transport can be
 * tested with a fake socket.
 */
export const createBaileysSocket: SocketFactory = async ({ authDir, markOnlineOnConnect, logger, getMessage }) => {
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const baileysLog = toBaileysLogger(logger);
    const version = await latestVersion(logger);
    const socket = makeWASocket({
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, baileysLog) },
        logger: baileysLog,
        markOnlineOnConnect,
        // We only answer new messages, so skip downloading chat history.
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false,
        generateHighQualityLinkPreview: false,
        getMessage,
        ...(version ? { version } : {}),
    });
    return { socket, saveCreds };
};

/**
 * WhatsApp rejects clients that claim an outdated WhatsApp Web version, so ask Baileys for the
 * version its maintainers currently use. Falls back to the version built into Baileys.
 */
async function latestVersion(logger: Logger): Promise<WAVersion | undefined> {
    if (cachedVersion) return cachedVersion;
    try {
        const timeout = new Promise<never>((_resolve, reject) => {
            setTimeout(() => {
                reject(new Error('timed out'));
            }, VERSION_TIMEOUT_MS).unref();
        });
        const result = await Promise.race([fetchLatestBaileysVersion(), timeout]);
        cachedVersion = result.version;
        return cachedVersion;
    } catch (error) {
        logger.debug('Could not fetch the latest WhatsApp Web version; using the built-in one', error);
        return undefined;
    }
}

/** Baileys is chatty. Its errors become warnings in SillyTavern's console; the rest is debug-only. */
export function toBaileysLogger(logger: Logger, bindings: Record<string, unknown> = {}): ILogger {
    const format = (obj: unknown, msg?: string): string => {
        const text = msg ?? (typeof obj === 'string' ? obj : '');
        return `WhatsApp: ${text}`;
    };
    const details = (obj: unknown): unknown[] => (typeof obj === 'string' ? [] : [obj]);
    return {
        level: process.env['WHATSCHAT_DEBUG'] ? 'debug' : 'warn',
        child: (obj) => toBaileysLogger(logger, { ...bindings, ...obj }),
        trace: () => undefined,
        debug: (obj, msg) => {
            logger.debug(format(obj, msg), ...details(obj));
        },
        info: (obj, msg) => {
            logger.debug(format(obj, msg), ...details(obj));
        },
        warn: (obj, msg) => {
            logger.debug(format(obj, msg), ...details(obj));
        },
        error: (obj, msg) => {
            logger.warn(format(obj, msg), ...details(obj));
        },
    };
}
