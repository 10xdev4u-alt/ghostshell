/**
 * Serial sentinel filter.
 *
 * The command runner (`src/core/vm/commands.ts`) wraps every guest command in
 * a begin/done sentinel pair and sets `PS1` to a per-run prompt sentinel. The
 * guest tty echoes everything we send, so the raw serial stream contains the
 * wrapper and the command itself:
 *
 *   localhost:~# PS1='__GS_PROMPT_<id>__'
 *   echo __GS_BEGIN_<id>__
 *   <command>
 *   echo __GS_DONE_<id>__ $?
 *   __GS_BEGIN_<id>__
 *   <command output>
 *   __GS_DONE_<id>__ <code>
 *
 * The UI must not show the protocol. This filter drops the prompt sentinel, the
 * echoed wrapper, the begin/done markers, and the echoed command, while
 * preserving the command output. It reuses the same marker shapes as the
 * command runner so the UI and the result parser agree.
 *
 * The filter is a line-oriented state machine. It is fed raw chunks from
 * `VMHandle.onSerial` and returns the user-visible output for each chunk.
 */

const PROMPT_SENTINEL = /__GS_PROMPT_[A-Za-z0-9]+__/g;
/**
 * The PS1 assignment is the first wrapper line. Match it before stripping the
 * prompt sentinel: the previous run's prompt sentinel can be glued to it
 * (`__GS_PROMPT_old__PS1='__GS_PROMPT_new__'`).
 */
const PS1_ASSIGN = /(?:^|__GS_PROMPT_[A-Za-z0-9]+__)PS1='__GS_PROMPT_[A-Za-z0-9]+__'$/;
const BEGIN_ECHO = /^echo __GS_BEGIN_[A-Za-z0-9]+__$/;
const BEGIN_MARKER = /^__GS_BEGIN_[A-Za-z0-9]+__$/;
const DONE_ECHO = /^echo __GS_DONE_[A-Za-z0-9]+__ \$\?$/;
const DONE_MARKER = /^__GS_DONE_[A-Za-z0-9]+__ -?\d+$/;
/**
 * Leading shell prompt (e.g. `localhost:~# `, `root@localhost:/root# `).
 * The tty prints it before the echoed command, so it is stripped before
 * matching the wrapper lines.
 */
const SHELL_PROMPT = /^(?:[\w.-]+@)?[\w.-]+:[\w/.~-]*[#$]\s/;

type Mode = 'idle' | 'wrapper' | 'body';

export interface SerialFilter {
  /**
   * Feed a raw serial chunk. Returns the filtered, user-visible output.
   * Partial lines are buffered until a newline arrives.
   */
  write(chunk: string): string;
  /**
   * Tell the filter which command is about to run. The echoed command lines
   * are dropped even when they arrive after the begin marker (interleaved
   * tty echo). Pass an empty string when the command is unknown.
   */
  beginCommand(command: string): void;
  /** Clear the command context once the command has finished. */
  endCommand(): void;
  /** Drop all buffered state (on VM stop / restart). */
  reset(): void;
  /** Flush a trailing partial line. */
  flush(): string;
}

export function createSerialFilter(): SerialFilter {
  let buffer = '';
  let mode: Mode = 'idle';
  let commandLines: string[] = [];
  let commandIndex = 0;
  let output = '';

  const emit = (text: string): void => {
    output += text;
  };

  const dropCommandLine = (line: string): boolean => {
    if (commandIndex >= commandLines.length) return false;
    if (line !== commandLines[commandIndex]) return false;
    commandIndex += 1;
    return true;
  };

  const processLine = (rawLine: string): void => {
    let line = rawLine.replace(/\r$/, '');
    line = line.replace(SHELL_PROMPT, '');
    if (line === '') return;

    // The PS1 assignment opens the wrapper. Check it before stripping the
    // prompt sentinel so a glued previous sentinel does not hide it.
    if (mode === 'idle' && PS1_ASSIGN.test(line)) {
      mode = 'wrapper';
      return;
    }

    line = line.replace(PROMPT_SENTINEL, '');
    if (line === '') return;

    if (mode === 'idle') {
      if (BEGIN_ECHO.test(line)) {
        mode = 'wrapper';
        return;
      }
      if (BEGIN_MARKER.test(line)) {
        mode = 'body';
        return;
      }
      if (DONE_MARKER.test(line) || DONE_ECHO.test(line)) return;
      if (dropCommandLine(line)) return;
      emit(`${line}\n`);
      return;
    }

    if (mode === 'wrapper') {
      if (BEGIN_MARKER.test(line)) {
        mode = 'body';
        return;
      }
      if (DONE_MARKER.test(line)) {
        mode = 'idle';
        return;
      }
      if (DONE_ECHO.test(line)) return;
      // The echoed command and any other wrapper noise.
      return;
    }

    // mode === 'body'
    if (DONE_MARKER.test(line)) {
      mode = 'idle';
      return;
    }
    if (DONE_ECHO.test(line)) return;
    if (BEGIN_MARKER.test(line)) return;
    if (dropCommandLine(line)) return;
    emit(`${line}\n`);
  };

  const takeOutput = (): string => {
    const out = output;
    output = '';
    return out;
  };

  return {
    write(chunk: string): string {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        processLine(line);
      }
      return takeOutput();
    },

    beginCommand(command: string): void {
      commandLines = command.length > 0 ? command.split('\n') : [];
      commandIndex = 0;
    },

    endCommand(): void {
      commandLines = [];
      commandIndex = 0;
    },

    reset(): void {
      buffer = '';
      mode = 'idle';
      commandLines = [];
      commandIndex = 0;
      output = '';
    },

    flush(): string {
      if (buffer.length > 0) {
        const line = buffer;
        buffer = '';
        processLine(line);
      }
      return takeOutput();
    },
  };
}
