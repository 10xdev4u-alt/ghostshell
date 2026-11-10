import { V86, type V86Image, type V86Options } from 'v86';
import type { CommandResult, DirEntry, VMHandle, VMImage } from '@/types/index.js';
import { SerialQueue } from '@/lib/queue.js';
import { createCommandRunner, type CommandRunner, type SerialTransport } from '@/core/vm/commands.js';
import { ALPINE_BOOT } from '@/core/vm/image.js';

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
 *
 * The guest serial console is the control channel. It merges stdout and
 * stderr, so `exec` reports the merged stream as `stdout`.
 */

export interface V86Deps {
  screenContainer?: HTMLElement | null | undefined;
  wasmPath?: string | undefined;
  bios?: V86Image | undefined;
  vgaBios?: V86Image | undefined;
  cdrom?: V86Image | undefined;
  hda?: V86Image | undefined;
  netDevice?: V86Options['net_device'] | undefined;
  filesystem?: V86Options['filesystem'] | undefined;
  initial_state?: V86Image | undefined;
  memorySizeBytes?: number | undefined;
  vgaMemorySizeBytes?: number | undefined;
  cmdline?: string | undefined;
  bzimageInitrdFromFilesystem?: boolean | undefined;
  /** How long to wait for the v86 WASM/emulator init before failing. */
  readyTimeoutMs?: number | undefined;
}

const DEFAULT_MEMORY_BYTES = 512 * 1024 * 1024;
const DEFAULT_VGA_MEMORY_BYTES = 8 * 1024 * 1024;
const DEFAULT_READY_TIMEOUT_MS = 60_000;
const LIST_TAB = '\t';

export class V86VMHandle implements VMHandle {
  readonly id = 'v86';
  private emu: V86 | null = null;
  private image: VMImage | null = null;
  private queue = new SerialQueue();
  private serialListeners = new Set<(data: string) => void>();
  private decoder = new TextDecoder('utf-8', { fatal: false });
  private readonly deps: V86Deps;
  private readonly transport: SerialTransport = {
    send: (data) => {
      this.emu?.serial0_send(data);
    },
    onData: (fn) => this.subscribe(fn),
  };
  private readonly runner: CommandRunner = createCommandRunner(this.transport);

  constructor(deps: V86Deps = {}) {
    this.deps = deps;
  }

  get running(): boolean {
    return this.emu?.is_running() ?? false;
  }

  async start(image: VMImage): Promise<void> {
    if (this.emu) {
      await this.emu.stop().catch(() => undefined);
      await this.emu.destroy().catch(() => undefined);
      this.emu = null;
    }
    this.image = image;
    const emu = new V86(this.buildOptions());
    this.emu = emu;
    emu.add_listener('serial0-output-byte', (byte: number) => {
      const ch = this.decoder.decode(new Uint8Array([byte]), { stream: true });
      if (ch) for (const fn of this.serialListeners) fn(ch);
    });
    await this.waitForReady(emu);
    await emu.run();
  }

  /**
   * Wait until v86 has assigned its internal emulator.
   *
   * v86 0.5.473 assigns `this.v86` asynchronously inside the WASM load
   * promise's `.then()`. Calling `run()` before that resolves hits
   * `this.v86.run()` with `this.v86 === undefined` and rejects with a
   * `TypeError`. `emulator-ready` is emitted from `v86.init()` once the
   * emulator exists; `emulator-loaded` is emitted immediately after, so
   * either is a safe gate.
   */
  private waitForReady(emu: V86): Promise<void> {
    const timeoutMs = this.deps.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        emu.remove_listener('emulator-ready', onReady);
        emu.remove_listener('emulator-loaded', onReady);
      };
      const onReady = (): void => {
        cleanup();
        resolve();
      };
      timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `Timed out waiting for the v86 emulator to initialize (${timeoutMs}ms)`,
          ),
        );
      }, timeoutMs);
      emu.add_listener('emulator-ready', onReady);
      emu.add_listener('emulator-loaded', onReady);
    });
  }

  async stop(): Promise<void> {
    if (!this.emu) return;
    await this.emu.stop();
  }

  async pause(): Promise<void> {
    throw new Error('pause not implemented (issue #16)');
  }

  async resume(): Promise<void> {
    throw new Error('resume not implemented (issue #16)');
  }

  async exec(cmd: string, timeoutMs = 60_000): Promise<CommandResult> {
    this.requireEmu();
    return this.queue.add(() => this.runner.run(cmd, timeoutMs));
  }

  async write(path: string, content: string): Promise<void> {
    const emu = this.requireEmu();
    const data = new TextEncoder().encode(content);
    try {
      await emu.create_file(path, data);
    } catch {
      // v86 rejects writes whose parent directory does not exist yet.
      const dir = parentDir(path);
      if (dir !== '/') {
        await this.exec(`mkdir -p ${shellQuote(dir)}`);
      }
      await emu.create_file(path, data);
    }
  }

  async read(path: string): Promise<string> {
    const emu = this.requireEmu();
    const data = await emu.read_file(path);
    return new TextDecoder('utf-8', { fatal: false }).decode(data);
  }

  async list(path: string): Promise<DirEntry[]> {
    this.requireEmu();
    return this.queue.add(async () => {
      const cmd =
        `if [ -d ${shellQuote(path)} ]; then ` +
        `(cd ${shellQuote(path)} && ls -A -1 | while IFS= read -r f; do ` +
        `stat -c '%F${LIST_TAB}%s${LIST_TAB}%Y${LIST_TAB}%n' "$f"; done); ` +
        `else echo "list: not a directory: ${path}"; false; fi`;
      const res = await this.runner.run(cmd);
      if (res.exitCode !== 0) {
        throw new Error(`list ${path} failed (exit ${res.exitCode}): ${res.stdout.trim()}`);
      }
      return res.stdout
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line): DirEntry => {
          const [type, size, mtime, ...rest] = line.split(LIST_TAB);
          return {
            name: rest.join(LIST_TAB),
            kind: type === 'directory' ? 'dir' : type === 'symbolic link' ? 'symlink' : 'file',
            size: Number(size ?? 0),
            mtime: Math.floor(Number(mtime ?? 0) * 1000),
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
    });
  }

  onSerial = (fn: (data: string) => void): void => {
    this.serialListeners.add(fn);
  };

  /** Save the full VM state (for snapshots / time-travel). */
  async saveState(): Promise<ArrayBuffer> {
    return this.requireEmu().save_state();
  }

  async restoreState(state: ArrayBuffer): Promise<void> {
    await this.requireEmu().restore_state(state);
  }

  /** The image this handle was last started with. */
  get currentImage(): VMImage | null {
    return this.image;
  }

  private buildOptions(): V86Options {
    const deps = this.deps;
    return {
      memory_size: deps.memorySizeBytes ?? DEFAULT_MEMORY_BYTES,
      vga_memory_size: deps.vgaMemorySizeBytes ?? DEFAULT_VGA_MEMORY_BYTES,
      autostart: false,
      disable_mouse: true,
      disable_keyboard: true,
      disable_speaker: true,
      bios: deps.bios ?? { url: ALPINE_BOOT.biosUrl },
      vga_bios: deps.vgaBios ?? { url: ALPINE_BOOT.vgaBiosUrl },
      filesystem: deps.filesystem ?? {
        baseurl: ALPINE_BOOT.rootfsBaseUrl,
        basefs: ALPINE_BOOT.rootfsFsJson,
      },
      cmdline: deps.cmdline ?? ALPINE_BOOT.cmdline,
      bzimage_initrd_from_filesystem: deps.bzimageInitrdFromFilesystem ?? true,
      ...(deps.wasmPath !== undefined ? { wasm_path: deps.wasmPath } : {}),
      ...(deps.cdrom !== undefined ? { cdrom: deps.cdrom } : {}),
      ...(deps.hda !== undefined ? { hda: deps.hda } : {}),
      ...(deps.netDevice !== undefined ? { net_device: deps.netDevice } : {}),
      ...(deps.initial_state !== undefined ? { initial_state: deps.initial_state } : {}),
      ...(deps.screenContainer !== undefined
        ? { screen_container: deps.screenContainer }
        : {}),
    };
  }

  private requireEmu(): V86 {
    if (!this.emu) throw new Error('VM not started');
    return this.emu;
  }

  private subscribe(fn: (data: string) => void): () => void {
    this.serialListeners.add(fn);
    return () => {
      this.serialListeners.delete(fn);
    };
  }
}

function parentDir(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx > 0 ? path.slice(0, idx) : '/';
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
