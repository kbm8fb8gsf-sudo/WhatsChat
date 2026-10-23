/** Minimal event-stream reader for tests. */
export interface SseEvent {
    event: string;
    data: unknown;
}

export class SseClient {
    private readonly events: SseEvent[] = [];
    private readonly waiters: { event: string; resolve: (e: SseEvent) => void; reject: (e: Error) => void }[] = [];
    private readonly controller = new AbortController();
    private buffer = '';
    /** How many events of each type next() has already returned. */
    private readonly consumed = new Map<string, number>();
    ended = false;
    response: Response | null = null;

    static async open(url: string): Promise<SseClient> {
        const client = new SseClient();
        const response = await fetch(url, { signal: client.controller.signal });
        client.response = response;
        void client.pump(response);
        return client;
    }

    /** Resolve with the next event of this type not yet returned. */
    next(event: string, timeoutMs = 2_000): Promise<SseEvent> {
        const seen = this.consumed.get(event) ?? 0;
        const available = this.all(event)[seen];
        if (available) {
            this.consumed.set(event, seen + 1);
            return Promise.resolve(available);
        }
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error(`Timed out waiting for "${event}"`));
            }, timeoutMs);
            this.waiters.push({
                event,
                resolve: (e) => {
                    clearTimeout(timer);
                    resolve(e);
                },
                reject,
            });
        });
    }

    all(event: string): SseEvent[] {
        return this.events.filter((e) => e.event === event);
    }

    close(): void {
        this.controller.abort();
    }

    private async pump(response: Response): Promise<void> {
        if (!response.body) return;
        const decoder = new TextDecoder();
        try {
            for await (const chunk of response.body) {
                this.buffer += decoder.decode(chunk as Uint8Array, { stream: true });
                let split = this.buffer.indexOf('\n\n');
                while (split >= 0) {
                    this.handleFrame(this.buffer.slice(0, split));
                    this.buffer = this.buffer.slice(split + 2);
                    split = this.buffer.indexOf('\n\n');
                }
            }
        } catch {
            // aborted
        }
        this.ended = true;
    }

    private handleFrame(frame: string): void {
        let event = 'message';
        let data = '';
        for (const line of frame.split('\n')) {
            if (line.startsWith('event: ')) event = line.slice(7);
            else if (line.startsWith('data: ')) data += line.slice(6);
        }
        if (data === '') return;
        const parsed: SseEvent = { event, data: JSON.parse(data) as unknown };
        this.events.push(parsed);
        const waiter = this.waiters.findIndex((w) => w.event === event);
        if (waiter >= 0) {
            const [w] = this.waiters.splice(waiter, 1);
            this.consumed.set(event, (this.consumed.get(event) ?? 0) + 1);
            w?.resolve(parsed);
        }
    }
}
