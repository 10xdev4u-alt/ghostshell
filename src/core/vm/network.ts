import type { NetworkMode } from '@/types/index.js';

/**
 * v86 network backends (verified: node_modules/v86/v86.d.ts + docs/networking.md)
 *
 *  - `off`       : no net_device. Airplane mode.
 *  - `inbrowser` : BroadcastChannel between tabs. No external net, no server.
 *  - `fetch`     : browser fetch(); reaches host localhost via http://<port>.external
 *  - `wisp`      : TCP over WebSocket via a WISP proxy (self-hostable)
 *  - `wsproxy`   : raw Ethernet over WebSocket via a self-hosted proxy
 *
 * GhostShell defaults to `off`. Every other mode is an explicit opt-in.
 */

export type NetworkBackend = NetworkMode | 'wsproxy';

export interface NetworkConfig {
  mode: NetworkBackend;
  /** WISP proxy URL when mode === 'wisp'. */
  wispUrl?: string;
  /** Raw-Ethernet proxy URL when mode === 'wsproxy'. */
  proxyUrl?: string;
  /** Peer MAC hint (fetch/wisp/wsproxy). */
  peerMac?: string;
  /** Peer IP hint (fetch/wisp/wsproxy). */
  peerIp?: string;
  /** v86 network namespace id. */
  id?: number;
}

/**
 * GhostShell's network device description. Assignable to v86's
 * `V86Options['net_device']`; `backend` + `url` select the transport.
 */
export interface NetDevice {
  backend: 'inbrowser' | 'fetch' | 'wisp' | 'wsproxy';
  url?: string;
  id?: number;
  peer_mac?: string;
  peer_ip?: string;
}

function withHints(device: NetDevice, config: NetworkConfig): NetDevice {
  if (config.id !== undefined) device.id = config.id;
  if (config.peerMac !== undefined) device.peer_mac = config.peerMac;
  if (config.peerIp !== undefined) device.peer_ip = config.peerIp;
  return device;
}

export function buildNetDevice(config: NetworkConfig): NetDevice | undefined {
  switch (config.mode) {
    case 'off':
      return undefined;
    case 'inbrowser':
      // BroadcastChannel-backed; no URL, no server, no external network.
      return withHints({ backend: 'inbrowser' }, config);
    case 'fetch':
      // Browser fetch(); CORS-friendly mirrors and host localhost only.
      return withHints({ backend: 'fetch' }, config);
    case 'wisp':
      if (!config.wispUrl) {
        throw new Error('wisp mode requires a proxy URL (e.g. wss://relay.example.com)');
      }
      return withHints({ backend: 'wisp', url: config.wispUrl }, config);
    case 'wsproxy':
      if (!config.proxyUrl) {
        throw new Error('wsproxy mode requires a proxy URL (e.g. wss://proxy.example.com)');
      }
      return withHints({ backend: 'wsproxy', url: config.proxyUrl }, config);
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
