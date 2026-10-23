import type { Request, Response } from 'express';
import type { Scheduler, TimerHandle } from '../core/scheduler.js';
import type { Logger } from '../util/logger.js';

/** Ids a tab may choose for itself, so it keeps its claims across reconnects. */
const CLIENT_ID = /^[A-Za-z0-9-]{8,64}$/;

/**
 * Server-sent events to the extension tabs. Each tab has a client id (its own, or one assigned
 * in the "hello" event) that it uses to claim batches. A tab that drops its connection gets a
 * grace period to reconnect before it's treated as gone.
 */
export class SseHub {
    private readonly clients = new Map<string, Response>();
    private readonly goneTimers = new Map<string, TimerHandle>();
    private heartbeat: TimerHandle | null = null;
    private closed = false;

    constructor(
        private readonly scheduler: Scheduler,
        private readonly newId: () => string,
        private readonly logger: Logger,
        private readonly heartbeatMs = 15_000,
        private readonly graceMs = 10_000,
    ) {}

    /**
     * Take over the response as an event stream. `onGone` runs if the tab disconnects and
     * doesn't come back within the grace period.
     */
    connect(
        req: Request,
        res: Response,
        requestedId: string | undefined,
        onGone: (clientId: string) => void,
    ): string | null {
        if (this.closed) {
            res.status(503).json({ error: 'Shutting down' });
            return null;
        }
        const clientId = requestedId !== undefined && CLIENT_ID.test(requestedId) ? requestedId : this.newId();
        const goneTimer = this.goneTimers.get(clientId);
        if (goneTimer) {
            this.scheduler.clearTimeout(goneTimer);
            this.goneTimers.delete(clientId);
        }
        const previous = this.clients.get(clientId);

        res.status(200);
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        // no-transform stops SillyTavern's compression middleware from buffering the stream.
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();
        res.write('retry: 3000\n\n');
        this.clients.set(clientId, res);
        previous?.end();

        req.on('close', () => {
            if (this.clients.get(clientId) !== res) return;
            this.clients.delete(clientId);
            this.stopHeartbeatIfIdle();
            if (this.closed) return;
            this.goneTimers.set(
                clientId,
                this.scheduler.setTimeout(() => {
                    this.goneTimers.delete(clientId);
                    onGone(clientId);
                }, this.graceMs),
            );
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
        for (const timer of this.goneTimers.values()) this.scheduler.clearTimeout(timer);
        this.goneTimers.clear();
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
