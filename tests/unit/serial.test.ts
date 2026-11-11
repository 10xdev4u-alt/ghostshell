import { describe, expect, it } from 'vitest';
import { createSerialFilter } from '@/ui/serial.js';

/**
 * The command runner wraps every command as:
 *
 *   PS1='__GS_PROMPT_<id>__'
 *   echo __GS_BEGIN_<id>__
 *   <command>
 *   echo __GS_DONE_<id>__ $?
 *
 * The guest tty echoes the wrapper and prefixes every input line with the
 * active prompt. These streams model the two shapes the filter sees: the
 * all-echo-first shape used by the VM tests, and the interleaved shape a real
 * tty produces (prompt sentinel before each echoed line, output unprefixed).
 */

function fakeStream(id: string, command: string, body: string): string {
  const wrapped =
    `PS1='__GS_PROMPT_${id}__'\n` +
    `echo __GS_BEGIN_${id}__\n` +
    `${command}\n` +
    `echo __GS_DONE_${id}__ $?\n`;
  const prompt = `__GS_PROMPT_${id}__`;
  return `localhost:~# ${wrapped}__GS_BEGIN_${id}__\n${prompt}${body}${prompt}__GS_DONE_${id}__ 0\n`;
}

function realStream(id: string, command: string, body: string): string {
  const prompt = `__GS_PROMPT_${id}__`;
  return (
    `localhost:~# PS1='__GS_PROMPT_${id}__'\n` +
    `${prompt}echo __GS_BEGIN_${id}__\n` +
    `__GS_BEGIN_${id}__\n` +
    `${prompt}${command}\n` +
    `${body}` +
    `${prompt}echo __GS_DONE_${id}__ $?\n` +
    `__GS_DONE_${id}__ 0\n` +
    `${prompt}`
  );
}

describe('serial filter', () => {
  it('drops the echoed wrapper and keeps command output (all-echo-first shape)', () => {
    const filter = createSerialFilter();
    const out = filter.write(fakeStream('abc', 'echo hello', 'hello\n'));
    expect(out).toBe('hello\n');
  });

  it('drops the prompt sentinel and echoed command in the real tty shape', () => {
    const filter = createSerialFilter();
    filter.beginCommand('echo hello');
    const out = filter.write(realStream('abc', 'echo hello', 'hello\n'));
    filter.endCommand();
    expect(out).toBe('hello\n');
  });

  it('keeps multi-line output and strips prompts glued to it', () => {
    const filter = createSerialFilter();
    filter.beginCommand('ls -la');
    const out = filter.write(realStream('id1', 'ls -la', 'total 0\n-rw-r--r-- 1 root root 0 a\n'));
    filter.endCommand();
    expect(out).toBe('total 0\n-rw-r--r-- 1 root root 0 a\n');
  });

  it('drops the echoed command in body mode when the wrapper is missed', () => {
    const filter = createSerialFilter();
    const raw = '__GS_BEGIN_x__\necho hello\nhello\n__GS_DONE_x__ 0\n';

    filter.beginCommand('echo hello');
    expect(filter.write(raw)).toBe('hello\n');
    filter.endCommand();

    const unfiltered = createSerialFilter();
    expect(unfiltered.write(raw)).toBe('echo hello\nhello\n');
  });

  it('keeps boot output before the first wrapper', () => {
    const filter = createSerialFilter();
    const out = filter.write('Booting Alpine Linux\n[    0.000000] Linux version 6.1\n');
    expect(out).toBe('Booting Alpine Linux\n[    0.000000] Linux version 6.1\n');
  });

  it('buffers partial lines across chunks', () => {
    const filter = createSerialFilter();
    expect(filter.write('hel')).toBe('');
    expect(filter.write('lo\n')).toBe('hello\n');
  });

  it('flush emits a trailing partial line', () => {
    const filter = createSerialFilter();
    expect(filter.write('hello')).toBe('');
    expect(filter.flush()).toBe('hello\n');
  });

  it('reset drops buffered state', () => {
    const filter = createSerialFilter();
    filter.write('__GS_PROMPT_x__PS1=\'__GS_PROMPT_y__\'\n');
    filter.reset();
    expect(filter.write('fresh output\n')).toBe('fresh output\n');
  });

  it('ignores done markers outside a wrapper', () => {
    const filter = createSerialFilter();
    expect(filter.write('__GS_DONE_x__ 0\n')).toBe('');
  });
});
