import type { CommandResult, VMHandle } from '@/types/index.js';

/**
 * Serial command runner with a sentinel protocol.
 *
 * v86 has one serial port, so commands are serialized. To know when a command
 * finishes, we append a unique sentinel echo:
 *
 *   $ <command>; echo __GS_DONE_<id>__ $?
 *
 * and collect output until the sentinel appears. The exit code is parsed from
 * the sentinel line.
 */

export interface CommandRunner {
  run(cmd: string, timeoutMs?: number): Promise<CommandResult>;
}

export function createCommandRunner(vm: VMHandle): CommandRunner {
  return {
    async run(cmd: string, timeoutMs = 60_000): Promise<CommandResult> {
      const id = Math.random().toString(36).slice(2, 10);
      const sentinel = `__GS_DONE_${id}__`;
      const wrapped = `${cmd}\n`; // TODO: append sentinel
      void sentinel;
      void wrapped;
      return vm.exec(cmd, timeoutMs);
    },
  };
}

/** Strip sentinel lines from command output. */
export function cleanOutput(raw: string): string {
  return raw
    .split('\n')
    .filter((line) => !line.includes('__GS_DONE_'))
    .join('\n')
    .trim();
}
