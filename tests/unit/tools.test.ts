import { describe, expect, it } from 'vitest';
import type {
  CommandResult,
  Database,
  DirEntry,
  EgressLog,
  LLMEngine,
  ToolContext,
  ToolDefinition,
  VMHandle,
} from '@/types/index.js';
import { builtinTools, MAX_OUTPUT_CHARS, truncateOutput } from '@/core/agent/tools.js';

class FakeVM implements VMHandle {
  readonly id = 'fake-vm';
  running = true;
  files = new Map<string, string>();
  dirs = new Map<string, DirEntry[]>();
  commands: Array<{ cmd: string; timeoutMs?: number | undefined }> = [];
  execResult: CommandResult = { stdout: '', stderr: '', exitCode: 0, durationMs: 1, timedOut: false };

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async pause(): Promise<void> {}
  async resume(): Promise<void> {}

  async exec(cmd: string, timeoutMs?: number): Promise<CommandResult> {
    this.commands.push({ cmd, timeoutMs });
    return this.execResult;
  }

  sendSerial(_data: string): void {}

  async write(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  async read(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`ENOENT: no such file '${path}'`);
    return value;
  }

  async list(path: string): Promise<DirEntry[]> {
    const value = this.dirs.get(path);
    if (value === undefined) throw new Error(`ENOENT: no such directory '${path}'`);
    return value;
  }

  onSerial(): void {}
}

function makeContext(vm: VMHandle): ToolContext {
  const db = {} as Database;
  const egress: EgressLog = { record: () => undefined, list: () => [], clear: () => undefined };
  return { vm, llm: {} as LLMEngine, db, egress };
}

function tool(name: string): ToolDefinition {
  const found = builtinTools().find((candidate) => candidate.name === name);
  if (!found) throw new Error(`tool not found: ${name}`);
  return found;
}

describe('builtin tools', () => {
  it('bash returns stdout with exit status', async () => {
    const vm = new FakeVM();
    vm.execResult = { stdout: 'hello\n', stderr: '', exitCode: 0, durationMs: 12, timedOut: false };

    const result = await tool('bash').execute(makeContext(vm), { command: 'echo hello' });

    expect(result.ok).toBe(true);
    expect(result.content).toContain('hello');
    expect(result.content).toContain('[exit 0]');
    expect(vm.commands[0]!.cmd).toBe('echo hello');
    expect(vm.commands[0]!.timeoutMs).toBe(60_000);
  });

  it('bash reports failures with stderr', async () => {
    const vm = new FakeVM();
    vm.execResult = { stdout: '', stderr: 'command not found', exitCode: 127, durationMs: 3, timedOut: false };

    const result = await tool('bash').execute(makeContext(vm), { command: 'nope' });

    expect(result.ok).toBe(false);
    expect(result.content).toContain('command not found');
    expect(result.content).toContain('[exit 127]');
    expect(result.metadata?.['exitCode']).toBe(127);
  });

  it('bash caps output at MAX_OUTPUT_CHARS', async () => {
    const vm = new FakeVM();
    vm.execResult = {
      stdout: 'x'.repeat(MAX_OUTPUT_CHARS * 4),
      stderr: '',
      exitCode: 0,
      durationMs: 1,
      timedOut: false,
    };

    const result = await tool('bash').execute(makeContext(vm), { command: 'yes' });

    expect(result.ok).toBe(true);
    expect(result.content.length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS);
    expect(result.content).toContain('[truncated');
  });

  it('bash rejects empty commands without touching the VM', async () => {
    const vm = new FakeVM();
    const result = await tool('bash').execute(makeContext(vm), { command: '   ' });

    expect(result.ok).toBe(false);
    expect(result.content).toBe('Empty command.');
    expect(vm.commands).toHaveLength(0);
  });

  it('bash marks timed-out commands as failed', async () => {
    const vm = new FakeVM();
    vm.execResult = { stdout: 'partial', stderr: '', exitCode: -1, durationMs: 60_000, timedOut: true };

    const result = await tool('bash').execute(makeContext(vm), { command: 'sleep 100' });

    expect(result.ok).toBe(false);
    expect(result.content).toContain('timed out');
  });

  it('read_file numbers lines', async () => {
    const vm = new FakeVM();
    vm.files.set('/tmp/a.txt', 'one\ntwo');

    const result = await tool('read_file').execute(makeContext(vm), { path: '/tmp/a.txt' });

    expect(result.ok).toBe(true);
    expect(result.content).toBe('1\tone\n2\ttwo');
    expect(result.metadata?.['lines']).toBe(2);
  });

  it('read_file reports missing files', async () => {
    const vm = new FakeVM();
    const result = await tool('read_file').execute(makeContext(vm), { path: '/tmp/missing.txt' });

    expect(result.ok).toBe(false);
    expect(result.content).toContain('ENOENT');
  });

  it('read_file flags binary content', async () => {
    const vm = new FakeVM();
    vm.files.set('/tmp/bin', 'abc\u0000def');

    const result = await tool('read_file').execute(makeContext(vm), { path: '/tmp/bin' });

    expect(result.ok).toBe(false);
    expect(result.content).toContain('binary');
  });

  it('write_file writes content', async () => {
    const vm = new FakeVM();
    const result = await tool('write_file').execute(makeContext(vm), {
      path: '/tmp/b.txt',
      content: 'hello world',
    });

    expect(result.ok).toBe(true);
    expect(vm.files.get('/tmp/b.txt')).toBe('hello world');
    expect(result.content).toContain('/tmp/b.txt');
  });

  it('list_dir formats entries', async () => {
    const vm = new FakeVM();
    vm.dirs.set('/tmp', [
      { name: 'a.txt', kind: 'file', size: 10, mtime: 0 },
      { name: 'sub', kind: 'dir', size: 4096, mtime: 0 },
    ]);

    const result = await tool('list_dir').execute(makeContext(vm), { path: '/tmp' });

    expect(result.ok).toBe(true);
    expect(result.content).toContain('a.txt');
    expect(result.content).toContain('sub');
    expect(result.content.split('\n')[1]!.startsWith('d ')).toBe(true);
    expect(result.metadata?.['count']).toBe(2);
  });

  it('list_dir reports empty directories', async () => {
    const vm = new FakeVM();
    vm.dirs.set('/tmp', []);

    const result = await tool('list_dir').execute(makeContext(vm), { path: '/tmp' });

    expect(result.ok).toBe(true);
    expect(result.content).toBe('(empty directory)');
  });

  it('search runs grep and returns matches', async () => {
    const vm = new FakeVM();
    vm.execResult = {
      stdout: '/root/workspace/a.ts:3: foo\n',
      stderr: '',
      exitCode: 0,
      durationMs: 4,
      timedOut: false,
    };

    const result = await tool('search').execute(makeContext(vm), {
      pattern: 'foo',
      path: '/root/workspace',
    });

    expect(result.ok).toBe(true);
    expect(result.content).toContain('foo');
    expect(vm.commands[0]!.cmd).toContain('grep -rn');
    expect(vm.commands[0]!.cmd).toContain("'foo'");
    expect(vm.commands[0]!.cmd).toContain("'/root/workspace'");
  });

  it('search skips binary files and VCS/dependency directories', async () => {
    const vm = new FakeVM();
    vm.execResult = { stdout: '', stderr: '', exitCode: 1, durationMs: 1, timedOut: false };

    await tool('search').execute(makeContext(vm), { pattern: 'foo' });

    expect(vm.commands[0]!.cmd).toContain('-rnI');
    expect(vm.commands[0]!.cmd).toContain('--exclude-dir=.git');
    expect(vm.commands[0]!.cmd).toContain('--exclude-dir=node_modules');
  });

  it('search passes a glob filter', async () => {
    const vm = new FakeVM();
    vm.execResult = { stdout: '', stderr: '', exitCode: 1, durationMs: 1, timedOut: false };

    await tool('search').execute(makeContext(vm), { pattern: 'foo', glob: '*.ts' });

    expect(vm.commands[0]!.cmd).toContain('--include=');
    expect(vm.commands[0]!.cmd).toContain('*.ts');
  });

  it('search treats a leading-dash pattern as a literal pattern', async () => {
    const vm = new FakeVM();
    vm.execResult = { stdout: '', stderr: '', exitCode: 1, durationMs: 1, timedOut: false };

    await tool('search').execute(makeContext(vm), { pattern: '-v foo' });

    expect(vm.commands[0]!.cmd).toContain('grep -rn');
    expect(vm.commands[0]!.cmd).toContain("-e '-v foo'");
    expect(vm.commands[0]!.cmd).not.toContain("grep -rn '-v foo'");
  });

  it('search treats a leading-dash glob-like pattern as a literal pattern', async () => {
    const vm = new FakeVM();
    vm.execResult = { stdout: '', stderr: '', exitCode: 1, durationMs: 1, timedOut: false };

    await tool('search').execute(makeContext(vm), { pattern: '--include=secret' });

    expect(vm.commands[0]!.cmd).toContain("-e '--include=secret'");
  });

  it('search treats a leading-dash path as an operand', async () => {
    const vm = new FakeVM();
    vm.execResult = { stdout: '', stderr: '', exitCode: 1, durationMs: 1, timedOut: false };

    await tool('search').execute(makeContext(vm), { pattern: 'foo', path: '-weird-path' });

    expect(vm.commands[0]!.cmd).toBe(
      "grep -rnI --exclude-dir=.git --exclude-dir=node_modules -e 'foo' -- '-weird-path'",
    );
  });

  it('search treats no matches as success', async () => {
    const vm = new FakeVM();
    vm.execResult = { stdout: '', stderr: '', exitCode: 1, durationMs: 2, timedOut: false };

    const result = await tool('search').execute(makeContext(vm), { pattern: 'missing' });

    expect(result.ok).toBe(true);
    expect(result.content).toBe('No matches found.');
  });

  it('search reports grep errors', async () => {
    const vm = new FakeVM();
    vm.execResult = {
      stdout: '',
      stderr: 'grep: invalid option -- z',
      exitCode: 2,
      durationMs: 1,
      timedOut: false,
    };

    const result = await tool('search').execute(makeContext(vm), { pattern: 'foo' });

    expect(result.ok).toBe(false);
    expect(result.content).toContain('invalid option');
  });

  it('every tool returns a content string', async () => {
    const vm = new FakeVM();
    for (const definition of builtinTools()) {
      const result = await definition.execute(makeContext(vm), {});
      expect(typeof result.content).toBe('string');
      expect(typeof result.ok).toBe('boolean');
    }
  });
});

describe('truncateOutput', () => {
  it('leaves text within the limit untouched', () => {
    expect(truncateOutput('hello', 10)).toBe('hello');
    expect(truncateOutput('', 10)).toBe('');
  });

  it('never exceeds max when the marker is longer than max', () => {
    const result = truncateOutput('x'.repeat(100), 10);
    expect(result.length).toBeLessThanOrEqual(10);
  });

  it('reports the number of characters actually removed', () => {
    const text = 'x'.repeat(100);
    const result = truncateOutput(text, 50);
    const marker = /…\[truncated (\d+) chars\]$/.exec(result);
    expect(marker).not.toBeNull();
    const reported = Number(marker![1]);
    const kept = result.length - marker![0].length;
    expect(reported).toBe(text.length - kept);
    expect(result.length).toBeLessThanOrEqual(50);
  });
});
