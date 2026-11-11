import { describe, expect, it } from 'vitest';
import {
  buildSentinelCommand,
  cleanOutput,
  createCommandRunner,
  extractSentinelOutput,
  stripAnsi,
  stripSentinels,
  type SerialTransport,
} from '@/core/vm/commands.js';

/**
 * In-memory serial port. `respond` imitates the guest tty: it echoes the
 * wrapped command, prints the begin marker, runs the command, and finally
 * prints the done sentinel with the exit code.
 */
class FakeTransport implements SerialTransport {
  readonly sent: string[] = [];
  private listeners = new Set<(chunk: string) => void>();

  send(data: string): void {
    this.sent.push(data);
  }

  onData(listener: (chunk: string) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(chunk: string): void {
    for (const listener of [...this.listeners]) listener(chunk);
  }

  respond(body: string, exitCode = 0): void {
    const data = [...this.sent].reverse().find((s) => s.includes('__GS_DONE_')) ?? '';
    const id = /__GS_DONE_([A-Za-z0-9]+)__/.exec(data)?.[1] ?? 'missing';
    this.emit(`localhost:~# ${data}`);
    this.emit(`__GS_BEGIN_${id}__\n`);
    if (body) this.emit(body);
    this.emit(`__GS_DONE_${id}__ ${exitCode}\n`);
  }
}

describe('buildSentinelCommand', () => {
  it('wraps the command in begin/done sentinels', () => {
    expect(buildSentinelCommand('echo hi', 'abc123')).toBe(
      "PS1='__GS_PROMPT_abc123__'\n" +
        'echo __GS_BEGIN_abc123__\n' +
        'echo hi\n' +
        'echo __GS_DONE_abc123__ $?\n',
    );
  });
});

describe('extractSentinelOutput', () => {
  it('returns the body and exit code', () => {
    const raw =
      'localhost:~# echo __GS_BEGIN_abc__\n__GS_BEGIN_abc__\nhello\n__GS_DONE_abc__ 0\n';
    expect(extractSentinelOutput(raw, 'abc')).toEqual({ body: '\nhello\n', exitCode: 0 });
  });

  it('parses negative exit codes', () => {
    const raw = '__GS_BEGIN_abc__\n__GS_DONE_abc__ -1\n';
    expect(extractSentinelOutput(raw, 'abc')).toEqual({ body: '\n', exitCode: -1 });
  });

  it('returns null when the done sentinel is absent', () => {
    expect(extractSentinelOutput('hello', 'abc')).toBeNull();
  });

  it('ignores the echoed done line with a literal $?', () => {
    const raw = 'echo __GS_DONE_abc__ $?\n__GS_BEGIN_abc__\nhello\n__GS_DONE_abc__ 3\n';
    expect(extractSentinelOutput(raw, 'abc')).toEqual({ body: '\nhello\n', exitCode: 3 });
  });

  it('does not settle on a partial exit code', () => {
    expect(extractSentinelOutput('__GS_BEGIN_abc__\n__GS_DONE_abc__ 1', 'abc')).toBeNull();
  });

  it('parses a multi-digit exit code once the line terminates', () => {
    const raw = '__GS_BEGIN_abc__\nhello\n__GS_DONE_abc__ 127\n';
    expect(extractSentinelOutput(raw, 'abc')).toEqual({ body: '\nhello\n', exitCode: 127 });
  });

  it('strips the prompt sentinel from the body', () => {
    const raw =
      '__GS_BEGIN_abc__\n__GS_PROMPT_abc__hello\n__GS_PROMPT_abc____GS_DONE_abc__ 0\n';
    expect(extractSentinelOutput(raw, 'abc')).toEqual({ body: '\nhello\n', exitCode: 0 });
  });
});

describe('stripSentinels', () => {
  it('drops output before the begin marker and strips prompts and the echo', () => {
    const wrapped = buildSentinelCommand('sleep 100', 'abc');
    const raw =
      `localhost:~# ${wrapped}` +
      '__GS_BEGIN_abc__\n' +
      '__GS_PROMPT_abc__sleep 100\n' +
      '__GS_PROMPT_abc__partial output\n';
    expect(cleanOutput(stripSentinels(raw, 'abc', wrapped), wrapped)).toBe('partial output');
  });

  it('keeps output when no begin marker has arrived', () => {
    expect(cleanOutput(stripSentinels('__GS_PROMPT_abc__hello\n', 'abc'))).toBe('hello');
  });
});

describe('cleanOutput', () => {
  it('normalizes line endings', () => {
    expect(cleanOutput('a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('strips ansi escape sequences', () => {
    expect(cleanOutput('\u001b[31mred\u001b[0m')).toBe('red');
  });

  it('removes sentinel lines', () => {
    expect(cleanOutput('hello\n__GS_DONE_abc__ 0\n')).toBe('hello');
  });

  it('removes the echoed command when provided', () => {
    const echoed = 'echo __GS_BEGIN_abc__\nls\necho __GS_DONE_abc__ $?\n';
    expect(cleanOutput(`${echoed}a.txt\n`, echoed)).toBe('a.txt');
  });
});

describe('stripAnsi', () => {
  it('removes CSI and OSC sequences', () => {
    expect(stripAnsi('\u001b[1;32mgreen\u001b[0m')).toBe('green');
    expect(stripAnsi('\u001b]0;title\u0007text')).toBe('text');
  });
});

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function sentinelId(data: string): string {
  return /__GS_DONE_([A-Za-z0-9]+)__/.exec(data)?.[1] ?? 'missing';
}

describe('createCommandRunner', () => {
  it('sends a sentinel-wrapped command', async () => {
    const transport = new FakeTransport();
    const runner = createCommandRunner(transport);
    const pending = runner.run('echo hi');
    await tick();
    transport.respond('hi\n');

    const result = await pending;
    expect(transport.sent[0]).toContain('echo __GS_BEGIN_');
    expect(transport.sent[0]).toContain('echo hi');
    expect(transport.sent[0]).toContain('echo __GS_DONE_');
    expect(transport.sent[0]).toContain('$?');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hi');
    expect(result.stderr).toBe('');
    expect(result.timedOut).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('parses a non-zero exit code', async () => {
    const transport = new FakeTransport();
    const runner = createCommandRunner(transport);
    const pending = runner.run('false');
    await tick();
    transport.respond('', 7);

    const result = await pending;
    expect(result.exitCode).toBe(7);
  });

  it('waits for the full multi-digit exit code, one byte at a time', async () => {
    const transport = new FakeTransport();
    const runner = createCommandRunner(transport);
    const pending = runner.run('false');
    await tick();
    const id = sentinelId(transport.sent[0]!);

    // Emit the begin marker first so the runner is collecting output.
    transport.emit(`__GS_BEGIN_${id}__\n`);
    for (const ch of `__GS_DONE_${id}__ 127\n`) transport.emit(ch);

    const result = await pending;
    expect(result.exitCode).toBe(127);
  });

  it('strips prompts printed between the markers', async () => {
    const transport = new FakeTransport();
    const runner = createCommandRunner(transport);
    const pending = runner.run('echo hi');
    await tick();
    const id = sentinelId(transport.sent[0]!);
    const prompt = `__GS_PROMPT_${id}__`;

    transport.emit(`localhost:~# ${transport.sent[0]}`);
    transport.emit(`__GS_BEGIN_${id}__\n`);
    transport.emit(`${prompt}hi\n`);
    transport.emit(prompt);
    transport.emit(`__GS_DONE_${id}__ 0\n`);

    const result = await pending;
    expect(result.stdout).toBe('hi');
  });

  it('strips the prompt and the echoed command', async () => {
    const transport = new FakeTransport();
    const runner = createCommandRunner(transport);
    const pending = runner.run('ls -la /root');
    await tick();
    transport.respond('a.txt\nb.txt\n');

    const result = await pending;
    expect(result.stdout).toBe('a.txt\nb.txt');
  });

  it('keeps multi-line output intact', async () => {
    const transport = new FakeTransport();
    const runner = createCommandRunner(transport);
    const pending = runner.run('seq 1 3');
    await tick();
    transport.respond('1\n2\n3\n');

    const result = await pending;
    expect(result.stdout).toBe('1\n2\n3');
  });

  it('times out, sends Ctrl-C, and reports failure', async () => {
    const transport = new FakeTransport();
    const runner = createCommandRunner(transport, { graceMs: 10 });

    const result = await runner.run('sleep 100', 30);
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(-1);
    expect(transport.sent).toContain('\x03');
  }, 2_000);

  it('strips prompts and the echoed wrapper from timeout output', async () => {
    const transport = new FakeTransport();
    const runner = createCommandRunner(transport, { graceMs: 10 });

    const pending = runner.run('sleep 100', 30);
    await tick();
    const id = sentinelId(transport.sent[0]!);
    const prompt = `__GS_PROMPT_${id}__`;

    // The tty echoes the wrapper, then the guest prints the begin marker and
    // interleaves the prompt sentinel between the echoed command and output.
    transport.emit(`localhost:~# ${transport.sent[0]}`);
    transport.emit(`__GS_BEGIN_${id}__\n`);
    transport.emit(`${prompt}sleep 100\n`);
    transport.emit(`${prompt}sleeping...\n`);

    const result = await pending;
    expect(result.timedOut).toBe(true);
    expect(result.stdout).not.toContain('__GS_PROMPT_');
    expect(result.stdout).not.toContain('__GS_BEGIN_');
    expect(result.stdout).not.toContain('sleep 100');
    expect(result.stdout).not.toContain('localhost:~#');
    expect(result.stdout).toContain('sleeping...');
  }, 2_000);

  it('uses the exit code when the sentinel arrives during the grace period', async () => {
    const transport = new FakeTransport();
    const runner = createCommandRunner(transport, { graceMs: 80 });

    const pending = runner.run('sleep 100', 30);
    setTimeout(() => transport.respond('partial\n', 130), 50);

    const result = await pending;
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(130);
    expect(result.stdout).toContain('partial');
  }, 2_000);

  it('caps retained output', async () => {
    const transport = new FakeTransport();
    const runner = createCommandRunner(transport, { maxOutputChars: 20 });
    const pending = runner.run('yes');
    await tick();
    transport.respond(`${'x'.repeat(200)}\n`);

    const result = await pending;
    expect(result.stdout.length).toBeLessThanOrEqual(20);
  });

  it('serializes concurrent runs', async () => {
    const transport = new FakeTransport();
    const runner = createCommandRunner(transport);
    const order: string[] = [];

    const first = runner.run('one').then((r) => order.push(r.stdout));
    const second = runner.run('two').then((r) => order.push(r.stdout));

    // The queue ensures the first command is sent before the second.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(transport.sent).toHaveLength(1);
    transport.respond('one\n');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(transport.sent).toHaveLength(2);
    transport.respond('two\n');

    await Promise.all([first, second]);
    expect(order).toEqual(['one', 'two']);
  });
});
