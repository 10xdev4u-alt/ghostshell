import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { V86Options } from 'v86';
import { DEFAULT_IMAGE } from '@/core/vm/image.js';
import { createV86Filesystem } from '@/core/vm/fs9p.js';
import { buildNetDevice } from '@/core/vm/network.js';
import { V86VMHandle } from '@/core/vm/v86.js';

const { instances, neverReady } = vi.hoisted(() => ({
  instances: [] as any[],
  neverReady: { value: false },
}));

vi.mock('v86', () => {
  return {
    V86: class {
      options: V86Options;
      running = false;
      ready = false;
      sent: string[] = [];
      files = new Map<string, Uint8Array>();
      dirs = new Set<string>();
      saved: ArrayBuffer[] = [];
      restored: ArrayBuffer[] = [];
      listeners = new Map<string, Set<(arg: any) => void>>();

      constructor(options: V86Options) {
        this.options = options;
        instances.push(this);
        // v86 0.5.473 assigns `this.v86` asynchronously, inside the WASM
        // load promise's `.then()`. Model that delay.
        queueMicrotask(() => {
          if (neverReady.value) return;
          this.ready = true;
          this.emit('emulator-ready', undefined);
        });
      }

      async run(): Promise<void> {
        if (!this.ready) {
          throw new TypeError("Cannot read properties of undefined (reading 'run')");
        }
        this.running = true;
        this.emit('emulator-started', undefined);
      }

      async stop(): Promise<void> {
        this.running = false;
        this.emit('emulator-stopped', undefined);
      }

      async destroy(): Promise<void> {
        this.running = false;
      }

      restart(): void {
        this.running = true;
      }

      is_running(): boolean {
        return this.running;
      }

      add_listener(event: string, fn: (arg: any) => void): void {
        let set = this.listeners.get(event);
        if (!set) {
          set = new Set();
          this.listeners.set(event, set);
        }
        set.add(fn);
      }

      remove_listener(event: string, fn: (arg: any) => void): void {
        this.listeners.get(event)?.delete(fn);
      }

      serial0_send(data: string): void {
        this.sent.push(data);
        const out = this.serialScript(data);
        if (out) this.emitSerial(out);
      }

      async save_state(): Promise<ArrayBuffer> {
        const buf = new ArrayBuffer(16);
        this.saved.push(buf);
        return buf;
      }

      async restore_state(buf: ArrayBuffer): Promise<void> {
        this.restored.push(buf);
      }

      async create_file(path: string, data: Uint8Array): Promise<void> {
        const parent = path.slice(0, path.lastIndexOf('/')) || '/';
        if (parent !== '/' && !this.dirs.has(parent)) throw new Error('FileNotFoundError');
        this.files.set(path, data);
        this.dirs.add(path);
      }

      async read_file(path: string): Promise<Uint8Array> {
        const data = this.files.get(path);
        if (!data) throw new Error('FileNotFoundError');
        return data;
      }

      /** Default guest: echo the input, print the begin marker, run, sentinel. */
      serialScript(data: string): string {
        const mkdir = /mkdir -p '([^']+)'/.exec(data);
        if (mkdir) this.dirs.add(mkdir[1]!);
        const id = /__GS_DONE_([A-Za-z0-9]+)__/.exec(data)?.[1] ?? 'missing';
        const prompt = `__GS_PROMPT_${id}__`;
        let body = 'hello\n';
        if (data.includes('ls -A -1')) {
          body = 'regular file|5|1700000000|a.txt\ndirectory|0|1700000000|sub\n';
        }
        return (
          `localhost:~# ${data}__GS_BEGIN_${id}__\n` +
          `${prompt}${body}${prompt}` +
          `__GS_DONE_${id}__ 0\n`
        );
      }

      emitSerial(text: string): void {
        for (const ch of text) this.emit('serial0-output-byte', ch.charCodeAt(0));
      }

      emit(event: string, arg: any): void {
        for (const fn of this.listeners.get(event) ?? []) fn(arg);
      }
    },
  };
});

function sentinelId(data: string): string {
  return /__GS_DONE_([A-Za-z0-9]+)__/.exec(data)?.[1] ?? 'missing';
}

describe('V86VMHandle', () => {
  beforeEach(() => {
    instances.length = 0;
    neverReady.value = false;
  });

  it('boots Alpine with the expected v86 options', async () => {
    const vm = new V86VMHandle();
    await vm.start(DEFAULT_IMAGE);
    const emu = instances[0]!;

    expect(emu.options.memory_size).toBe(512 * 1024 * 1024);
    expect(emu.options.vga_memory_size).toBe(8 * 1024 * 1024);
    expect(emu.options.autostart).toBe(false);
    expect(emu.options.disable_keyboard).toBe(true);
    expect(emu.options.disable_mouse).toBe(true);
    expect(emu.options.disable_speaker).toBe(true);
    expect(emu.options.bios).toEqual({ url: 'https://copy.sh/v86/bios/seabios.bin' });
    expect(emu.options.vga_bios).toEqual({ url: 'https://copy.sh/v86/bios/vgabios.bin' });
    expect(emu.options.filesystem).toEqual({
      baseurl: 'images/alpine-rootfs-flat',
      basefs: 'images/alpine-fs.json',
    });
    expect(emu.options.bzimage_initrd_from_filesystem).toBe(true);
    expect(emu.options.cmdline).toContain('root=host9p');
    expect(vm.running).toBe(true);
    expect(vm.currentImage?.id).toBe(DEFAULT_IMAGE.id);
  });

  it('waits for the emulator to initialize before running', async () => {
    const vm = new V86VMHandle();
    const pending = vm.start(DEFAULT_IMAGE);

    // v86 assigns its internal emulator asynchronously; run() before that
    // point is the bug this guards against.
    expect(instances[0]!.ready).toBe(false);
    await pending;
    expect(instances[0]!.ready).toBe(true);
    expect(instances[0]!.running).toBe(true);
  });

  it('rejects when the emulator never becomes ready', async () => {
    neverReady.value = true;
    const vm = new V86VMHandle({ readyTimeoutMs: 20 });
    await expect(vm.start(DEFAULT_IMAGE)).rejects.toThrow(/Timed out/);
  });

  it('passes netDevice through to the v86 options', async () => {
    const netDevice = { relay_url: 'fetch' } as V86Options['net_device'];
    const vm = new V86VMHandle({ netDevice });
    await vm.start(DEFAULT_IMAGE);
    expect(instances[0]!.options.net_device).toEqual(netDevice);
  });

  it('passes every boot dependency through to the v86 options', async () => {
    const bios = { url: 'bios.bin' };
    const vgaBios = { url: 'vgabios.bin' };
    const cdrom = { url: 'cdrom.iso' };
    const hda = { url: 'hda.img' };
    const filesystem = createV86Filesystem({ prefix: 'test-fs9p' });
    const netDevice = { relay_url: 'fetch' } as V86Options['net_device'];
    const wasmPath = 'build/v86.wasm';
    const vm = new V86VMHandle({
      bios,
      vgaBios,
      cdrom,
      hda,
      filesystem,
      netDevice,
      wasmPath,
    });
    await vm.start(DEFAULT_IMAGE);
    const options = instances[0]!.options;

    expect(options.bios).toEqual(bios);
    expect(options.vga_bios).toEqual(vgaBios);
    expect(options.cdrom).toEqual(cdrom);
    expect(options.hda).toEqual(hda);
    expect(options.filesystem).toBe(filesystem);
    expect(options.net_device).toEqual(netDevice);
    expect(options.wasm_path).toBe(wasmPath);
  });

  it('attaches the network device built for the configured mode', async () => {
    const netDevice = buildNetDevice({ mode: 'fetch' });
    const vm = new V86VMHandle({ netDevice });
    await vm.start(DEFAULT_IMAGE);
    expect(instances[0]!.options.net_device).toEqual({ relay_url: 'fetch' });
  });

  it('leaves net_device unset in airplane mode', async () => {
    const netDevice = buildNetDevice({ mode: 'off' });
    const vm = new V86VMHandle({ netDevice });
    await vm.start(DEFAULT_IMAGE);
    expect(instances[0]!.options.net_device).toBeUndefined();
  });

  it('allows overriding the boot options', async () => {
    const vm = new V86VMHandle({
      memorySizeBytes: 256 * 1024 * 1024,
      bios: { url: 'custom-bios.bin' },
      filesystem: { baseurl: 'custom-flat', basefs: 'custom.json' },
      cmdline: 'custom cmdline',
      bzimageInitrdFromFilesystem: false,
    });
    await vm.start(DEFAULT_IMAGE);
    const emu = instances[0]!;

    expect(emu.options.memory_size).toBe(256 * 1024 * 1024);
    expect(emu.options.bios).toEqual({ url: 'custom-bios.bin' });
    expect(emu.options.filesystem).toEqual({ baseurl: 'custom-flat', basefs: 'custom.json' });
    expect(emu.options.cmdline).toBe('custom cmdline');
    expect(emu.options.bzimage_initrd_from_filesystem).toBe(false);
  });

  it('stop stops the emulator', async () => {
    const vm = new V86VMHandle();
    await vm.start(DEFAULT_IMAGE);
    expect(vm.running).toBe(true);
    await vm.stop();
    expect(vm.running).toBe(false);
  });

  it('replacing a running instance stops and destroys the old one', async () => {
    const vm = new V86VMHandle();
    await vm.start(DEFAULT_IMAGE);
    const first = instances[0]!;
    await vm.start(DEFAULT_IMAGE);
    const second = instances[1]!;

    expect(first.running).toBe(false);
    expect(second.running).toBe(true);
    expect(vm.running).toBe(true);
  });

  it('exec sends a sentinel-wrapped command and returns the result', async () => {
    const vm = new V86VMHandle();
    await vm.start(DEFAULT_IMAGE);
    const emu = instances[0]!;

    const result = await vm.exec('echo hello');
    expect(emu.sent[0]).toContain('echo __GS_BEGIN_');
    expect(emu.sent[0]).toContain('echo hello');
    expect(emu.sent[0]).toContain('echo __GS_DONE_');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello');
    expect(result.stderr).toBe('');
    expect(result.timedOut).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('exec reports non-zero exit codes', async () => {
    const vm = new V86VMHandle();
    await vm.start(DEFAULT_IMAGE);
    const emu = instances[0]!;
    emu.serialScript = (data: string) => {
      const id = sentinelId(data);
      return `__GS_BEGIN_${id}__\n__GS_DONE_${id}__ 7\n`;
    };

    const result = await vm.exec('false');
    expect(result.exitCode).toBe(7);
    expect(result.stdout).toBe('');
  });

  it('exec reports multi-digit exit codes', async () => {
    const vm = new V86VMHandle();
    await vm.start(DEFAULT_IMAGE);
    const emu = instances[0]!;
    emu.serialScript = (data: string) => {
      const id = sentinelId(data);
      return `__GS_BEGIN_${id}__\n__GS_DONE_${id}__ 127\n`;
    };

    const result = await vm.exec('false');
    expect(result.exitCode).toBe(127);
  });

  it('exec strips the shell prompt from stdout', async () => {
    const vm = new V86VMHandle();
    await vm.start(DEFAULT_IMAGE);

    const result = await vm.exec('echo hello');
    expect(result.stdout).toBe('hello');
    expect(result.stdout).not.toContain('__GS_PROMPT_');
    expect(result.stdout).not.toContain('localhost:~#');
  });

  it('exec throws when the VM is not started', async () => {
    const vm = new V86VMHandle();
    await expect(vm.exec('echo hi')).rejects.toThrow('VM not started');
  });

  it('write creates parent directories and writes the file', async () => {
    const vm = new V86VMHandle();
    await vm.start(DEFAULT_IMAGE);
    const emu = instances[0]!;

    await vm.write('/root/workspace/a.txt', 'hello');
    expect(emu.files.get('/root/workspace/a.txt')).toEqual(new TextEncoder().encode('hello'));
    expect(emu.sent.some((s: string) => s.includes("mkdir -p '/root/workspace'"))).toBe(true);
  });

  it('read decodes file contents', async () => {
    const vm = new V86VMHandle();
    await vm.start(DEFAULT_IMAGE);
    await vm.write('/root/workspace/a.txt', 'hello');
    await expect(vm.read('/root/workspace/a.txt')).resolves.toBe('hello');
  });

  it('read rejects for a missing file', async () => {
    const vm = new V86VMHandle();
    await vm.start(DEFAULT_IMAGE);
    await expect(vm.read('/nope')).rejects.toThrow('FileNotFoundError');
  });

  it('list parses guest output into entries', async () => {
    const vm = new V86VMHandle();
    await vm.start(DEFAULT_IMAGE);

    const entries = await vm.list('/root/workspace');
    expect(entries).toEqual([
      { name: 'a.txt', kind: 'file', size: 5, mtime: 1_700_000_000_000 },
      { name: 'sub', kind: 'dir', size: 0, mtime: 1_700_000_000_000 },
    ]);
  });

  it('list uses a shell-safe field separator', async () => {
    const vm = new V86VMHandle();
    await vm.start(DEFAULT_IMAGE);
    const emu = instances[0]!;

    await vm.list('/root/workspace');
    expect(emu.sent[0]).toContain("stat -c '%F|%s|%Y|%n'");
    expect(emu.sent[0]).not.toContain('\t');
  });

  it('list quotes the path in the error branch', async () => {
    const vm = new V86VMHandle();
    await vm.start(DEFAULT_IMAGE);
    const emu = instances[0]!;

    await vm.list('/tmp/a b"c');
    expect(emu.sent[0]).toContain(`echo list: not a directory: '/tmp/a b"c'`);
  });

  it('list throws on a non-zero exit', async () => {
    const vm = new V86VMHandle();
    await vm.start(DEFAULT_IMAGE);
    const emu = instances[0]!;
    emu.serialScript = (data: string) => {
      const id = sentinelId(data);
      return `__GS_BEGIN_${id}__\nlist: not a directory: /nope\n__GS_DONE_${id}__ 1\n`;
    };

    await expect(vm.list('/nope')).rejects.toThrow(/list \/nope failed/);
  });

  it('saveState and restoreState delegate to the emulator', async () => {
    const vm = new V86VMHandle();
    await vm.start(DEFAULT_IMAGE);
    const emu = instances[0]!;

    const state = await vm.saveState();
    expect(state).toBeInstanceOf(ArrayBuffer);
    await vm.restoreState(state);
    expect(emu.restored).toContain(state);
  });

  it('onSerial receives guest output', async () => {
    const vm = new V86VMHandle();
    const chunks: string[] = [];
    vm.onSerial((chunk) => chunks.push(chunk));
    await vm.start(DEFAULT_IMAGE);

    instances[0]!.emitSerial('hello');
    expect(chunks.join('')).toBe('hello');
  });

  it('serializes concurrent exec calls', async () => {
    const vm = new V86VMHandle();
    await vm.start(DEFAULT_IMAGE);
    const emu = instances[0]!;
    emu.serialScript = () => '';
    const order: string[] = [];

    const first = vm.exec('one').then((r) => order.push(r.stdout));
    const second = vm.exec('two').then((r) => order.push(r.stdout));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(emu.sent).toHaveLength(1);
    emu.emitSerial(
      `__GS_BEGIN_${sentinelId(emu.sent[0]!)}__\none\n__GS_DONE_${sentinelId(emu.sent[0]!)}__ 0\n`,
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(emu.sent).toHaveLength(2);
    emu.emitSerial(
      `__GS_BEGIN_${sentinelId(emu.sent[1]!)}__\ntwo\n__GS_DONE_${sentinelId(emu.sent[1]!)}__ 0\n`,
    );

    await Promise.all([first, second]);
    expect(order).toEqual(['one', 'two']);
  });
});
