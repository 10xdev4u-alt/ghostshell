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
const LOCKDOWN_REASON = 'lockdown';

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
 * The full egress surface GhostShell intercepts. Everything here can carry
 * bytes off the machine, so everything is logged — allowed or blocked.
 *
 *  - `fetch`                    : `globalThis.fetch`
 *  - `WebSocket`                : `globalThis.WebSocket`
 *  - `XMLHttpRequest`           : `XMLHttpRequest.prototype.open`
 *  - `EventSource`              : `globalThis.EventSource`
 *  - `navigator.sendBeacon`     : `Navigator.prototype.sendBeacon`
 *  - `sendBeacon` (global)      : `globalThis.sendBeacon`, when present
 */
interface NetworkGlobals {
  fetch?: typeof fetch;
  WebSocket?: typeof WebSocket;
  XMLHttpRequest?: typeof XMLHttpRequest;
  EventSource?: typeof EventSource;
  sendBeacon?: (url: string | URL, data?: BodyInit | null) => boolean;
}

function hrefOf(url: string | URL): string {
  return typeof url === 'string' ? url : url.href;
}

function record(
  log: EgressLog,
  blockAll: boolean,
  url: string,
  method: string,
): void {
  log.record({
    url,
    method,
    blocked: blockAll,
    reason: blockAll ? LOCKDOWN_REASON : undefined,
  });
}

function patchFetch(log: EgressLog, blockAll: boolean): () => void {
  const g = globalThis as NetworkGlobals;
  const original = g.fetch;
  if (typeof original !== 'function') return () => {};

  const patched = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method =
      init?.method ??
      (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET');
    record(log, blockAll, url, method);
    if (blockAll) {
      throw new Error(`GhostShell lockdown: blocked fetch to ${url}`);
    }
    return original(input, init);
  }) as typeof fetch;

  g.fetch = patched;
  return () => {
    g.fetch = original;
  };
}

function patchWebSocket(log: EgressLog, blockAll: boolean): () => void {
  const g = globalThis as NetworkGlobals;
  const Original = g.WebSocket;
  if (typeof Original !== 'function') return () => {};

  class InterceptedWebSocket extends Original {
    constructor(url: string | URL, protocols?: string | string[]) {
      const href = hrefOf(url);
      record(log, blockAll, href, 'WS');
      if (blockAll) {
        throw new Error(`GhostShell lockdown: blocked WebSocket to ${href}`);
      }
      super(url, protocols);
    }
  }

  g.WebSocket = InterceptedWebSocket as unknown as typeof WebSocket;
  return () => {
    g.WebSocket = Original;
  };
}

function patchXmlHttpRequest(log: EgressLog, blockAll: boolean): () => void {
  const g = globalThis as NetworkGlobals;
  const Original = g.XMLHttpRequest;
  if (typeof Original !== 'function') return () => {};

  const proto = Original.prototype;
  const originalOpen = proto.open;

  const patchedOpen = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    async = true,
    username?: string | null,
    password?: string | null,
  ): void {
    const href = hrefOf(url);
    record(log, blockAll, href, method.toUpperCase());
    if (blockAll) {
      throw new Error(`GhostShell lockdown: blocked XMLHttpRequest to ${href}`);
    }
    originalOpen.call(this, method, url, async, username, password);
  };

  proto.open = patchedOpen as typeof proto.open;
  return () => {
    proto.open = originalOpen;
  };
}

function patchEventSource(log: EgressLog, blockAll: boolean): () => void {
  const g = globalThis as NetworkGlobals;
  const Original = g.EventSource;
  if (typeof Original !== 'function') return () => {};

  class InterceptedEventSource extends Original {
    constructor(url: string | URL, eventSourceInitDict?: EventSourceInit) {
      const href = hrefOf(url);
      record(log, blockAll, href, 'GET');
      if (blockAll) {
        throw new Error(`GhostShell lockdown: blocked EventSource to ${href}`);
      }
      super(url, eventSourceInitDict);
    }
  }

  g.EventSource = InterceptedEventSource as unknown as typeof EventSource;
  return () => {
    g.EventSource = Original;
  };
}

function patchNavigatorSendBeacon(log: EgressLog, blockAll: boolean): () => void {
  const nav = globalThis.navigator;
  if (!nav || typeof nav.sendBeacon !== 'function') return () => {};

  const original = nav.sendBeacon;
  nav.sendBeacon = function (url: string | URL, data?: BodyInit | null): boolean {
    const href = hrefOf(url);
    record(log, blockAll, href, 'POST');
    if (blockAll) return false;
    return original.call(nav, url, data);
  };

  return () => {
    nav.sendBeacon = original;
  };
}

function patchGlobalSendBeacon(log: EgressLog, blockAll: boolean): () => void {
  const g = globalThis as NetworkGlobals;
  const original = g.sendBeacon;
  if (typeof original !== 'function') return () => {};

  g.sendBeacon = function (url: string | URL, data?: BodyInit | null): boolean {
    const href = hrefOf(url);
    record(log, blockAll, href, 'POST');
    if (blockAll) return false;
    return original.call(globalThis, url, data);
  };

  return () => {
    g.sendBeacon = original;
  };
}

/**
 * Patch every egress-capable API so each attempt is logged, and optionally
 * blocked. `blockAll` is lockdown mode: nothing leaves the machine.
 *
 * Returns a restore function that puts every patched global back.
 */
export function installEgressInterceptor(log: EgressLog, blockAll: boolean): () => void {
  const restores = [
    patchFetch(log, blockAll),
    patchWebSocket(log, blockAll),
    patchXmlHttpRequest(log, blockAll),
    patchEventSource(log, blockAll),
    patchNavigatorSendBeacon(log, blockAll),
    patchGlobalSendBeacon(log, blockAll),
  ];

  return () => {
    for (const restore of restores.reverse()) restore();
  };
}
