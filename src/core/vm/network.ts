import type { V86Options } from 'v86';
import type { NetworkMode } from '@/types/index.js';

/**
 * v86 network backends (verified against node_modules/v86/v86.d.ts:260-340 and
 * build/libv86-debug.js:6188-6192).
 *
 * v86 selects the adapter from `net_device.relay_url`:
 *  - `"fetch"`                   -> FetchNetworkAdapter (host localhost / CORS proxy)
 *  - `"inbrowser"`               -> InBrowserNetworkAdapter (BroadcastChannel, no net)
 *  - `"wisp://…"` / `"wisps://…"` -> WispNetworkAdapter (TCP over WebSocket)
 *  - anything else (`"ws://…"`)  -> NetworkAdapter (raw Ethernet over WebSocket)
 *
 * `router_mac` / `router_ip` are the peer hints read by the fetch/wisp
 * adapters. There is no `backend`, `url`, `peer_mac`, `peer_ip`, or `wsproxy`
 * field in v86's contract; setting them is a silent no-op.
 *
 * GhostShell defaults to `off`. Every other mode is an explicit opt-in.
 */

export type NetworkBackend = NetworkMode | 'wsproxy';

export interface NetworkConfig {
  mode: NetworkBackend;
  /** WISP proxy URL when mode === 'wisp' (ws://, wss://, wisp://, or wisps://). */
  wispUrl?: string;
  /** Raw-Ethernet relay URL when mode === 'wsproxy' (ws:// or wss://). */
  proxyUrl?: string;
  /** Peer MAC hint (fetch/wisp/wsproxy). */
  peerMac?: string;
  /** Peer IP hint (fetch/wisp/wsproxy). */
  peerIp?: string;
  /** v86 network namespace id. */
  id?: number;
}

/**
 * GhostShell's network device description: v86's `V86NetworkDevice` with
 * `relay_url` required, so every field is honored at runtime and the object is
 * assignable to `V86Options['net_device']`.
 */
export type NetDevice = NonNullable<V86Options['net_device']> & {
  relay_url: string;
};

function requireUrl(url: string | undefined, mode: 'wisp' | 'wsproxy'): string {
  if (!url) {
    throw new Error(`${mode} mode requires a proxy URL`);
  }
  return url;
}

/**
 * v86's WISP adapter expects `wisp://`/`wisps://` and rewrites them to
 * `ws://`/`wss://` for the actual WebSocket. Accept the ws:// form too so the
 * settings panel can store a normal URL.
 */
function toWispRelayUrl(url: string | undefined): string {
  const href = requireUrl(url, 'wisp');
  if (href.startsWith('wisp://') || href.startsWith('wisps://')) return href;
  if (href.startsWith('ws://')) return `wisp://${href.slice('ws://'.length)}`;
  if (href.startsWith('wss://')) return `wisps://${href.slice('wss://'.length)}`;
  throw new Error(`wisp mode expects a ws:// or wss:// proxy URL, got: ${href}`);
}

/** The raw relay is handed straight to `new WebSocket(url)`, so it must be ws(s)://. */
function toRawRelayUrl(url: string | undefined): string {
  const href = requireUrl(url, 'wsproxy');
  if (href.startsWith('ws://') || href.startsWith('wss://')) return href;
  throw new Error(`wsproxy mode expects a ws:// or wss:// relay URL, got: ${href}`);
}

function withHints(config: NetworkConfig, device: NetDevice): NetDevice {
  return {
    ...device,
    ...(config.id !== undefined ? { id: config.id } : {}),
    ...(config.peerMac !== undefined ? { router_mac: config.peerMac } : {}),
    ...(config.peerIp !== undefined ? { router_ip: config.peerIp } : {}),
  };
}

/**
 * Build the v86 `net_device` for a network mode. This is the single source of
 * truth for the device shape; the VM layer attaches it via `applyNetwork`.
 */
export function buildNetDevice(config: NetworkConfig): NetDevice | undefined {
  switch (config.mode) {
    case 'off':
      return undefined;
    case 'inbrowser':
      // BroadcastChannel-backed; no URL, no server, no external network.
      return withHints(config, { relay_url: 'inbrowser' });
    case 'fetch':
      // Browser fetch(); CORS-friendly mirrors and host localhost only.
      return withHints(config, { relay_url: 'fetch' });
    case 'wisp':
      return withHints(config, { relay_url: toWispRelayUrl(config.wispUrl) });
    case 'wsproxy':
      return withHints(config, { relay_url: toRawRelayUrl(config.proxyUrl) });
    default: {
      const exhaustive: never = config.mode;
      throw new Error(`Unsupported network mode: ${String(exhaustive)}`);
    }
  }
}

/** True when the VM has any network device attached. */
export function isNetworkEnabled(mode: NetworkBackend): boolean {
  return mode !== 'off';
}
