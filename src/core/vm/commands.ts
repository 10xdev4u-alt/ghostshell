import type { CommandResult } from '@/types/index.js';
import { SerialQueue } from '@/lib/queue.js';

/**
 * Serial command runner with a sentinel protocol.
 *
 * v86 has one serial port, so commands are serialized through a queue. To
 * know when a command finishes, the runner wraps it in a begin/done pair and
 * collects guest output until the done sentinel arrives:
 *
 *   $ echo __GS_BEGIN_<id>__
 *   $ <command>
 *   $ echo __GS_DONE_<id>__ $?
 *
 * The guest tty echoes everything we send, so the raw stream also contains
 * the shell prompt and the wrapped command itself. The runner discards
 * everything up to the last begin marker, which removes the prompt and the
 * echo, and cuts everything from the done marker onwards. The exit code is
 * parsed from the done line.
 *
 * The serial console merges stdout and stderr into one stream, so both are
 * captured in `stdout` and `stderr` is left empty.
 */

export interface SerialTransport {
  /** Write a string to the guest serial port. */
  send(data: string): void;
  /** Subscribe to guest output. Returns an unsubscribe function. */
  onData(listener: (chunk: string) => void): () => void;
}

export interface CommandRunner {
  run(cmd: string, timeoutMs?: number): Promise<CommandResult>;
}

export interface RunnerOptions {
  /** How long to wait for the sentinel after sending Ctrl-C. */
  graceMs?: number;
  /** Maximum number of characters to retain from the serial stream. */
  maxOutputChars?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_GRACE_MS = 500;
const DEFAULT_MAX_OUTPUT_CHARS = 1_000_000;

/**
 * Prompt marker set while a command runs.
 *
 * The guest shell prints a prompt before every line it reads, so a prompt can
 * appear between the begin marker and the done marker. Setting `PS1` to a
 * per-run sentinel makes those prompts identifiable and strippable.
 */
export function promptSentinel(id: string): string {
  return `__GS_PROMPT_${id}__`;
}

/** Wrap a command in the begin/done sentinel pair. */
export function buildSentinelCommand(cmd: string, id: string): string {
  return (
    `PS1='${promptSentinel(id)}'\n` +
    `echo __GS_BEGIN_${id}__\n` +
    `${cmd}\n` +
    `echo __GS_DONE_${id}__ $?\n`
  );
}

/**
 * Compiled done-sentinel matcher.
 *
 * The exit code must be terminated by a newline. Bytes arrive one at a time,
 * so an unterminated `(-?\d+)` matches after the first digit and truncates
 * codes of two or more digits (e.g. `127` would settle as `1`).
 */
export function doneSentinelPattern(id: string): RegExp {
  return new RegExp(`__GS_DONE_${escapeRegExp(id)}__ (-?\\d+)\\r?\\n`);
}

/**
 * Split a raw serial stream at the done sentinel. Returns the body between
 * the last begin marker and the done marker, plus the parsed exit code.
 * Returns null when the done sentinel has not arrived yet.
 */
export function extractSentinelOutput(
  raw: string,
  id: string,
  pattern: RegExp = doneSentinelPattern(id),
): { body: string; exitCode: number } | null {
  const done = pattern.exec(raw);
  if (!done || done.index === undefined) return null;
  const before = raw.slice(0, done.index);
  const begin = `__GS_BEGIN_${id}__`;
  const idx = before.lastIndexOf(begin);
  const prompt = promptSentinel(id);
  const rawBody = idx === -1 ? before : before.slice(idx + begin.length);
  const body = rawBody.split(prompt).join('');
  return { body, exitCode: Number(done[1]) };
}

/** Strip terminal escape sequences and normalize line endings. */
export function cleanOutput(raw: string, echoed?: string): string {
  let out = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  out = stripAnsi(out);
  if (echoed !== undefined) {
    const idx = out.indexOf(echoed);
    if (idx !== -1) out = out.slice(0, idx) + out.slice(idx + echoed.length);
  }
  out = out
    .split('\n')
    .filter((line) => !SENTINEL_LINE.test(line.trim()))
    .join('\n');
  return out.trim();
}

/** Remove ANSI CSI and OSC escape sequences. */
export function stripAnsi(text: string): string {
  return text
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '');
}

const SENTINEL_LINE = /^__GS_DONE_[A-Za-z0-9]+__ -?\d+$/;

function newSentinelId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function createCommandRunner(
  transport: SerialTransport,
  options: RunnerOptions = {},
): CommandRunner {
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const queue = new SerialQueue();

  return {
    run(cmd: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<CommandResult> {
      return queue.add(() => runOnce(cmd, timeoutMs));
    },
  };

  function runOnce(cmd: string, timeoutMs: number): Promise<CommandResult> {
    return new Promise<CommandResult>((resolve) => {
      const id = newSentinelId();
      const wrapped = buildSentinelCommand(cmd, id);
      const donePattern = doneSentinelPattern(id);
      const started = Date.now();
      let output = '';
      let settled = false;
      let timedOut = false;
      let unsubscribe: () => void = () => undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let grace: ReturnType<typeof setTimeout> | undefined;

      const finish = (timedOut: boolean, exitCode: number, body: string): void => {
        if (settled) return;
        settled = true;
        if (timeout !== undefined) clearTimeout(timeout);
        if (grace !== undefined) clearTimeout(grace);
        unsubscribe();
        resolve({
          stdout: cleanOutput(body, wrapped),
          stderr: '',
          exitCode,
          durationMs: Date.now() - started,
          timedOut,
        });
      };

      unsubscribe = transport.onData((chunk) => {
        if (settled) return;
        output += chunk;
        const found = extractSentinelOutput(output, id, donePattern);
        if (found) {
          finish(timedOut, found.exitCode, found.body);
          return;
        }
        if (output.length > maxOutputChars) {
          output = output.slice(output.length - maxOutputChars);
        }
      });

      timeout = setTimeout(() => {
        timedOut = true;
        transport.send('\x03');
        grace = setTimeout(() => finish(true, -1, bodyBeforeSentinel()), graceMs);
      }, timeoutMs);

      transport.send(wrapped);

      function bodyBeforeSentinel(): string {
        const found = extractSentinelOutput(output, id, donePattern);
        return found ? found.body : output;
      }
    });
  }
}
