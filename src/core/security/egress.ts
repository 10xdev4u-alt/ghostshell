import type { EgressEvent, EgressLog } from '@/types/index.js';
import { uuid } from '@/lib/utils.js';

/**
 * Network egress audit log.
 *
 * Every attempted network request is recorded. In lockdown mode, requests are
 * blocked and the event is logged with `blocked: true`, except for the app's
 * own boot and model assets (see `BOOT_EGRESS_ALLOWLIST`), which are allowed
 * through and logged with `blocked: false`. The log feeds the privacy report
 * (docs/CREATIVE_INNOVATION.md §5.1).
 */

const MAX_EVENTS = 1000;
const LOCKDOWN_REASON = 'lockdown';

/**
 * A host or URL prefix that stays reachable while lockdown is on.
 *
 * Lockdown blocks application egress, not the app's own boot and model
 * assets. The entries below are the hosts GhostShell cannot boot or load a
 * model without; everything else is still blocked and logged.
 */
export interface EgressAllowlistEntry {
  /**
   * Hostname that stays reachable. The host itself and any subdomain match,
   * so `hf.co` covers the regional Xet CDN hosts (`us.aws.cdn.hf.co`, …).
   */
  host?: string | undefined;
  /**
   * URL prefix that stays reachable, matched literally. Use a scheme such as
   * `data:` or a full origin such as `https://copy.sh/`.
   */
  urlPrefix?: string | undefined;
}

export type EgressAllowlist = readonly EgressAllowlistEntry[];

/**
 * Hosts the app itself needs at boot, even in lockdown.
 *
 * Mirrors the `connect-src` allowlist in index.html: the interceptor and the
 * CSP must agree, or a request the browser permits is blocked by the app (or
 * vice versa). Everything not listed here stays blocked and logged.
 */
export const BOOT_EGRESS_ALLOWLIST: EgressAllowlist = [
  // v86 boot media (BIOS + VGA BIOS) — src/core/vm/image.ts.
  { host: 'copy.sh' },
  // Model weights: the HF Hub and its regional Xet CDN.
  { host: 'huggingface.co' },
  { host: 'hf.co' },
  // ONNX runtime artifacts fetched by @huggingface/transformers.
  { host: 'cdn.jsdelivr.net' },
  // The single-file build loads the inlined v86 WASM from a data: URL.
  { urlPrefix: 'data:' },
];

/** True when `url` matches an allowlist entry (host or literal URL prefix). */
export function isEgressAllowed(url: string, allowlist: EgressAllowlist): boolean {
  if (allowlist.length === 0) return false;
  let hostname: string | null = null;
  for (const entry of allowlist) {
    if (entry.urlPrefix !== undefined && url.startsWith(entry.urlPrefix)) return true;
    if (entry.host === undefined) continue;
    if (hostname === null) hostname = hostnameOf(url);
    const host = entry.host.toLowerCase();
    if (hostname === host || hostname.endsWith(`.${host}`)) return true;
  }
  return false;
}

function hostnameOf(url: string): string {
  try {
    return new URL(url, globalThis.location?.href).hostname.toLowerCase();
  } catch {
    return '';
  }
}

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
 * The egress surface GhostShell intercepts at the app layer. Everything here
 * can carry bytes off the machine, so everything is logged — allowed or
 * blocked.
 *
 *  - `fetch`                    : `globalThis.fetch`
 *  - `WebSocket`                : `globalThis.WebSocket`
 *  - `XMLHttpRequest`           : `XMLHttpRequest.prototype.open`
 *  - `EventSource`              : `globalThis.EventSource`
 *  - `navigator.sendBeacon`     : `Navigator.prototype.sendBeacon`
 *  - `sendBeacon` (global)      : `globalThis.sendBeacon`, when present
 *
 * Not intercepted here — this is not a complete lockdown on its own:
 *  - `new Worker()` / `SharedWorker` / `ServiceWorker` / `importScripts()`
 *  - dynamic `import('https://…')`
 *  - subresource loads: `<script src>`, `<link href>`, `<img src>`/`srcset`,
 *    `<iframe src>`, `<source>`/`<video>`/`<audio>`/`<track>`, `<embed>`,
 *    `<object data>`, `<form action>`, and CSS `@import`/`url()`.
 *
 * Defense in depth, not the enforcement layer. In lockdown mode this
 * interceptor is what actually blocks the calls it covers. The CSP in
 * index.html is the second layer, but it cannot police every vector: a
 * blob: worker's own network calls are outside connect-src's reach, and
 * dynamic import() of a same-origin module is allowed by script-src 'self'
 * and its fetches are not CSP-checked. This interceptor remains the audit
 * log for the APIs it covers.
 *
 * The lockdown allowlist is the deliberate hole in that wall: the app cannot
 * boot or load a model without v86's BIOS (`copy.sh`), the inlined v86 WASM
 * (`data:`), and the HF model CDN. Those hosts stay reachable so GhostShell
 * works out of the box; application egress to every other host is still
 * blocked. The allowlist mirrors the CSP's connect-src, and every allowed
 * request is logged exactly like a blocked one.
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

function record(log: EgressLog, blocked: boolean, url: string, method: string): void {
  log.record({
    url,
    method,
    blocked,
    reason: blocked ? LOCKDOWN_REASON : undefined,
  });
}

/**
 * Lockdown verdict for one request. Allowed requests (or every request when
 * lockdown is off) pass through and are logged with `blocked: false`.
 */
function isBlocked(
  url: string,
  blockAll: boolean,
  allowlist: EgressAllowlist,
): boolean {
  return blockAll && !isEgressAllowed(url, allowlist);
}

function patchFetch(log: EgressLog, blockAll: boolean, allowlist: EgressAllowlist): () => void {
  const g = globalThis as NetworkGlobals;
  const original = g.fetch;
  if (typeof original !== 'function') return () => {};

  const patched = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method =
      init?.method ??
      (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET');
    const blocked = isBlocked(url, blockAll, allowlist);
    record(log, blocked, url, method);
    if (blocked) {
      throw new Error(`GhostShell lockdown: blocked fetch to ${url}`);
    }
    return original(input, init);
  }) as typeof fetch;

  g.fetch = patched;
  return () => {
    g.fetch = original;
  };
}

function patchWebSocket(
  log: EgressLog,
  blockAll: boolean,
  allowlist: EgressAllowlist,
): () => void {
  const g = globalThis as NetworkGlobals;
  const Original = g.WebSocket;
  if (typeof Original !== 'function') return () => {};

  class InterceptedWebSocket extends Original {
    constructor(url: string | URL, protocols?: string | string[]) {
      const href = hrefOf(url);
      const blocked = isBlocked(href, blockAll, allowlist);
      record(log, blocked, href, 'WS');
      if (blocked) {
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

function patchXmlHttpRequest(
  log: EgressLog,
  blockAll: boolean,
  allowlist: EgressAllowlist,
): () => void {
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
    const blocked = isBlocked(href, blockAll, allowlist);
    record(log, blocked, href, method.toUpperCase());
    if (blocked) {
      throw new Error(`GhostShell lockdown: blocked XMLHttpRequest to ${href}`);
    }
    originalOpen.call(this, method, url, async, username, password);
  };

  proto.open = patchedOpen as typeof proto.open;
  return () => {
    proto.open = originalOpen;
  };
}

function patchEventSource(
  log: EgressLog,
  blockAll: boolean,
  allowlist: EgressAllowlist,
): () => void {
  const g = globalThis as NetworkGlobals;
  const Original = g.EventSource;
  if (typeof Original !== 'function') return () => {};

  class InterceptedEventSource extends Original {
    constructor(url: string | URL, eventSourceInitDict?: EventSourceInit) {
      const href = hrefOf(url);
      const blocked = isBlocked(href, blockAll, allowlist);
      record(log, blocked, href, 'GET');
      if (blocked) {
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

function patchNavigatorSendBeacon(
  log: EgressLog,
  blockAll: boolean,
  allowlist: EgressAllowlist,
): () => void {
  const nav = globalThis.navigator;
  if (!nav || typeof nav.sendBeacon !== 'function') return () => {};

  const original = nav.sendBeacon;
  nav.sendBeacon = function (url: string | URL, data?: BodyInit | null): boolean {
    const href = hrefOf(url);
    const blocked = isBlocked(href, blockAll, allowlist);
    record(log, blocked, href, 'POST');
    if (blocked) return false;
    return original.call(nav, url, data);
  };

  return () => {
    nav.sendBeacon = original;
  };
}

function patchGlobalSendBeacon(
  log: EgressLog,
  blockAll: boolean,
  allowlist: EgressAllowlist,
): () => void {
  const g = globalThis as NetworkGlobals;
  const original = g.sendBeacon;
  if (typeof original !== 'function') return () => {};

  g.sendBeacon = function (url: string | URL, data?: BodyInit | null): boolean {
    const href = hrefOf(url);
    const blocked = isBlocked(href, blockAll, allowlist);
    record(log, blocked, href, 'POST');
    if (blocked) return false;
    return original.call(globalThis, url, data);
  };

  return () => {
    g.sendBeacon = original;
  };
}

/**
 * Patch every egress-capable API so each attempt is logged, and optionally
 * blocked. `blockAll` is lockdown mode: nothing leaves the machine, except
 * requests matching `allowlist` — the app's own boot and model assets (v86's
 * BIOS, the inlined v86 WASM, the HF model CDN). Lockdown blocks application
 * egress, not the app booting itself.
 *
 * Omit `allowlist` to block everything in lockdown mode; the two-argument
 * form is unchanged.
 *
 * Returns a restore function that puts every patched global back.
 */
export function installEgressInterceptor(
  log: EgressLog,
  blockAll: boolean,
  allowlist: EgressAllowlist = [],
): () => void {
  const restores = [
    patchFetch(log, blockAll, allowlist),
    patchWebSocket(log, blockAll, allowlist),
    patchXmlHttpRequest(log, blockAll, allowlist),
    patchEventSource(log, blockAll, allowlist),
    patchNavigatorSendBeacon(log, blockAll, allowlist),
    patchGlobalSendBeacon(log, blockAll, allowlist),
  ];

  return () => {
    for (const restore of restores.reverse()) restore();
  };
}
