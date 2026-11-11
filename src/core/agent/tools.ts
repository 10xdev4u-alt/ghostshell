import type { CommandResult, JSONSchema, ToolContext, ToolDefinition } from '@/types/index.js';
import { formatBytes } from '@/lib/utils.js';

/**
 * Built-in tools.
 *
 * v0.1 ships exactly five: bash, read_file, write_file, list_dir, search.
 * Each `execute` receives a `ToolContext` whose `vm` is the v86 handle.
 *
 * Security notes:
 *  - Every command runs inside the VM; the host is never touched.
 *  - Every tool's output is capped (see MAX_OUTPUT_CHARS) to avoid blowing
 *    the context window.
 *  - No tool may access the network unless the VM image allows it; the tools
 *    themselves never make host network calls.
 */

export const MAX_OUTPUT_CHARS = 12_000;

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 120_000;

const stringProp = (description: string) => ({ type: 'string' as const, description });

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Cap tool output at `max` characters, marking how much was removed.
 * The returned string is never longer than `max`.
 */
export function truncateOutput(text: string, max: number = MAX_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  const suffix = `…[truncated ${text.length - max} chars]`;
  return `${text.slice(0, Math.max(0, max - suffix.length))}${suffix}`;
}

/** Quote a value for safe interpolation into a shell command. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function formatTimestamp(ms: number): string {
  if (!Number.isFinite(ms)) return '-';
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

function combineOutputs(stdout: string, stderr: string): string {
  const parts: string[] = [];
  const out = stdout.trim();
  const err = stderr.trim();
  if (out) parts.push(stdout.trimEnd());
  if (err) parts.push(stderr.trimEnd());
  return parts.join('\n');
}

/**
 * Run a guest command that honors the run's abort signal.
 *
 * On abort, send Ctrl-C (`\x03`) over the serial console so the guest command
 * stops instead of running to completion, then reject. The underlying `exec`
 * promise settles on its own once the interrupt lands; the tool's caller sees
 * the rejection immediately.
 */
function execWithAbort(
  ctx: ToolContext,
  command: string,
  timeoutMs: number,
): Promise<CommandResult> {
  const signal = ctx.signal;
  if (!signal) return ctx.vm.exec(command, timeoutMs);
  if (signal.aborted) throw new Error('aborted');

  return new Promise<CommandResult>((resolve, reject) => {
    let settled = false;

    function onAbort(): void {
      if (settled) return;
      settled = true;
      try {
        ctx.vm.sendSerial('\x03');
      } catch {
        // Best effort: the tool still rejects below.
      }
      reject(new Error('aborted'));
    }

    signal.addEventListener('abort', onAbort, { once: true });
    ctx.vm.exec(command, timeoutMs).then(
      (result) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      },
      (err: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

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
        const command = String(args['command'] ?? '').trim();
        if (!command) return { ok: false, content: 'Empty command.' };

        const requested = Number(args['timeout_ms'] ?? DEFAULT_TIMEOUT_MS);
        const timeoutMs = Math.min(
          Math.max(Number.isFinite(requested) ? requested : DEFAULT_TIMEOUT_MS, 1),
          MAX_TIMEOUT_MS,
        );

        try {
          const result = await execWithAbort(ctx, command, timeoutMs);
          const body = combineOutputs(result.stdout, result.stderr);
          const lines: string[] = [];
          if (result.timedOut) lines.push(`Command timed out after ${timeoutMs}ms`);
          if (body) lines.push(body);
          lines.push(`[exit ${result.exitCode}] [${result.durationMs}ms]`);

          return {
            ok: result.exitCode === 0 && !result.timedOut,
            content: truncateOutput(lines.join('\n')),
            metadata: {
              exitCode: result.exitCode,
              durationMs: result.durationMs,
              timedOut: result.timedOut,
            },
          };
        } catch (err) {
          // An abort is not a tool failure: rethrow so the loop reports `aborted`.
          if (ctx.signal?.aborted) throw err;
          return { ok: false, content: `bash failed: ${errorMessage(err)}` };
        }
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
        const path = String(args['path'] ?? '').trim();
        if (!path) return { ok: false, content: 'Missing required argument: path.' };

        try {
          const raw = await ctx.vm.read(path);
          if (raw.includes('\u0000')) {
            return { ok: false, content: `${path} appears to be a binary file.` };
          }
          if (raw.length === 0) {
            return { ok: true, content: '(empty file)', metadata: { path, lines: 0, chars: 0 } };
          }

          const numbered = raw
            .split('\n')
            .map((line, index) => `${index + 1}\t${line}`)
            .join('\n');

          return {
            ok: true,
            content: truncateOutput(numbered),
            metadata: { path, lines: raw.split('\n').length, chars: raw.length },
          };
        } catch (err) {
          return { ok: false, content: `read_file failed: ${errorMessage(err)}` };
        }
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
        const path = String(args['path'] ?? '').trim();
        if (!path) return { ok: false, content: 'Missing required argument: path.' };

        const content = String(args['content'] ?? '');
        const parent = path.replace(/\/[^/]*$/, '') || '/';
        if (parent !== '/' && parent !== '.') {
          try {
            await execWithAbort(ctx, `mkdir -p ${shellQuote(parent)}`, DEFAULT_TIMEOUT_MS);
          } catch (err) {
            if (ctx.signal?.aborted) throw err;
            // Best effort: the write below reports the real error.
          }
        }
        try {
          if (ctx.signal?.aborted) throw new Error('aborted');
          await ctx.vm.write(path, content);
          return {
            ok: true,
            content: `Wrote ${content.length} chars to ${path}.`,
            metadata: { path, chars: content.length },
          };
        } catch (err) {
          if (ctx.signal?.aborted) throw err;
          return { ok: false, content: `write_file failed: ${errorMessage(err)}` };
        }
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
        const path = String(args['path'] ?? '').trim();
        if (!path) return { ok: false, content: 'Missing required argument: path.' };

        try {
          const entries = await ctx.vm.list(path);
          if (entries.length === 0) {
            return { ok: true, content: '(empty directory)', metadata: { path, count: 0 } };
          }

          const lines = entries.map((entry) => {
            const kind = entry.kind === 'dir' ? 'd' : entry.kind === 'symlink' ? 'l' : '-';
            const size = formatBytes(entry.size).padStart(8);
            return `${kind} ${size} ${formatTimestamp(entry.mtime)} ${entry.name}`;
          });

          return {
            ok: true,
            content: truncateOutput(lines.join('\n')),
            metadata: { path, count: entries.length },
          };
        } catch (err) {
          return { ok: false, content: `list_dir failed: ${errorMessage(err)}` };
        }
      },
    },
    {
      name: 'search',
      description:
        'Search file contents in the VM using grep -rn. Returns matching lines with paths.',
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
        const pattern = String(args['pattern'] ?? '').trim();
        if (!pattern) return { ok: false, content: 'Missing required argument: pattern.' };

        const path = String(args['path'] ?? '/root/workspace').trim() || '/root/workspace';
        const glob = args['glob'] ? String(args['glob']).trim() : '';

        const commandParts = ['grep', '-rn'];
        if (glob) commandParts.push(`--include=${shellQuote(glob)}`);
        // `-e` keeps a leading-dash pattern from being parsed as an option.
        commandParts.push('-e', shellQuote(pattern));
        // `--` keeps a leading-dash path from being parsed as an option.
        commandParts.push('--', shellQuote(path));

        try {
          const result = await execWithAbort(ctx, commandParts.join(' '), DEFAULT_TIMEOUT_MS);
          const body = combineOutputs(result.stdout, result.stderr);
          const metadata = { pattern, path, glob: glob || undefined, exitCode: result.exitCode };

          if (result.exitCode === 0) {
            return { ok: true, content: truncateOutput(body), metadata };
          }
          if (result.exitCode === 1) {
            return { ok: true, content: body || 'No matches found.', metadata };
          }
          return {
            ok: false,
            content: truncateOutput(body || `grep exited with code ${result.exitCode}.`),
            metadata,
          };
        } catch (err) {
          if (ctx.signal?.aborted) throw err;
          return { ok: false, content: `search failed: ${errorMessage(err)}` };
        }
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
