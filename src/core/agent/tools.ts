import type { JSONSchema, ToolDefinition } from '@/types/index.js';

/**
 * Built-in tools.
 *
 * v0.1 ships exactly five: bash, read_file, write_file, list_dir, search.
 * Each `execute` receives a `ToolContext` whose `vm` is the v86 handle.
 *
 * Security notes:
 *  - Every command runs inside the VM; the host is never touched.
 *  - `bash` output is capped (see MAX_OUTPUT) to avoid blowing the context.
 *  - No tool may access the network unless `config.networkMode` allows it.
 */

export const MAX_OUTPUT_CHARS = 12_000;

const stringProp = (description: string) => ({ type: 'string' as const, description });

export function builtinTools(): ToolDefinition[] {
  return [
    {
      name: 'bash',
      description:
        'Run a shell command inside the Linux VM. Output is truncated to 12,000 chars. ' +
        'Use `timeout` for long-running commands.',
      parameters: {
        type: 'object',
        properties: {
          command: stringProp('The shell command to execute.'),
          timeout_ms: { type: 'number', description: 'Timeout in milliseconds (max 120000).' },
        },
        required: ['command'],
      },
      execute: async (ctx, args) => {
        const command = String(args['command'] ?? '');
        const timeoutMs = Math.min(Number(args['timeout_ms'] ?? 60_000), 120_000);
        if (!command.trim()) return { ok: false, content: 'Empty command.' };
        // TODO: ctx.vm.exec(command, timeoutMs), cap output
        throw new Error('bash tool not implemented (issue #13)');
      },
    },
    {
      name: 'read_file',
      description: 'Read a file from the VM filesystem. Returns content with line numbers.',
      parameters: {
        type: 'object',
        properties: { path: stringProp('Absolute path inside the VM.') },
        required: ['path'],
      },
      execute: async (ctx, args) => {
        const path = String(args['path'] ?? '');
        // TODO: ctx.vm.read(path), number lines, cap length
        throw new Error('read_file tool not implemented (issue #13)');
      },
    },
    {
      name: 'write_file',
      description: 'Write (overwrite) a file in the VM filesystem. Creates parent dirs.',
      parameters: {
        type: 'object',
        properties: {
          path: stringProp('Absolute path inside the VM.'),
          content: stringProp('Full file content.'),
        },
        required: ['path', 'content'],
      },
      execute: async (ctx, args) => {
        const path = String(args['path'] ?? '');
        const content = String(args['content'] ?? '');
        // TODO: ctx.vm.write(path, content)
        throw new Error('write_file tool not implemented (issue #13)');
      },
    },
    {
      name: 'list_dir',
      description: 'List a directory in the VM. Returns name, kind, size, mtime.',
      parameters: {
        type: 'object',
        properties: { path: stringProp('Absolute directory path.') },
        required: ['path'],
      },
      execute: async (ctx, args) => {
        const path = String(args['path'] ?? '');
        // TODO: ctx.vm.list(path)
        throw new Error('list_dir tool not implemented (issue #13)');
      },
    },
    {
      name: 'search',
      description:
        'Search file contents in the VM using ripgrep. Returns matching lines with paths.',
      parameters: {
        type: 'object',
        properties: {
          pattern: stringProp('Regex pattern to search for.'),
          path: stringProp('Directory to search (default /root/workspace).'),
          glob: stringProp('Optional glob filter, e.g. "*.ts".'),
        },
        required: ['pattern'],
      },
      execute: async (ctx, args) => {
        const pattern = String(args['pattern'] ?? '');
        const path = String(args['path'] ?? '/root/workspace');
        const glob = args['glob'] ? String(args['glob']) : undefined;
        // TODO: run ripgrep in VM, cap output
        throw new Error('search tool not implemented (issue #13)');
      },
    },
  ];
}

export function toolToSchema(tools: ToolDefinition[]): JSONSchema {
  return {
    type: 'object',
    properties: Object.fromEntries(
      tools.map((t) => [
        t.name,
        { type: 'object', description: t.description, properties: t.parameters.properties },
      ]),
    ),
    required: tools.map((t) => t.name),
  };
}
