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
 *
 * When `wrapped` is given, lines the tty echoed from it are dropped. The echo
 * is identified by the prompt sentinel that precedes it: the guest prints the
 * prompt before reading each line we send, while command output is not
 * prompt-prefixed. This keeps output lines that merely equal the command text.
 */
export function extractSentinelOutput(
  raw: string,
  id: string,
  pattern: RegExp = doneSentinelPattern(id),
  wrapped?: string,
): { body: string; exitCode: number } | null {
  const done = pattern.exec(raw);
  if (!done || done.index === undefined) return null;
  const before = raw.slice(0, done.index);
  const begin = `__GS_BEGIN_${id}__`;
  const idx = before.lastIndexOf(begin);
  const rawBody = idx === -1 ? before : before.slice(idx + begin.length);
  const body = stripPromptsAndEchoedLines(
    rawBody,
    promptSentinel(id),
    wrapped === undefined ? undefined : echoedLineSet(wrapped),
  );
  return { body, exitCode: Number(done[1]) };
}

/**
 * The non-empty lines of the echoed wrapper.
 *
 * The tty echoes every line we send. Sentinel extraction cuts the body at the
 * marker's *output*, so the echoed command and done lines survive inside it,
 * interleaved with prompts.
 */
function echoedLineSet(wrapped: string): Set<string> {
  return new Set(
    wrapped
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
}

/**
 * Strip prompt sentinels from a body, dropping lines echoed from the wrapper.
 *
 * A line echoed by the tty starts with the prompt sentinel; command output
 * does not. Only prompt-prefixed lines that match a wrapper line are dropped,
 * so output that happens to equal the command text is preserved.
 */
function stripPromptsAndEchoedLines(
  body: string,
  prompt: string,
  echoed?: Set<string>,
): string {
  return body
    .split('\n')
    .map((line) => {
      let rest = line;
      let isEcho = false;
      if (rest.startsWith(prompt)) {
        rest = rest.slice(prompt.length);
        isEcho = echoed !== undefined && echoed.has(rest.trim());
      }
      return isEcho ? null : rest.split(prompt).join('');
    })
    .filter((line): line is string => line !== null)
    .join('\n');
}

/**
 * Clean a partial serial stream from a timed-out command.
 *
 * Mirrors `extractSentinelOutput` without requiring the done sentinel: drops
 * everything up to the last begin marker, strips prompt sentinels, and
 * removes the echoed wrapper lines.
 */
export function stripSentinels(raw: string, id: string, wrapped?: string): string {
  const begin = `__GS_BEGIN_${id}__`;
  const idx = raw.lastIndexOf(begin);
  const body = idx === -1 ? raw : raw.slice(idx + begin.length);
  return stripPromptsAndEchoedLines(
    body,
    promptSentinel(id),
    wrapped === undefined ? undefined : echoedLineSet(wrapped),
  );
}

/** Strip terminal escape sequences and normalize line endings. */
export function cleanOutput(raw: string): string {
  let out = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  out = stripAnsi(out);
  out = out
    .split('\n')
    .filter((line) => !SENTINEL_LINE.test(line.trim()))
    .join('\n');
  return out.trim();
}

/** Remove ANSI CSI and OSC escape sequences. */
export function stripAnsi(text: string): string {
  return text
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
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
          stdout: cleanOutput(body),
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
        const found = extractSentinelOutput(output, id, donePattern, wrapped);
        return found ? found.body : stripSentinels(output, id, wrapped);
      }
    });
  }
}
