import { describe, expect, it, vi } from 'vitest';
import type { MCPServer } from '@/types/index.js';
import {
  HTTPTransport,
  MCP_PROTOCOL_VERSION,
  MCPProtocolError,
  MCPTimeoutError,
  MCPTransportError,
  NotImplementedError,
  createMCPClient,
  type JSONRPCError,
  type MCPTool,
  type MCPTransport,
  type MCPTransportFactory,
} from '@/plugins/mcp.js';

class FakeTransport implements MCPTransport {
  readonly kind = 'http' as const;
  connected = false;
  closed = false;
  tools: MCPTool[] = [];
  callResult: unknown = { content: [{ type: 'text', text: 'ok' }] };
  readonly requests: Array<{ method: string; params?: Record<string, unknown> | undefined }> = [];
  readonly notifications: Array<{ method: string; params?: Record<string, unknown> | undefined }> =
    [];
  readonly errorByMethod = new Map<string, JSONRPCError>();
  readonly hangMethods = new Set<string>();

  async connect(): Promise<void> {
    this.connected = true;
  }

  async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.requests.push({ method, params });
    if (this.hangMethods.has(method)) return new Promise<unknown>(() => undefined);
    const error = this.errorByMethod.get(method);
    if (error) throw new MCPProtocolError(error.message, error.code, error.data);
    if (method === 'initialize') {
      return {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'fake', version: '1.0.0' },
      };
    }
    if (method === 'tools/list') return { tools: this.tools };
    if (method === 'tools/call') return this.callResult;
    return {};
  }

  async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    this.notifications.push({ method, params });
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeTransportFactory implements MCPTransportFactory {
  readonly transports: FakeTransport[] = [];

  constructor(private readonly template?: FakeTransport) {}

  create(): MCPTransport {
    const transport = this.template ?? new FakeTransport();
    this.transports.push(transport);
    return transport;
  }
}

function makeServer(overrides: Partial<MCPServer> = {}): MCPServer {
  return {
    name: 'fake',
    transport: 'http',
    url: 'https://example.test/mcp',
    enabled: true,
    ...overrides,
  };
}

describe('MCP server registry', () => {
  it('registers, lists, disables, and removes servers', async () => {
    const client = createMCPClient({ transportFactory: new FakeTransportFactory() });
    client.addServer(makeServer());

    expect(client.listServers().map((server) => server.name)).toEqual(['fake']);

    client.setServerEnabled('fake', false);
    expect(client.listServers()[0]!.enabled).toBe(false);

    await client.removeServer('fake');
    expect(client.listServers()).toEqual([]);
  });

  it('rejects invalid and duplicate servers', async () => {
    const client = createMCPClient({ transportFactory: new FakeTransportFactory() });

    expect(() => client.addServer({ name: 'a', transport: 'stdio', enabled: true })).toThrow(
      'requires a command',
    );
    expect(() => client.addServer({ name: 'b', transport: 'http', enabled: true })).toThrow(
      'requires a url',
    );
    expect(() => client.addServer({ name: 'c', transport: 'sse', enabled: true })).toThrow(
      'requires a url',
    );

    client.addServer(makeServer());
    expect(() => client.addServer(makeServer())).toThrow('already registered');
    await expect(client.removeServer('missing')).rejects.toThrow('Unknown MCP server');
  });

  it('throws NotImplementedError for stdio servers', async () => {
    const client = createMCPClient();
    client.addServer({
      name: 'local',
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      enabled: true,
    });

    await expect(client.callTool('local', 'anything', {})).rejects.toThrow(NotImplementedError);
    await expect(client.callTool('local', 'anything', {})).rejects.toThrow(
      /stdio MCP servers are not implemented/,
    );
  });

  it('throws NotImplementedError for classic SSE servers', async () => {
    const client = createMCPClient();
    client.addServer(makeServer({ transport: 'sse', url: 'https://example.test/sse' }));

    await expect(client.callTool('fake', 'anything', {})).rejects.toThrow(NotImplementedError);
    await expect(client.callTool('fake', 'anything', {})).rejects.toThrow(
      /classic SSE MCP servers are not implemented/,
    );
  });
});

describe('MCP client', () => {
  it('performs the initialize -> tools/list -> tools/call handshake', async () => {
    const factory = new FakeTransportFactory();
    const client = createMCPClient({ transportFactory: factory });
    client.addServer(makeServer());

    const result = await client.callTool('fake', 'read', { path: '/tmp/x' });

    expect(result).toEqual({ content: [{ type: 'text', text: 'ok' }] });
    const transport = factory.transports[0]!;
    expect(transport.requests.map((request) => request.method)).toEqual([
      'initialize',
      'tools/list',
      'tools/call',
    ]);
    expect(transport.notifications.map((notification) => notification.method)).toEqual([
      'notifications/initialized',
    ]);
    expect(transport.requests[0]!.params).toMatchObject({
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'ghostshell', version: '0.1.0' },
    });
    expect(transport.requests[2]!.params).toEqual({
      name: 'read',
      arguments: { path: '/tmp/x' },
    });
  });

  it('caches the handshake across calls', async () => {
    const factory = new FakeTransportFactory();
    const client = createMCPClient({ transportFactory: factory });
    client.addServer(makeServer());

    await client.callTool('fake', 'first', {});
    await client.callTool('fake', 'second', {});

    expect(factory.transports[0]!.requests.map((request) => request.method)).toEqual([
      'initialize',
      'tools/list',
      'tools/call',
      'tools/call',
    ]);
  });

  it('lists the tools advertised by the server', async () => {
    const transport = new FakeTransport();
    transport.tools = [
      { name: 'read', description: 'Read a file', inputSchema: { type: 'object' } },
    ];
    const client = createMCPClient({ transportFactory: new FakeTransportFactory(transport) });
    client.addServer(makeServer());

    await expect(client.listTools('fake')).resolves.toEqual([
      { name: 'read', description: 'Read a file', inputSchema: { type: 'object' } },
    ]);
  });

  it('maps JSON-RPC errors to MCPProtocolError', async () => {
    const transport = new FakeTransport();
    transport.errorByMethod.set('tools/call', { code: -32000, message: 'tool exploded' });
    const client = createMCPClient({ transportFactory: new FakeTransportFactory(transport) });
    client.addServer(makeServer());

    await expect(client.callTool('fake', 'boom', {})).rejects.toMatchObject({
      name: 'MCPProtocolError',
      code: -32000,
      message: 'tool exploded',
    });
  });

  it('closes the transport when the handshake fails', async () => {
    const transport = new FakeTransport();
    transport.errorByMethod.set('initialize', { code: -32602, message: 'bad protocol version' });
    const client = createMCPClient({ transportFactory: new FakeTransportFactory(transport) });
    client.addServer(makeServer());

    await expect(client.initializeServer('fake')).rejects.toThrow('bad protocol version');
    expect(transport.closed).toBe(true);
  });

  it('rejects unknown and disabled servers', async () => {
    const client = createMCPClient({ transportFactory: new FakeTransportFactory() });

    await expect(client.callTool('nope', 'x', {})).rejects.toThrow('Unknown MCP server');

    client.addServer(makeServer());
    client.setServerEnabled('fake', false);
    await expect(client.callTool('fake', 'x', {})).rejects.toThrow('disabled');
  });

  it('times out a hung request', async () => {
    const transport = new FakeTransport();
    transport.hangMethods.add('tools/call');
    const client = createMCPClient({
      transportFactory: new FakeTransportFactory(transport),
      timeoutMs: 20,
    });
    client.addServer(makeServer());

    await expect(client.callTool('fake', 'slow', {})).rejects.toBeInstanceOf(MCPTimeoutError);
  });

  it('closes the transport when the server is removed', async () => {
    const transport = new FakeTransport();
    const client = createMCPClient({ transportFactory: new FakeTransportFactory(transport) });
    client.addServer(makeServer());
    await client.initializeServer('fake');
    expect(transport.connected).toBe(true);

    await client.removeServer('fake');
    expect(transport.closed).toBe(true);
  });
});

describe('HTTPTransport', () => {
  const server: MCPServer = {
    name: 'remote',
    transport: 'http',
    url: 'https://example.test/mcp',
    enabled: true,
  };

  function jsonResponse(payload: unknown, status = 200): Response {
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  it('posts a JSON-RPC request and parses the JSON response', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({ jsonrpc: '2.0', id: 1, result: { ok: true } }),
    );
    const transport = new HTTPTransport(server, {
      fetch: fetchImpl,
      timeoutMs: 1000,
    });

    await expect(transport.request('initialize', { protocolVersion: MCP_PROTOCOL_VERSION })).resolves.toEqual({
      ok: true,
    });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://example.test/mcp');
    expect(init!.method).toBe('POST');
    expect(init!.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init!.body as string)).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: MCP_PROTOCOL_VERSION },
    });
  });

  it('propagates the Mcp-Session-Id header after initialize', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string) as { id: number; method: string };
      if (body.method === 'initialize') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { ok: true } }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'mcp-session-id': 'session-123',
          },
        });
      }
      return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { ok: true } });
    });
    const transport = new HTTPTransport(server, { fetch: fetchImpl, timeoutMs: 1000 });

    await transport.request('initialize', {});
    await transport.request('tools/list', {});

    expect(fetchImpl.mock.calls[1]![1]!.headers).toMatchObject({
      'Mcp-Session-Id': 'session-123',
    });
  });

  it('parses an SSE response', async () => {
    const body = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n\n';
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
    const transport = new HTTPTransport(server, { fetch: fetchImpl, timeoutMs: 1000 });

    await expect(transport.request('tools/list', {})).resolves.toEqual({ tools: [] });
  });

  it('maps HTTP errors to MCPTransportError', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('nope', { status: 500 }));
    const transport = new HTTPTransport(server, { fetch: fetchImpl, timeoutMs: 1000 });

    await expect(transport.request('initialize', {})).rejects.toThrow(MCPTransportError);
    await expect(transport.request('initialize', {})).rejects.toThrow(/HTTP 500/);
  });

  it('maps JSON-RPC errors to MCPProtocolError', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'no such method' } }),
    );
    const transport = new HTTPTransport(server, { fetch: fetchImpl, timeoutMs: 1000 });

    await expect(transport.request('initialize', {})).rejects.toMatchObject({
      name: 'MCPProtocolError',
      code: -32601,
    });
  });

  it('times out an aborted request', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }),
    );
    const transport = new HTTPTransport(server, { fetch: fetchImpl, timeoutMs: 20 });

    await expect(transport.request('initialize', {})).rejects.toBeInstanceOf(MCPTimeoutError);
  });

  it('posts notifications without an id and tolerates an empty 202', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('', { status: 202 }));
    const transport = new HTTPTransport(server, { fetch: fetchImpl, timeoutMs: 1000 });

    await expect(transport.notify('notifications/initialized', {})).resolves.toBeUndefined();

    const body = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string);
    expect(body).toEqual({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {},
    });
    expect(body.id).toBeUndefined();
  });
});
