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
import { builtinTools } from '@/core/agent/tools.js';

// ---------------------------------------------------------------------------
// Fake VM
// ---------------------------------------------------------------------------

const DEFAULT_RESULT: CommandResult = {
  stdout: '',
  stderr: '',
  exitCode: 0,
  durationMs: 1,
  timedOut: false,
};

type ExecHandler = (cmd: string) => CommandResult;

class FakeVM implements VMHandle {
  readonly id = 'fake-vm';
  running = true;
  commands: Array<{ cmd: string; timeoutMs?: number | undefined }> = [];
  files = new Map<string, string>();
  dirs = new Map<string, DirEntry[]>();
  private readonly canned = new Map<string, CommandResult>();
  private handler: ExecHandler | null = null;

  seed(cmd: string, result: Partial<CommandResult>): void {
    this.canned.set(cmd, { ...DEFAULT_RESULT, ...result });
  }

  /** Respond to commands dynamically when no canned result matches. */
  setHandler(handler: ExecHandler): void {
    this.handler = handler;
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async pause(): Promise<void> {}
  async resume(): Promise<void> {}

  async exec(cmd: string, timeoutMs?: number): Promise<CommandResult> {
    this.commands.push({ cmd, timeoutMs });
    return this.canned.get(cmd) ?? this.handler?.(cmd) ?? { ...DEFAULT_RESULT };
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(vm: VMHandle): ToolContext {
  const db = {} as Database;
  const egress: EgressLog = {
    record: () => undefined,
    list: () => [],
    clear: () => undefined,
  };
  return { vm, llm: {} as LLMEngine, db, egress };
}

function tool(name: string): ToolDefinition {
  const found = builtinTools().find((candidate) => candidate.name === name);
  if (!found) throw new Error(`tool not found: ${name}`);
  return found;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('built-in tools integration', () => {
  it('bash returns stdout, stderr, and the exit code', async () => {
    const vm = new FakeVM();
    vm.seed('echo hello', {
      stdout: 'hello\n',
      stderr: '',
      exitCode: 0,
      durationMs: 4,
    });
    vm.seed('fail', {
      stdout: 'partial\n',
      stderr: 'command failed\n',
      exitCode: 3,
      durationMs: 2,
    });

    const okResult = await tool('bash').execute(makeContext(vm), {
      command: 'echo hello',
    });
    expect(okResult.ok).toBe(true);
    expect(okResult.content).toContain('hello');
    expect(okResult.content).toContain('[exit 0]');
    expect(okResult.metadata?.['exitCode']).toBe(0);
    expect(okResult.metadata?.['timedOut']).toBe(false);
    expect(vm.commands[0]!.cmd).toBe('echo hello');
    expect(vm.commands[0]!.timeoutMs).toBe(60_000);

    const failResult = await tool('bash').execute(makeContext(vm), {
      command: 'fail',
    });
    expect(failResult.ok).toBe(false);
    expect(failResult.content).toContain('partial');
    expect(failResult.content).toContain('command failed');
    expect(failResult.content).toContain('[exit 3]');
    expect(failResult.metadata?.['exitCode']).toBe(3);
  });

  it('read_file returns numbered lines', async () => {
    const vm = new FakeVM();
    vm.files.set('/root/workspace/a.txt', 'one\ntwo\nthree');

    const result = await tool('read_file').execute(makeContext(vm), {
      path: '/root/workspace/a.txt',
    });

    expect(result.ok).toBe(true);
    expect(result.content).toBe('1\tone\n2\ttwo\n3\tthree');
    expect(result.metadata?.['lines']).toBe(3);
    expect(result.metadata?.['chars']).toBe('one\ntwo\nthree'.length);
  });

  it('read_file reports a missing file as an error', async () => {
    const vm = new FakeVM();

    const result = await tool('read_file').execute(makeContext(vm), {
      path: '/root/workspace/missing.txt',
    });

    expect(result.ok).toBe(false);
    expect(result.content).toContain('ENOENT');
    expect(result.content).toContain('/root/workspace/missing.txt');
  });

  it('write_file then read_file round-trips content', async () => {
    const vm = new FakeVM();
    const content = 'line one\nline two\n';

    const writeResult = await tool('write_file').execute(makeContext(vm), {
      path: '/root/workspace/out.txt',
      content,
    });
    expect(writeResult.ok).toBe(true);
    expect(vm.files.get('/root/workspace/out.txt')).toBe(content);
    expect(writeResult.metadata?.['chars']).toBe(content.length);

    const readResult = await tool('read_file').execute(makeContext(vm), {
      path: '/root/workspace/out.txt',
    });
    expect(readResult.ok).toBe(true);
    expect(readResult.content).toBe('1\tline one\n2\tline two\n3\t');
  });

  it('list_dir returns entries', async () => {
    const vm = new FakeVM();
    vm.dirs.set('/root/workspace', [
      { name: 'a.txt', kind: 'file', size: 12, mtime: 1_700_000_000_000 },
      { name: 'sub', kind: 'dir', size: 4096, mtime: 1_700_000_000_000 },
      { name: 'link', kind: 'symlink', size: 0, mtime: 1_700_000_000_000 },
    ]);

    const result = await tool('list_dir').execute(makeContext(vm), {
      path: '/root/workspace',
    });

    expect(result.ok).toBe(true);
    expect(result.content).toContain('a.txt');
    expect(result.content).toContain('sub');
    expect(result.content).toContain('link');
    expect(result.metadata?.['count']).toBe(3);
    expect(result.content.split('\n')[0]!.startsWith('- ')).toBe(true);
    expect(result.content.split('\n')[1]!.startsWith('d ')).toBe(true);
    expect(result.content.split('\n')[2]!.startsWith('l ')).toBe(true);
  });

  it('search finds a pattern and returns the matches', async () => {
    const vm = new FakeVM();
    vm.setHandler((cmd) =>
      cmd.includes('grep -rn')
        ? {
            stdout: '/root/workspace/a.ts:3: const foo = 1;\n',
            stderr: '',
            exitCode: 0,
            durationMs: 4,
            timedOut: false,
          }
        : { ...DEFAULT_RESULT },
    );

    const result = await tool('search').execute(makeContext(vm), {
      pattern: 'foo',
      path: '/root/workspace',
    });

    expect(result.ok).toBe(true);
    expect(result.content).toContain('const foo = 1;');
    expect(result.metadata?.['pattern']).toBe('foo');
    expect(result.metadata?.['path']).toBe('/root/workspace');
    expect(result.metadata?.['exitCode']).toBe(0);
    // The pattern is passed with -e and the path after --.
    expect(vm.commands[0]!.cmd).toContain("-e 'foo'");
    expect(vm.commands[0]!.cmd).toContain("-- '/root/workspace'");
  });

  it('search treats a leading-dash path as an operand after --', async () => {
    const vm = new FakeVM();
    vm.setHandler((cmd) =>
      cmd.includes('grep -rn')
        ? {
            stdout: '',
            stderr: '',
            exitCode: 1,
            durationMs: 1,
            timedOut: false,
          }
        : { ...DEFAULT_RESULT },
    );

    const result = await tool('search').execute(makeContext(vm), {
      pattern: 'needle',
      path: '-weird-path',
    });

    expect(result.ok).toBe(true);
    expect(result.content).toBe('No matches found.');
    expect(vm.commands[0]!.cmd).toBe(
      "grep -rnI --exclude-dir=.git --exclude-dir=node_modules -e 'needle' -- '-weird-path'",
    );
  });
});
