import { describe, expect, it } from 'vitest';
import { buildNetDevice, isNetworkEnabled } from '@/core/vm/network.js';

describe('buildNetDevice', () => {
  it('omits net_device entirely for airplane mode', () => {
    expect(buildNetDevice({ mode: 'off' })).toBeUndefined();
  });

  it('builds the inbrowser backend (no server, no external net)', () => {
    expect(buildNetDevice({ mode: 'inbrowser' })).toEqual({ backend: 'inbrowser' });
  });

  it('builds the fetch backend', () => {
    expect(buildNetDevice({ mode: 'fetch' })).toEqual({ backend: 'fetch' });
  });

  it('builds the wisp backend with a proxy URL', () => {
    expect(buildNetDevice({ mode: 'wisp', wispUrl: 'wss://relay.example.com' })).toEqual({
      backend: 'wisp',
      url: 'wss://relay.example.com',
    });
  });

  it('requires a wisp proxy URL', () => {
    expect(() => buildNetDevice({ mode: 'wisp' })).toThrow('wisp');
  });

  it('builds the wsproxy backend with a proxy URL', () => {
    expect(buildNetDevice({ mode: 'wsproxy', proxyUrl: 'wss://proxy.example.com' })).toEqual({
      backend: 'wsproxy',
      url: 'wss://proxy.example.com',
    });
  });

  it('requires a wsproxy proxy URL', () => {
    expect(() => buildNetDevice({ mode: 'wsproxy' })).toThrow('wsproxy');
  });

  it('passes id and peer hints through to the device', () => {
    expect(
      buildNetDevice({
        mode: 'wisp',
        wispUrl: 'wss://relay.example.com',
        id: 3,
        peerMac: '52:54:00:01:02:03',
        peerIp: '192.168.86.1',
      }),
    ).toEqual({
      backend: 'wisp',
      url: 'wss://relay.example.com',
      id: 3,
      peer_mac: '52:54:00:01:02:03',
      peer_ip: '192.168.86.1',
    });
  });

  it('leaves optional fields off when they are not configured', () => {
    const device = buildNetDevice({ mode: 'fetch' });
    expect(device).not.toHaveProperty('url');
    expect(device).not.toHaveProperty('id');
    expect(device).not.toHaveProperty('peer_mac');
    expect(device).not.toHaveProperty('peer_ip');
  });
});

describe('isNetworkEnabled', () => {
  it('is false only for airplane mode', () => {
    expect(isNetworkEnabled('off')).toBe(false);
    expect(isNetworkEnabled('inbrowser')).toBe(true);
    expect(isNetworkEnabled('fetch')).toBe(true);
    expect(isNetworkEnabled('wisp')).toBe(true);
    expect(isNetworkEnabled('wsproxy')).toBe(true);
  });
});
