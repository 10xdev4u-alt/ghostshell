import type { MCPServer } from '@/types/index.js';
import { APP_VERSION } from '@/config.js';

/**
 * MCP (Model Context Protocol) client.
 *
 * GhostShell is an MCP client: community tool servers become plugins.
 * See docs/CREATIVE_INNOVATION.md §3.3 and modelcontextprotocol.io.
 *
 * Transports:
 *  - `http` (Streamable HTTP) is implemented end-to-end over `fetch`: the
 *    `initialize` handshake, `tools/list`, and `tools/call` are JSON-RPC 2.0
 *    POSTs; JSON and `text/event-stream` responses are both accepted.
 *  - `stdio` (in-VM over the VM serial port) and classic `sse` throw
 *    `NotImplementedError`. A real stdio tunnel needs a prebaked in-VM relay
 *    on the guest serial console, which the VM image does not ship yet.
 *
 * Intended wiring (owned by src/app.ts, not modified here):
 *
 *   const mcp = createMCPClient({ fetch });
 *   mcp.addServer({ name: 'filesystem', transport: 'http', url, enabled: true });
 *   await mcp.initializeServer('filesystem');
 *   const tools = await mcp.listTools('filesystem');
 *   // Wrap each MCPTool in a ToolDefinition whose execute() calls
 *   // mcp.callTool('filesystem', tool.name, args), then:
 *   //   createToolRegistry([...builtinTools(), ...mcpToolDefinitions])
 *
 * `tools/list` is fetched once per session and cached; `tools/call` results
 * are returned raw (including the MCP `isError` flag) so callers can decide
 * how to surface them.
 */

/** MCP protocol revision this client speaks. */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

/** Default per-request timeout. */
export const MCP_DEFAULT_TIMEOUT_MS = 30_000;

/** JSON-RPC error returned by the server for a request. */
export class MCPProtocolError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(message: string, code: number, data?: unknown) {
    super(message);
    this.name = 'MCPProtocolError';
    this.code = code;
    this.data = data;
  }
}

/** Transport-level failure: network, HTTP status, malformed payload. */
export class MCPTransportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MCPTransportError';
  }
}

/** A request exceeded the configured timeout. */
export class MCPTimeoutError extends Error {
  readonly method: string;
  readonly timeoutMs: number;

  constructor(method: string, timeoutMs: number) {
    super(`MCP ${method} timed out after ${timeoutMs}ms`);
    this.name = 'MCPTimeoutError';
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

/** A transport that is declared but not implemented yet. */
export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotImplementedError';
  }
}

export interface JSONRPCRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown> | undefined;
}

export interface JSONRPCError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JSONRPCResponse {
  jsonrpc: '2.0';
  id: number | null;
  result?: unknown;
  error?: JSONRPCError | undefined;
}

export interface MCPTool {
  name: string;
  description?: string | undefined;
  inputSchema?: Record<string, unknown> | undefined;
}

export interface MCPToolResult {
  content?: unknown[] | undefined;
  isError?: boolean | undefined;
  [key: string]: unknown;
}

export interface MCPInitializeResult {
  protocolVersion: string;
  capabilities?: Record<string, unknown> | undefined;
  serverInfo?: { name: string; version?: string | undefined } | undefined;
  instructions?: string | undefined;
}

/** Runtime check for entries returned by `tools/list`. */
export function isMCPTool(value: unknown): value is MCPTool {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record['name'] === 'string' && record['name'].length > 0;
}

/**
 * A bidirectional JSON-RPC channel. `request` correlates by id; `notify` is
 * fire-and-forget. Implementations own their timeout and transport errors.
 */
export interface MCPTransport {
  readonly kind: MCPServer['transport'];
  connect(): Promise<void>;
  request(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown>;
  notify(method: string, params?: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
}

export interface MCPTransportFactory {
  create(server: MCPServer): MCPTransport;
}

export interface HTTPTransportOptions {
  fetch?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
  headers?: Record<string, string> | undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Streamable HTTP transport: one POST per JSON-RPC message. */
export class HTTPTransport implements MCPTransport {
  readonly kind = 'http' as const;
  private nextId = 1;
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly defaultTimeoutMs: number;
  private readonly headers: Record<string, string>;
  private sessionId: string | null = null;
  private closed = false;

  constructor(
    private readonly server: MCPServer,
    options: HTTPTransportOptions = {},
  ) {
    if (!server.url) {
      throw new MCPTransportError(`MCP server "${server.name}" has no url`);
    }
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (!fetchImpl) {
      throw new MCPTransportError('fetch is unavailable in this environment');
    }
    this.url = server.url;
    this.fetchImpl = fetchImpl;
    this.defaultTimeoutMs = options.timeoutMs ?? MCP_DEFAULT_TIMEOUT_MS;
    this.headers = options.headers ?? {};
  }

  async connect(): Promise<void> {
    if (this.closed) throw new MCPTransportError('MCP transport is closed');
    // Streamable HTTP has no persistent connection; `initialize` is the handshake.
  }

  async request(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;
    return this.post(
      { jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) },
      timeoutMs ?? this.defaultTimeoutMs,
      true,
      method,
    );
  }

  async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    await this.post(
      { jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) },
      this.defaultTimeoutMs,
      false,
      method,
    );
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private async post(
    message: Record<string, unknown>,
    timeoutMs: number,
    expectResponse: boolean,
    method: string,
  ): Promise<unknown> {
    if (this.closed) throw new MCPTransportError('MCP transport is closed');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
    try {
      const response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...this.headers,
          ...(this.sessionId !== null ? { 'Mcp-Session-Id': this.sessionId } : {}),
        },
        body: JSON.stringify(message),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new MCPTransportError(
          `MCP server "${this.server.name}" returned HTTP ${response.status}` +
            (body ? `: ${body.slice(0, 500)}` : ''),
        );
      }

      // Streamable HTTP servers issue a session id on `initialize`; every
      // later request must present it or the server rejects the call.
      const sessionId = response.headers.get('mcp-session-id');
      if (sessionId) this.sessionId = sessionId;

      const contentType = response.headers.get('content-type') ?? '';
      const text = await response.text();
      if (contentType.includes('text/event-stream')) {
        return this.parseSse(text, expectResponse ? (message['id'] as number) : undefined, method);
      }
      if (!text.trim()) {
        if (expectResponse) {
          throw new MCPTransportError(
            `MCP server "${this.server.name}" returned an empty response to ${method}`,
          );
        }
        return undefined;
      }
      return this.parseJsonRpc(JSON.parse(text), expectResponse, method);
    } catch (error) {
      if (controller.signal.aborted) throw new MCPTimeoutError(method, timeoutMs);
      if (
        error instanceof MCPTransportError ||
        error instanceof MCPProtocolError ||
        error instanceof MCPTimeoutError
      ) {
        throw error;
      }
      throw new MCPTransportError(`MCP request "${method}" failed: ${errorMessage(error)}`, {
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private parseJsonRpc(payload: unknown, expectResponse: boolean, method: string): unknown {
    if (!expectResponse) return undefined;
    if (typeof payload !== 'object' || payload === null) {
      throw new MCPTransportError(
        `MCP server "${this.server.name}" returned a non-object response to ${method}`,
      );
    }
    const response = payload as Partial<JSONRPCResponse>;
    if (response.jsonrpc !== '2.0') {
      throw new MCPTransportError(
        `MCP server "${this.server.name}" returned an invalid JSON-RPC response`,
      );
    }
    if (response.error !== undefined) {
      const error = response.error;
      if (
        typeof error !== 'object' ||
        error === null ||
        typeof error.code !== 'number' ||
        typeof error.message !== 'string'
      ) {
        throw new MCPTransportError(
          `MCP server "${this.server.name}" returned a malformed JSON-RPC error`,
        );
      }
      throw new MCPProtocolError(error.message, error.code, error.data);
    }
    if (response.id === undefined || response.id === null) {
      throw new MCPTransportError(
        `MCP server "${this.server.name}" returned no JSON-RPC id for ${method}`,
      );
    }
    return response.result;
  }

  /**
   * Extract the JSON-RPC response for `expectedId` from an SSE body. Servers
   * may interleave keep-alives and other events, so every `data:` payload is
   * inspected until the matching id appears.
   */
  private parseSse(text: string, expectedId: number | undefined, method: string): unknown {
    if (expectedId === undefined) return undefined;
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice('data:'.length).trimStart())
        .join('\n');
      if (!data) continue;
      let payload: unknown;
      try {
        payload = JSON.parse(data);
      } catch {
        continue;
      }
      if (typeof payload !== 'object' || payload === null) continue;
      if ((payload as Record<string, unknown>)['id'] !== expectedId) continue;
      return this.parseJsonRpc(payload, true, method);
    }
    throw new MCPTransportError(
      `MCP server "${this.server.name}" returned no response for ${method} (id ${expectedId})`,
    );
  }
}

/**
 * Default transport factory. `stdio` and classic `sse` are declared in the
 * schema but throw `NotImplementedError` until their guest-side relays exist.
 */
export function createDefaultTransportFactory(
  options: HTTPTransportOptions = {},
): MCPTransportFactory {
  return {
    create(server) {
      if (server.transport === 'stdio') {
        throw new NotImplementedError(
          'stdio MCP servers are not implemented yet: they need an in-VM relay on the guest ' +
            'serial port. Configure the server with transport "http" instead (issue #27).',
        );
      }
      if (server.transport === 'sse') {
        throw new NotImplementedError(
          'classic SSE MCP servers are not implemented yet: use transport "http" ' +
            '(Streamable HTTP) instead (issue #27).',
        );
      }
      return new HTTPTransport(server, options);
    },
  };
}

export interface MCPClientOptions {
  /** Override the transport factory (tests inject a fake here). */
  transportFactory?: MCPTransportFactory | undefined;
  /** Per-request timeout. Defaults to 30s. */
  timeoutMs?: number | undefined;
  /** `fetch` implementation for the default HTTP transport. */
  fetch?: typeof fetch | undefined;
}

interface MCPSession {
  server: MCPServer;
  transport: MCPTransport;
  tools: MCPTool[];
}

export interface MCPClient {
  listServers(): MCPServer[];
  addServer(server: MCPServer): void;
  removeServer(name: string): Promise<void>;
  setServerEnabled(name: string, enabled: boolean): void;
  /** Run the `initialize` handshake and cache the session. */
  initializeServer(name: string): Promise<void>;
  listTools(server: string): Promise<MCPTool[]>;
  callTool(server: string, tool: string, args: unknown): Promise<MCPToolResult>;
  dispose(): Promise<void>;
}

export function createMCPClient(options: MCPClientOptions = {}): MCPClient {
  const timeoutMs = options.timeoutMs ?? MCP_DEFAULT_TIMEOUT_MS;
  const transportFactory =
    options.transportFactory ??
    createDefaultTransportFactory({ fetch: options.fetch, timeoutMs });
  const servers = new Map<string, MCPServer>();
  const sessions = new Map<string, MCPSession>();

  const withTimeout = <T>(promise: Promise<T>, method: string): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new MCPTimeoutError(method, timeoutMs)),
        Math.max(1, timeoutMs),
      );
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });

  const fetchTools = async (server: MCPServer, transport: MCPTransport): Promise<MCPTool[]> => {
    const result = await withTimeout(
      transport.request('tools/list', {}, timeoutMs),
      'tools/list',
    );
    const tools = (result as { tools?: unknown } | null)?.tools;
    if (!Array.isArray(tools)) {
      throw new MCPProtocolError(
        `MCP server "${server.name}" returned an invalid tools/list result`,
        -32603,
      );
    }
    return tools.filter(isMCPTool);
  };

  const ensureSession = async (name: string): Promise<MCPSession> => {
    const existing = sessions.get(name);
    if (existing) return existing;

    const server = servers.get(name);
    if (!server) throw new Error(`Unknown MCP server: ${name}`);
    if (!server.enabled) throw new Error(`MCP server is disabled: ${name}`);

    const transport = transportFactory.create(server);
    await withTimeout(transport.connect(), 'connect');
    try {
      const init = (await withTimeout(
        transport.request(
          'initialize',
          {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'ghostshell', version: APP_VERSION },
          },
          timeoutMs,
        ),
        'initialize',
      )) as MCPInitializeResult;
      if (typeof init !== 'object' || init === null || typeof init.protocolVersion !== 'string') {
        throw new MCPTransportError(`MCP server "${name}" returned an invalid initialize result`);
      }
      await withTimeout(
        transport.notify('notifications/initialized', {}),
        'notifications/initialized',
      );
      const tools = await fetchTools(server, transport);
      const session: MCPSession = { server, transport, tools };
      sessions.set(name, session);
      return session;
    } catch (error) {
      await transport.close().catch(() => undefined);
      throw error;
    }
  };

  const cloneServer = (server: MCPServer): MCPServer => ({
    ...server,
    ...(server.args !== undefined ? { args: [...server.args] } : {}),
  });

  const initializeServer = async (name: string): Promise<void> => {
    await ensureSession(name);
  };

  return {
    listServers: () => [...servers.values()].map(cloneServer),

    addServer(server) {
      if (!server.name.trim()) throw new Error('MCP server name is required');
      if (servers.has(server.name)) {
        throw new Error(`MCP server already registered: ${server.name}`);
      }
      if (server.transport === 'stdio' && !server.command?.trim()) {
        throw new Error(`MCP server "${server.name}" requires a command for stdio transport`);
      }
      if (server.transport !== 'stdio' && !server.url?.trim()) {
        throw new Error(
          `MCP server "${server.name}" requires a url for ${server.transport} transport`,
        );
      }
      servers.set(server.name, cloneServer(server));
    },

    async removeServer(name) {
      if (!servers.has(name)) throw new Error(`Unknown MCP server: ${name}`);
      const session = sessions.get(name);
      if (session) {
        sessions.delete(name);
        await session.transport.close().catch(() => undefined);
      }
      servers.delete(name);
    },

    setServerEnabled(name, enabled) {
      const server = servers.get(name);
      if (!server) throw new Error(`Unknown MCP server: ${name}`);
      servers.set(name, { ...server, enabled });
      if (!enabled) {
        const session = sessions.get(name);
        if (session) {
          sessions.delete(name);
          void session.transport.close().catch(() => undefined);
        }
      }
    },

    initializeServer,

    async listTools(server) {
      const session = await ensureSession(server);
      return session.tools.map((tool) => ({ ...tool }));
    },

    async callTool(server, tool, args) {
      const session = await ensureSession(server);
      const result = await withTimeout(
        session.transport.request(
          'tools/call',
          { name: tool, ...(args !== undefined ? { arguments: args } : {}) },
          timeoutMs,
        ),
        'tools/call',
      );
      if (typeof result !== 'object' || result === null) {
        throw new MCPProtocolError(
          `MCP server "${server}" returned an invalid tools/call result`,
          -32603,
        );
      }
      return result as MCPToolResult;
    },

    async dispose() {
      const closers = [...sessions.values()].map((session) =>
        session.transport.close().catch(() => undefined),
      );
      sessions.clear();
      await Promise.all(closers);
    },
  };
}
