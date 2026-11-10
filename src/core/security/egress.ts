import type { EgressEvent, EgressLog } from '@/types/index.js';
import { uuid } from '@/lib/utils.js';

/**
 * Network egress audit log.
 *
 * Every attempted network request is recorded. In lockdown mode, requests are
 * blocked and the event is logged with `blocked: true`. The log feeds the
 * privacy report (docs/CREATIVE_INNOVATION.md §5.1).
 */

const MAX_EVENTS = 1000;

export class InMemoryEgressLog implements EgressLog {
  private events: EgressEvent[] = [];

  record(event: Omit<EgressEvent, 'id' | 'timestamp'>): void {
    this.events.push({ ...event, id: uuid(), timestamp: Date.now() });
    if (this.events.length > MAX_EVENTS) {
      this.events.splice(0, this.events.length - MAX_EVENTS);
    }
  }

  list(): EgressEvent[] {
    return [...this.events];
  }

  clear(): void {
    this.events = [];
  }
}

/**
 * Patch `fetch` and `WebSocket` to route through the egress log.
 * Returns a restore function.
 */
export function installEgressInterceptor(log: EgressLog, blockAll: boolean): () => void {
  const originalFetch = globalThis.fetch;
  const OriginalWebSocket = globalThis.WebSocket;

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    const blocked = blockAll;
    log.record({ url, method, blocked, reason: blocked ? 'lockdown' : undefined });
    if (blocked) {
      return Promise.reject(new Error(`GhostShell lockdown: blocked fetch to ${url}`));
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  globalThis.WebSocket = class extends OriginalWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      const href = typeof url === 'string' ? url : url.href;
      log.record({ url: href, method: 'WS', blocked: blockAll, reason: blockAll ? 'lockdown' : undefined });
      if (blockAll) {
        throw new Error(`GhostShell lockdown: blocked WebSocket to ${href}`);
      }
      super(url, protocols);
    }
  };

  return () => {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = OriginalWebSocket;
  };
}
