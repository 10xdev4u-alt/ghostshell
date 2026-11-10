import { describe, expect, it } from 'vitest';
import { applyNetwork, buildNetDevice, isNetworkEnabled } from '@/core/vm/network.js';
import type { V86Options } from 'v86';

describe('buildNetDevice', () => {
  it('omits net_device entirely for airplane mode', () => {
    expect(buildNetDevice({ mode: 'off' })).toBeUndefined();
  });

  it('builds the inbrowser backend (no server, no external net)', () => {
    expect(buildNetDevice({ mode: 'inbrowser' })).toEqual({ relay_url: 'inbrowser' });
  });

  it('builds the fetch backend', () => {
    expect(buildNetDevice({ mode: 'fetch' })).toEqual({ relay_url: 'fetch' });
  });

  it('builds the wisp backend with a wisp(s):// relay URL', () => {
    expect(buildNetDevice({ mode: 'wisp', wispUrl: 'wisps://relay.example.com' })).toEqual({
      relay_url: 'wisps://relay.example.com',
    });
  });

  it('normalizes ws:// and wss:// wisp URLs to the scheme v86 expects', () => {
    expect(buildNetDevice({ mode: 'wisp', wispUrl: 'ws://relay.example.com' })).toEqual({
      relay_url: 'wisp://relay.example.com',
    });
    expect(buildNetDevice({ mode: 'wisp', wispUrl: 'wss://relay.example.com' })).toEqual({
      relay_url: 'wisps://relay.example.com',
    });
  });

  it('requires a wisp proxy URL', () => {
    expect(() => buildNetDevice({ mode: 'wisp' })).toThrow('wisp');
  });

  it('rejects a non-ws wisp URL', () => {
    expect(() => buildNetDevice({ mode: 'wisp', wispUrl: 'https://relay.example.com' })).toThrow(
      'ws://',
    );
  });

  it('builds the wsproxy backend as a raw ws:// relay', () => {
    expect(buildNetDevice({ mode: 'wsproxy', proxyUrl: 'wss://proxy.example.com' })).toEqual({
      relay_url: 'wss://proxy.example.com',
    });
  });

  it('requires a wsproxy relay URL', () => {
    expect(() => buildNetDevice({ mode: 'wsproxy' })).toThrow('wsproxy');
  });

  it('rejects a non-ws wsproxy relay URL', () => {
    expect(() => buildNetDevice({ mode: 'wsproxy', proxyUrl: 'https://proxy.example.com' })).toThrow(
      'ws://',
    );
  });

  it('passes id and peer hints through as router_mac/router_ip', () => {
    expect(
      buildNetDevice({
        mode: 'wisp',
        wispUrl: 'wss://relay.example.com',
        id: 3,
        peerMac: '52:54:00:01:02:03',
        peerIp: '192.168.86.1',
      }),
    ).toEqual({
      relay_url: 'wisps://relay.example.com',
      id: 3,
      router_mac: '52:54:00:01:02:03',
      router_ip: '192.168.86.1',
    });
  });

  it('leaves optional fields off when they are not configured', () => {
    const device = buildNetDevice({ mode: 'fetch' });
    expect(device).not.toHaveProperty('id');
    expect(device).not.toHaveProperty('router_mac');
    expect(device).not.toHaveProperty('router_ip');
  });

  it('emits a relay_url v86 recognizes for every non-off mode', () => {
    const devices = [
      buildNetDevice({ mode: 'inbrowser' }),
      buildNetDevice({ mode: 'fetch' }),
      buildNetDevice({ mode: 'wisp', wispUrl: 'wss://relay.example.com' }),
      buildNetDevice({ mode: 'wsproxy', proxyUrl: 'wss://proxy.example.com' }),
    ];
    for (const device of devices) {
      expect(device?.relay_url).toMatch(/^(fetch|inbrowser|wisp:\/\/|wisps:\/\/|ws:\/\/|wss:\/\/)/);
    }
  });
});

describe('applyNetwork', () => {
  it('attaches the built device to v86 options', () => {
    const options: V86Options = {};
    applyNetwork(options, { mode: 'fetch' });
    expect(options.net_device).toEqual({ relay_url: 'fetch' });
  });

  it('clears net_device in airplane mode', () => {
    const options: V86Options = { net_device: { relay_url: 'fetch' } };
    applyNetwork(options, { mode: 'off' });
    expect(options.net_device).toBeUndefined();
  });

  it('returns the device it attached', () => {
    const options: V86Options = {};
    expect(applyNetwork(options, { mode: 'inbrowser' })).toEqual({ relay_url: 'inbrowser' });
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
