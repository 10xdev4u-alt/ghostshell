import type { V86Options } from 'v86';
import type { NetworkMode } from '@/types/index.js';

/**
 * v86 network backends (verified: node_modules/v86/v86.d.ts + docs/networking.md)
 *
 *  - `off`       : no net_device. Airplane mode.
 *  - `inbrowser` : BroadcastChannel between tabs. No external net, no server.
 *  - `fetch`     : browser fetch(); reaches host localhost via http://<port>.external
 *  - `wisp`      : TCP over WebSocket via a WISP proxy (self-hostable)
 *
 * GhostShell defaults to `off`. `fetch` and `wisp` are explicit opt-ins.
 */

export interface NetworkConfig {
  mode: NetworkMode;
  /** WISP proxy URL when mode === 'wisp'. */
  wispUrl?: string;
  /** Peer MAC/IP hints (advanced). */
  peerMac?: string;
  peerIp?: string;
}

export function buildNetDevice(config: NetworkConfig): V86Options['net_device'] | undefined {
  switch (config.mode) {
    case 'off':
      return undefined;
    case 'inbrowser':
      // BroadcastChannel-backed; no URL needed.
      return { backend: 'inbrowser' } as V86Options['net_device'];
    case 'fetch':
      return { backend: 'fetch' } as V86Options['net_device'];
    case 'wisp':
      if (!config.wispUrl) {
        throw new Error('wisp mode requires a proxy URL (e.g. ws://localhost:8080)');
      }
      return { backend: 'wisp', url: config.wispUrl } as V86Options['net_device'];
    default:
      return undefined;
  }
}

/** True when the VM has any network device attached. */
export function isNetworkEnabled(mode: NetworkMode): boolean {
  return mode !== 'off';
}
