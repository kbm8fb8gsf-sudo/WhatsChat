import type { Request, Response } from 'express';
import type { Scheduler, TimerHandle } from '../core/scheduler.js';
import type { Logger } from '../util/logger.js';

/**
 * Server-sent events to the extension tabs. Each tab gets a client id in a "hello" event,
 * which it uses to claim batches.
 */
export class SseHub {
    private readonly clients = new Map<string, Response>();
    private heartbeat: TimerHandle | null = null;
    private closed = false;

    constructor(
        private readonly scheduler: Scheduler,
        private readonly newId: () => string,
        private readonly logger: Logger,
        private readonly heartbeatMs = 15_000,
    ) {}

    /** Take over the response as an event stream. `onClose` runs when the tab disconnects. */
    connect(req: Request, res: Response, onClose: (clientId: string) => void): string | null {
        if (this.closed) {
            res.status(503).json({ error: 'Shutting down' });
            return null;
        }
        const clientId = this.newId();
        res.status(200);
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        // no-transform stops SillyTavern's compression middleware from buffering the stream.
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();
        res.write('retry: 3000\n\n');
        this.clients.set(clientId, res);
        req.on('close', () => {
            if (!this.clients.delete(clientId)) return;
            this.stopHeartbeatIfIdle();
            onClose(clientId);
        });
        this.startHeartbeat();
        return clientId;
    }

    send(clientId: string, event: string, data: unknown): void {
        const res = this.clients.get(clientId);
        if (res) this.write(clientId, res, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }

    broadcast(event: string, data: unknown): void {
        const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        for (const [clientId, res] of this.clients) this.write(clientId, res, frame);
    }

    get size(): number {
        return this.clients.size;
    }

    /** End every stream and stop the heartbeat. */
    closeAll(): void {
        this.closed = true;
        for (const res of this.clients.values()) {
            try {
                res.end();
            } catch (error) {
                this.logger.debug('Error ending an event stream', error);
            }
        }
        this.clients.clear();
        this.stopHeartbeatIfIdle();
    }

    private write(clientId: string, res: Response, frame: string): void {
        try {
            res.write(frame);
            (res as Response & { flush?: () => void }).flush?.();
        } catch (error) {
            this.logger.debug(`Dropping event stream ${clientId}`, error);
            this.clients.delete(clientId);
        }
    }

    private startHeartbeat(): void {
        if (this.heartbeat || this.closed) return;
        this.heartbeat = this.scheduler.setTimeout(() => {
            this.heartbeat = null;
            for (const [clientId, res] of this.clients) this.write(clientId, res, ': ping\n\n');
            if (this.clients.size > 0) this.startHeartbeat();
        }, this.heartbeatMs);
    }

    private stopHeartbeatIfIdle(): void {
        if (this.clients.size > 0 || !this.heartbeat) return;
        this.scheduler.clearTimeout(this.heartbeat);
        this.heartbeat = null;
    }
}
