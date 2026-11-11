import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BOOT_EGRESS_ALLOWLIST,
  InMemoryEgressLog,
  installEgressInterceptor,
  isEgressAllowed,
  type EgressAllowlist,
} from '@/core/security/egress.js';

class FakeWebSocket {
  readonly url: string;
  constructor(url: string | URL, _protocols?: string | string[]) {
    this.url = String(url);
  }
}

class FakeEventSource {
  readonly url: string;
  constructor(url: string | URL, _init?: EventSourceInit) {
    this.url = String(url);
  }
}

class FakeXMLHttpRequest {
  openedMethod = '';
  openedUrl = '';
  open(method: string, url: string | URL): void {
    this.openedMethod = method;
    this.openedUrl = String(url);
  }
  send(): void {}
}

describe('installEgressInterceptor', () => {
  let log: InMemoryEgressLog;
  let restore: (() => void) | undefined;

  beforeEach(() => {
    log = new InMemoryEgressLog();
  });

  afterEach(() => {
    restore?.();
    restore = undefined;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete (navigator as unknown as { sendBeacon?: unknown }).sendBeacon;
    delete (globalThis as unknown as { sendBeacon?: unknown }).sendBeacon;
  });

  it('logs allowed fetch calls and forwards them', async () => {
    const fetchMock = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);
    restore = installEgressInterceptor(log, false);

    const response = await fetch('https://example.com/data');
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(log.list()[0]).toEqual(
      expect.objectContaining({
        url: 'https://example.com/data',
        method: 'GET',
        blocked: false,
      }),
    );
  });

  it('records the request method', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok')));
    restore = installEgressInterceptor(log, false);

    await fetch('https://example.com', { method: 'POST' });
    expect(log.list()[0]!.method).toBe('POST');
  });

  it('blocks and logs fetch calls in lockdown', async () => {
    const fetchMock = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);
    restore = installEgressInterceptor(log, true);

    await expect(fetch('https://example.com/secret')).rejects.toThrow('lockdown');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(log.list()[0]).toEqual(
      expect.objectContaining({
        url: 'https://example.com/secret',
        blocked: true,
        reason: 'lockdown',
      }),
    );
  });

  it('logs WebSocket connections', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    restore = installEgressInterceptor(log, false);

    const socket = new WebSocket('wss://example.com/socket');
    expect(socket).toBeInstanceOf(FakeWebSocket);
    expect(log.list()[0]).toEqual(
      expect.objectContaining({
        url: 'wss://example.com/socket',
        method: 'WS',
        blocked: false,
      }),
    );
  });

  it('blocks WebSocket connections in lockdown', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    restore = installEgressInterceptor(log, true);

    expect(() => new WebSocket('wss://example.com/socket')).toThrow('lockdown');
    expect(log.list()[0]).toEqual(
      expect.objectContaining({
        url: 'wss://example.com/socket',
        blocked: true,
        reason: 'lockdown',
      }),
    );
  });

  it('logs XMLHttpRequest.open', () => {
    vi.stubGlobal('XMLHttpRequest', FakeXMLHttpRequest);
    restore = installEgressInterceptor(log, false);

    const xhr = new XMLHttpRequest() as unknown as FakeXMLHttpRequest;
    xhr.open('POST', 'https://example.com/xhr');
    expect(xhr.openedMethod).toBe('POST');
    expect(xhr.openedUrl).toBe('https://example.com/xhr');
    expect(log.list()[0]).toEqual(
      expect.objectContaining({
        url: 'https://example.com/xhr',
        method: 'POST',
        blocked: false,
      }),
    );
  });

  it('blocks XMLHttpRequest.open in lockdown', () => {
    vi.stubGlobal('XMLHttpRequest', FakeXMLHttpRequest);
    restore = installEgressInterceptor(log, true);

    const xhr = new XMLHttpRequest() as unknown as FakeXMLHttpRequest;
    expect(() => xhr.open('GET', 'https://example.com/xhr')).toThrow('lockdown');
    expect(log.list()[0]).toEqual(
      expect.objectContaining({
        url: 'https://example.com/xhr',
        blocked: true,
        reason: 'lockdown',
      }),
    );
  });

  it('logs EventSource connections', () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    restore = installEgressInterceptor(log, false);

    const source = new EventSource('https://example.com/events');
    expect(source).toBeInstanceOf(FakeEventSource);
    expect(log.list()[0]).toEqual(
      expect.objectContaining({
        url: 'https://example.com/events',
        method: 'GET',
        blocked: false,
      }),
    );
  });

  it('blocks EventSource connections in lockdown', () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    restore = installEgressInterceptor(log, true);

    expect(() => new EventSource('https://example.com/events')).toThrow('lockdown');
    expect(log.list()[0]).toEqual(
      expect.objectContaining({
        url: 'https://example.com/events',
        blocked: true,
        reason: 'lockdown',
      }),
    );
  });

  it('logs navigator.sendBeacon', () => {
    const beacon = vi.fn(() => true);
    (navigator as unknown as { sendBeacon: unknown }).sendBeacon = beacon;
    restore = installEgressInterceptor(log, false);

    const accepted = navigator.sendBeacon('https://example.com/beacon', 'payload');
    expect(accepted).toBe(true);
    expect(beacon).toHaveBeenCalledOnce();
    expect(log.list()[0]).toEqual(
      expect.objectContaining({
        url: 'https://example.com/beacon',
        method: 'POST',
        blocked: false,
      }),
    );
  });

  it('blocks navigator.sendBeacon in lockdown', () => {
    const beacon = vi.fn(() => true);
    (navigator as unknown as { sendBeacon: unknown }).sendBeacon = beacon;
    restore = installEgressInterceptor(log, true);

    const accepted = navigator.sendBeacon('https://example.com/beacon');
    expect(accepted).toBe(false);
    expect(beacon).not.toHaveBeenCalled();
    expect(log.list()[0]).toEqual(
      expect.objectContaining({
        url: 'https://example.com/beacon',
        blocked: true,
        reason: 'lockdown',
      }),
    );
  });

  it('logs a global sendBeacon when one exists', () => {
    const g = globalThis as unknown as {
      sendBeacon?: (url: string | URL, data?: BodyInit | null) => boolean;
    };
    const beacon = vi.fn(() => true);
    g.sendBeacon = beacon;
    restore = installEgressInterceptor(log, false);

    expect(g.sendBeacon!('https://example.com/global-beacon')).toBe(true);
    expect(beacon).toHaveBeenCalledOnce();
    expect(log.list()[0]).toEqual(
      expect.objectContaining({
        url: 'https://example.com/global-beacon',
        method: 'POST',
        blocked: false,
      }),
    );
  });

  it('restores every patched global', () => {
    const originalFetch = globalThis.fetch;
    const originalWebSocket = globalThis.WebSocket;
    const originalEventSource = globalThis.EventSource;

    restore = installEgressInterceptor(log, false);
    restore();
    restore = undefined;

    expect(globalThis.fetch).toBe(originalFetch);
    expect(globalThis.WebSocket).toBe(originalWebSocket);
    expect(globalThis.EventSource).toBe(originalEventSource);
  });
});

describe('InMemoryEgressLog', () => {
  it('adds an id and timestamp to each event', () => {
    const log = new InMemoryEgressLog();
    log.record({ url: 'https://example.com', method: 'GET', blocked: false });
    const event = log.list()[0]!;
    expect(event.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(event.timestamp).toBeTypeOf('number');
  });

  it('caps the log at 1000 events', () => {
    const log = new InMemoryEgressLog();
    for (let i = 0; i < 1001; i += 1) {
      log.record({ url: `https://example.com/${i}`, method: 'GET', blocked: false });
    }
    const events = log.list();
    expect(events).toHaveLength(1000);
    expect(events[0]!.url).toBe('https://example.com/1');
    expect(events.at(-1)!.url).toBe('https://example.com/1000');
  });

  it('returns a copy of the recorded events', () => {
    const log = new InMemoryEgressLog();
    log.record({ url: 'https://example.com', method: 'GET', blocked: false });
    log.list().pop();
    expect(log.list()).toHaveLength(1);
  });
});

describe('isEgressAllowed', () => {
  const allowlist: EgressAllowlist = [
    { host: 'copy.sh' },
    { host: 'hf.co' },
    { urlPrefix: 'data:' },
  ];

  it('matches exact hosts, subdomains, and URL prefixes', () => {
    expect(isEgressAllowed('https://copy.sh/v86/bios/seabios.bin', allowlist)).toBe(true);
    expect(isEgressAllowed('https://us.aws.cdn.hf.co/blob/resolve/main/model.onnx', allowlist)).toBe(
      true,
    );
    expect(isEgressAllowed('data:application/wasm;base64,AGFzbQ==', allowlist)).toBe(true);
  });

  it('does not match other hosts or lookalike domains', () => {
    expect(isEgressAllowed('https://evil.example.com/secret', allowlist)).toBe(false);
    expect(isEgressAllowed('https://copy.sh.evil.example.com/secret', allowlist)).toBe(false);
    expect(isEgressAllowed('https://notcopy.sh/secret', allowlist)).toBe(false);
  });

  it('returns false for an empty allowlist', () => {
    expect(isEgressAllowed('https://copy.sh', [])).toBe(false);
  });
});

describe('BOOT_EGRESS_ALLOWLIST', () => {
  it('covers the v86 boot hosts, the model CDN, and the inlined wasm', () => {
    expect(isEgressAllowed('https://copy.sh/v86/bios/seabios.bin', BOOT_EGRESS_ALLOWLIST)).toBe(
      true,
    );
    expect(isEgressAllowed('https://copy.sh/v86/bios/vgabios.bin', BOOT_EGRESS_ALLOWLIST)).toBe(
      true,
    );
    expect(
      isEgressAllowed(
        'https://huggingface.co/onnx-community/Qwen2.5-1.5B-Instruct/resolve/main/onnx/model.onnx',
        BOOT_EGRESS_ALLOWLIST,
      ),
    ).toBe(true);
    expect(
      isEgressAllowed('https://us.aws.cdn.hf.co/resolve/main/onnx/model.onnx', BOOT_EGRESS_ALLOWLIST),
    ).toBe(true);
    expect(
      isEgressAllowed(
        'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.0/dist/transformers.min.js',
        BOOT_EGRESS_ALLOWLIST,
      ),
    ).toBe(true);
    expect(isEgressAllowed('data:application/wasm;base64,AGFzbQ==', BOOT_EGRESS_ALLOWLIST)).toBe(
      true,
    );
  });

  it('leaves arbitrary hosts blocked', () => {
    expect(isEgressAllowed('https://example.com/secret', BOOT_EGRESS_ALLOWLIST)).toBe(false);
    expect(isEgressAllowed('https://evil.test/collect', BOOT_EGRESS_ALLOWLIST)).toBe(false);
  });
});

describe('installEgressInterceptor allowlist', () => {
  const allowlist: EgressAllowlist = [{ host: 'copy.sh' }, { urlPrefix: 'data:' }];

  let log: InMemoryEgressLog;
  let restore: (() => void) | undefined;

  beforeEach(() => {
    log = new InMemoryEgressLog();
  });

  afterEach(() => {
    restore?.();
    restore = undefined;
    vi.unstubAllGlobals();
    delete (navigator as unknown as { sendBeacon?: unknown }).sendBeacon;
    delete (globalThis as unknown as { sendBeacon?: unknown }).sendBeacon;
  });

  it('lets an allowlisted host through in lockdown and logs blocked: false', async () => {
    const fetchMock = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);
    restore = installEgressInterceptor(log, true, allowlist);

    const response = await fetch('https://copy.sh/v86/bios/seabios.bin');
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(log.list()[0]).toEqual(
      expect.objectContaining({
        url: 'https://copy.sh/v86/bios/seabios.bin',
        blocked: false,
      }),
    );
  });

  it('lets an allowlisted URL prefix through in lockdown', () => {
    vi.stubGlobal('XMLHttpRequest', FakeXMLHttpRequest);
    restore = installEgressInterceptor(log, true, allowlist);

    const xhr = new XMLHttpRequest() as unknown as FakeXMLHttpRequest;
    xhr.open('GET', 'data:application/wasm;base64,AGFzbQ==');
    expect(xhr.openedUrl).toBe('data:application/wasm;base64,AGFzbQ==');
    expect(log.list()[0]).toEqual(
      expect.objectContaining({
        url: 'data:application/wasm;base64,AGFzbQ==',
        blocked: false,
      }),
    );
  });

  it('still blocks arbitrary hosts and logs blocked: true', async () => {
    const fetchMock = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);
    restore = installEgressInterceptor(log, true, allowlist);

    await expect(fetch('https://evil.example.com/secret')).rejects.toThrow('lockdown');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(log.list()[0]).toEqual(
      expect.objectContaining({
        url: 'https://evil.example.com/secret',
        blocked: true,
        reason: 'lockdown',
      }),
    );
  });

  it('keeps the two-argument form blocking everything in lockdown', async () => {
    const fetchMock = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);
    restore = installEgressInterceptor(log, true);

    await expect(fetch('https://copy.sh/v86/bios/seabios.bin')).rejects.toThrow('lockdown');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ignores the allowlist when lockdown is off', async () => {
    const fetchMock = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);
    restore = installEgressInterceptor(log, false, []);

    const response = await fetch('https://evil.example.com/secret');
    expect(response.status).toBe(200);
    expect(log.list()[0]).toEqual(
      expect.objectContaining({ url: 'https://evil.example.com/secret', blocked: false }),
    );
  });
});
