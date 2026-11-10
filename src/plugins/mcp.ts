import type { MCPServer } from '@/types/index.js';

/**
 * MCP (Model Context Protocol) client.
 *
 * GhostShell is an MCP client: community tool servers become plugins. v0.1
 * supports stdio servers tunneled over the VM serial port; v0.2 adds in-Worker
 * servers and HTTP/SSE.
 *
 * See docs/CREATIVE_INNOVATION.md §3.3 and modelcontextprotocol.io.
 */

export interface MCPClient {
  listServers(): MCPServer[];
  addServer(server: MCPServer): void;
  removeServer(name: string): void;
  callTool(server: string, tool: string, args: unknown): Promise<unknown>;
}

export function createMCPClient(): MCPClient {
  const servers = new Map<string, MCPServer>();
  return {
    listServers: () => [...servers.values()],
    addServer(server) {
      servers.set(server.name, server);
    },
    removeServer(name) {
      servers.delete(name);
    },
    async callTool(server, tool, args) {
      const config = servers.get(server);
      if (!config) throw new Error(`Unknown MCP server: ${server}`);
      // TODO: JSON-RPC over stdio (serial) or HTTP/SSE.
      void config;
      void tool;
      void args;
      throw new Error('MCP callTool not implemented (issue #20)');
    },
  };
}
