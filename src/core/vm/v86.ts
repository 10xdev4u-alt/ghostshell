import { V86, type V86Image, type V86Options } from 'v86';
import type { CommandResult, DirEntry, VMHandle, VMImage } from '@/types/index.js';
import { SerialQueue } from '@/lib/queue.js';

/**
 * v86-backed VM handle.
 *
 * Verified v86 API (node_modules/v86/v86.d.ts @ 0.5.473):
 *  - `new V86(options)`; `run()` / `stop()` / `destroy()` / `restart()`
 *  - `save_state(): Promise<ArrayBuffer>` / `restore_state(buf)`
 *  - `serial0_send(data: string)` — write to guest serial
 *  - `add_listener('serial0-output-byte', (byte: number) => ...)` — read
 *  - `create_file(path, Uint8Array)` / `read_file(path): Promise<Uint8Array>`
 *  - events: emulator-ready, emulator-started, emulator-stopped,
 *    download-progress, serial0-output-byte, 9p-*
 *  - `filesystem: { basefs, baseurl, handle9p, proxy_url }`
 *  - `net_device: { backend, url, id, ... }`
 *
 * v86 constraints: 32-bit (ia32), single-core, Pentium-4 class. The official
 * Alpine image is i386/alpine:3.21. Pre-bake everything.
 */

export interface V86Deps {
  screenContainer?: HTMLElement | null;
  wasmPath?: string;
  bios?: V86Image;
  vgaBios?: V86Image;
  cdrom?: V86Image;
  hda?: V86Image;
  netDevice?: V86Options['net_device'];
  filesystem?: V86Options['filesystem'];
}

export class V86VMHandle implements VMHandle {
  readonly id = 'v86';
  private emu: V86 | null = null;
  private queue = new SerialQueue();
  private serialListeners = new Set<(data: string) => void>();
  private serialBuffer = '';
  private image: VMImage | null = null;

  get running(): boolean {
    return this.emu?.is_running() ?? false;
  }

  async start(image: VMImage): Promise<void> {
    this.image = image;
    const options: V86Options = {
      memory_size: 512 * 1024 * 1024,
      vga_memory_size: 8 * 1024 * 1024,
      autostart: true,
      disable_mouse: true,
      disable_keyboard: true,
      disable_speaker: true,
      // TODO: wire bios/vga_bios/cdrom/hda from image manifest
    };
    this.emu = new V86(options);
    this.emu.add_listener('serial0-output-byte', (byte: number) => {
      const ch = String.fromCharCode(byte);
      this.serialBuffer += ch;
      for (const fn of this.serialListeners) fn(ch);
    });
    await this.emu.run();
  }

  async stop(): Promise<void> {
    await this.emu?.stop();
  }

  async pause(): Promise<void> {
    // TODO: v86 has no pause; emulate by stopping the JIT or saving state.
    throw new Error('pause not implemented (issue #16)');
  }

  async resume(): Promise<void> {
    throw new Error('resume not implemented (issue #16)');
  }

  async exec(cmd: string, timeoutMs = 60_000): Promise<CommandResult> {
    return this.queue.add(async () => {
      const started = Date.now();
      // TODO: send command with a unique sentinel, collect output until sentinel.
      this.emu?.serial0_send(`${cmd}\n`);
      return {
        stdout: this.serialBuffer,
        stderr: '',
        exitCode: 0,
        durationMs: Date.now() - started,
        timedOut: false,
      };
    });
  }

  async write(path: string, content: string): Promise<void> {
    await this.emu?.create_file(path, new TextEncoder().encode(content));
  }

  async read(path: string): Promise<string> {
    const data = await this.emu?.read_file(path);
    return data ? new TextDecoder().decode(data) : '';
  }

  async list(path: string): Promise<DirEntry[]> {
    // TODO: run `ls -la` via serial and parse, or implement 9p readdir.
    throw new Error('list not implemented (issue #16)');
  }

  onSerial = (fn: (data: string) => void): void => {
    this.serialListeners.add(fn);
  };

  /** Save the full VM state (for snapshots / time-travel). */
  async saveState(): Promise<ArrayBuffer> {
    if (!this.emu) throw new Error('VM not started');
    return this.emu.save_state();
  }

  async restoreState(state: ArrayBuffer): Promise<void> {
    await this.emu?.restore_state(state);
  }
}
