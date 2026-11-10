import { describe, expect, it } from 'vitest';
import type { V86Options } from 'v86';
import {
  ManifestError,
  cloneNode,
  cloneTree,
  cowRemoveChild,
  cowSetChild,
  cowWrite,
  create9pHandler,
  createEmptyTree,
  createV86Filesystem,
  findNode,
  loadTree,
  persistTree,
  type Fs9pHandle,
  type P9Node,
} from '@/core/vm/fs9p.js';

// ---------------------------------------------------------------------------
// Fake OPFS
// ---------------------------------------------------------------------------

/** Model OPFS's `DOMException(msg, 'NotFoundError')` for a missing entry. */
function notFoundError(name: string): Error {
  return Object.assign(new Error(`not found: ${name}`), { name: 'NotFoundError' });
}

class FakeFileHandle {
  data = new Uint8Array();
  /** Injected read failure: `getFile()` rejects with this error. */
  readError?: Error;

  constructor(
    private readonly dir: FakeDirHandle,
    private readonly name: string,
  ) {}

  async createWritable() {
    const handle = this;
    return {
      async write(chunk: Uint8Array) {
        handle.data = chunk.slice();
      },
      async close() {},
      async abort() {},
    };
  }

  async getFile() {
    if (this.readError) throw this.readError;
    const data = this.data;
    return {
      async arrayBuffer() {
        return data.slice().buffer;
      },
    };
  }
}

class FakeDirHandle {
  readonly dirs = new Map<string, FakeDirHandle>();
  readonly files = new Map<string, FakeFileHandle>();

  constructor(readonly name: string) {}

  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    const existing = this.dirs.get(name);
    if (existing) return existing;
    if (!options?.create) throw notFoundError(name);
    const dir = new FakeDirHandle(name);
    this.dirs.set(name, dir);
    return dir;
  }

  async getFileHandle(name: string, options?: { create?: boolean }) {
    const existing = this.files.get(name);
    if (existing) return existing;
    if (!options?.create) throw notFoundError(name);
    const handle = new FakeFileHandle(this, name);
    this.files.set(name, handle);
    return handle;
  }

  async removeEntry(name: string) {
    if (!this.files.delete(name) && !this.dirs.delete(name)) {
      throw new Error(`not found: ${name}`);
    }
  }

  async *keys(): AsyncIterableIterator<string> {
    yield* this.files.keys();
    yield* this.dirs.keys();
  }
}

// ---------------------------------------------------------------------------
// Frame helpers
// ---------------------------------------------------------------------------

function encodeFrame(type: number, tag: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(7 + payload.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, out.byteLength, true);
  view.setUint8(4, type);
  view.setUint16(5, tag, true);
  out.set(payload, 7);
  return out;
}

interface Reply {
  size: number;
  type: number;
  tag: number;
  payload: Uint8Array;
}

function decodeReply(buf: Uint8Array): Reply {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return {
    size: view.getUint32(0, true),
    type: view.getUint8(4),
    tag: view.getUint16(5, true),
    payload: buf.subarray(7),
  };
}

class FrameWriter {
  private readonly parts: Uint8Array[] = [];
  private length = 0;

  private push(bytes: Uint8Array): void {
    this.parts.push(bytes);
    this.length += bytes.byteLength;
  }

  u8(v: number): this {
    this.push(Uint8Array.of(v & 0xff));
    return this;
  }

  u16(v: number): this {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, v & 0xffff, true);
    this.push(b);
    return this;
  }

  u32(v: number): this {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v >>> 0, true);
    this.push(b);
    return this;
  }

  u64(v: bigint | number): this {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, BigInt(v), true);
    this.push(b);
    return this;
  }

  string(s: string): this {
    const bytes = new TextEncoder().encode(s);
    this.u16(bytes.byteLength);
    this.push(bytes);
    return this;
  }

  bytes(b: Uint8Array): this {
    this.push(b);
    return this;
  }

  build(): Uint8Array {
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const part of this.parts) {
      out.set(part, offset);
      offset += part.byteLength;
    }
    return out;
  }
}

class FrameReader {
  private readonly view: DataView;
  offset = 0;

  constructor(private readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  u8(): number {
    const v = this.buf[this.offset++]!;
    return v;
  }

  u16(): number {
    const v = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return v;
  }

  u32(): number {
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }

  u64(): bigint {
    const v = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    return v;
  }

  string(): string {
    const len = this.u16();
    return new TextDecoder().decode(this.bytes(len));
  }

  bytes(n: number): Uint8Array {
    const out = this.buf.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }

  qid(): { type: number; version: number; path: bigint } {
    return { type: this.u8(), version: this.u32(), path: this.u64() };
  }
}

function request(
  handle: Fs9pHandle,
  type: number,
  tag: number,
  payload: Uint8Array,
): Promise<Reply> {
  return new Promise((resolve) => {
    handle(encodeFrame(type, tag, payload), (reply) => resolve(decodeReply(reply)));
  });
}

const text = new TextEncoder();

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeDeps(): { deps: { storage: FileSystemDirectoryHandle; prefix: string }; root: FakeDirHandle } {
  const root = new FakeDirHandle('root');
  return {
    deps: { storage: root as unknown as FileSystemDirectoryHandle, prefix: 'test' },
    root,
  };
}

function attachPayload(fid: number): Uint8Array {
  return new FrameWriter().u32(fid).u32(0xffffffff).string('root').string('/').u32(0).build();
}

/** Build a Tsetattr payload in the 9P2000.L wire order. */
function setattrPayload(
  valid: number,
  size: bigint,
  atimeSec: bigint,
  atimeNsec: bigint,
  mtimeSec: bigint,
  mtimeNsec: bigint,
): Uint8Array {
  return new FrameWriter()
    .u32(1) // fid
    .u32(valid)
    .u32(0o100644) // mode
    .u32(0) // uid
    .u32(0) // gid
    .u64(size)
    .u64(atimeSec)
    .u64(atimeNsec)
    .u64(mtimeSec)
    .u64(mtimeNsec)
    .build();
}

async function writeOpfsFile(
  root: FakeDirHandle,
  prefix: string,
  name: string,
  data: Uint8Array,
): Promise<void> {
  const dir = await root.getDirectoryHandle(prefix, { create: true });
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(data);
  await writable.close();
}

async function readOpfsFile(
  root: FakeDirHandle,
  prefix: string,
  name: string,
): Promise<Uint8Array> {
  const dir = await root.getDirectoryHandle(prefix);
  const handle = await dir.getFileHandle(name);
  const file = await handle.getFile();
  return new Uint8Array(await file.arrayBuffer());
}

function manifestJson(rootQidPath: string): string {
  return JSON.stringify({
    version: 1,
    nextQidPath: '2',
    root: {
      name: '/',
      kind: 'dir',
      mode: 0o40755,
      uid: 0,
      gid: 0,
      nlink: 1,
      rdev: 0,
      size: 0,
      atime: 0,
      mtime: 0,
      ctime: 0,
      qidPath: rootQidPath,
      qidVersion: 0,
      children: [],
    },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('fs9p handler', () => {
  it('answers Tversion with 9P2000.L', async () => {
    const { deps } = makeDeps();
    const handle = create9pHandler(deps, { autoPersist: false });

    const reply = await request(
      handle,
      100,
      1,
      new FrameWriter().u32(8192).string('9P2000.L').build(),
    );
    expect(reply.type).toBe(101);
    expect(reply.tag).toBe(1);
    const r = new FrameReader(reply.payload);
    expect(r.u32()).toBe(8192);
    expect(r.string()).toBe('9P2000.L');
    await handle.flush();
  });

  it('attaches and walks to a file', async () => {
    const { deps } = makeDeps();
    const handle = create9pHandler(deps, { autoPersist: false });

    await request(handle, 100, 1, new FrameWriter().u32(8192).string('9P2000.L').build());
    const attach = await request(handle, 104, 2, attachPayload(1));
    expect(attach.type).toBe(105);
    const rootQid = new FrameReader(attach.payload).qid();
    expect(rootQid.type).toBe(0x40);
    expect(rootQid.path).toBe(0n);

    const walk = await request(
      handle,
      110,
      3,
      new FrameWriter().u32(1).u32(2).u16(1).string('nope').build(),
    );
    expect(walk.type).toBe(111);
    expect(new FrameReader(walk.payload).u16()).toBe(0);

    await handle.flush();
  });

  it('round-trips a file through create/write/read/clunk', async () => {
    const { deps } = makeDeps();
    const handle = create9pHandler(deps, { autoPersist: false });

    await request(handle, 100, 1, new FrameWriter().u32(8192).string('9P2000.L').build());
    await request(handle, 104, 2, attachPayload(1));
    await request(handle, 104, 3, attachPayload(2));

    const create = await request(
      handle,
      14,
      4,
      new FrameWriter().u32(1).string('hello.txt').u32(0x2).u32(0o100644).u32(0).build(),
    );
    expect(create.type).toBe(15);
    const createReply = new FrameReader(create.payload);
    expect(createReply.qid().type).toBe(0x80);
    expect(createReply.u32()).toBeGreaterThan(0);

    const data = text.encode('hello');
    const write = await request(
      handle,
      118,
      5,
      new FrameWriter().u32(1).u64(0).u32(data.byteLength).bytes(data).build(),
    );
    expect(write.type).toBe(119);
    expect(new FrameReader(write.payload).u32()).toBe(5);

    await request(handle, 120, 6, new FrameWriter().u32(1).build());

    const walk = await request(
      handle,
      110,
      7,
      new FrameWriter().u32(2).u32(3).u16(1).string('hello.txt').build(),
    );
    expect(walk.type).toBe(111);
    const walkReply = new FrameReader(walk.payload);
    expect(walkReply.u16()).toBe(1);
    expect(walkReply.qid().type).toBe(0x80);

    const open = await request(handle, 12, 8, new FrameWriter().u32(3).u32(0).build());
    expect(open.type).toBe(13);

    const read = await request(
      handle,
      116,
      9,
      new FrameWriter().u32(3).u64(0).u32(5).build(),
    );
    expect(read.type).toBe(117);
    const reader = new FrameReader(read.payload);
    expect(reader.u32()).toBe(5);
    expect(new TextDecoder().decode(reader.bytes(5))).toBe('hello');

    await request(handle, 120, 10, new FrameWriter().u32(3).build());
    const afterClunk = await request(handle, 124, 11, new FrameWriter().u32(3).build());
    expect(afterClunk.type).toBe(7);
    expect(new FrameReader(afterClunk.payload).u32()).toBe(9);

    await handle.flush();
  });

  it('reports Tstat and Tgetattr', async () => {
    const { deps } = makeDeps();
    const handle = create9pHandler(deps, { autoPersist: false });

    await request(handle, 100, 1, new FrameWriter().u32(8192).string('9P2000.L').build());
    await request(handle, 104, 2, attachPayload(1));
    const data = text.encode('hello');
    await request(
      handle,
      14,
      3,
      new FrameWriter().u32(1).string('hello.txt').u32(0x2).u32(0o100644).u32(0).build(),
    );
    await request(
      handle,
      118,
      4,
      new FrameWriter().u32(1).u64(0).u32(data.byteLength).bytes(data).build(),
    );

    const stat = await request(handle, 124, 5, new FrameWriter().u32(1).build());
    expect(stat.type).toBe(125);
    const s = new FrameReader(stat.payload);
    s.u16(); // size
    s.u16(); // type
    s.u32(); // dev
    expect(s.qid().type).toBe(0x80);
    expect(s.u32() & 0x80000000).toBe(0); // not a directory
    s.u32(); // atime
    s.u32(); // mtime
    expect(s.u64()).toBe(5n);
    expect(s.string()).toBe('hello.txt');
    s.string(); // uid
    s.string(); // gid
    s.string(); // muid
    s.string(); // extension
    s.u32(); // n_uid
    s.u32(); // n_gid
    s.u32(); // n_muid

    const getattr = await request(handle, 24, 6, new FrameWriter().u32(1).u64(0x3ff).build());
    expect(getattr.type).toBe(25);
    const g = new FrameReader(getattr.payload);
    expect(g.u64()).toBe(0x3ffn);
    expect(g.qid().type).toBe(0x80);
    expect(g.u32() & 0o170000).toBe(0o100000); // S_IFREG
    expect(g.u32()).toBe(0); // uid
    expect(g.u32()).toBe(0); // gid

    await handle.flush();
  });

  it('reads Tsetattr fields in the 9P2000.L wire order', async () => {
    const { deps } = makeDeps();
    const handle = create9pHandler(deps, { autoPersist: false });
    await request(handle, 100, 1, new FrameWriter().u32(8192).string('9P2000.L').build());
    await request(handle, 104, 2, attachPayload(1));
    await request(
      handle,
      14,
      3,
      new FrameWriter().u32(1).string('f.txt').u32(0x2).u32(0o100644).u32(0).build(),
    );
    const node = findNode(handle.tree, '/f.txt')!;
    expect(node).toBeDefined();

    // valid = MTIME | MTIME_SET: the mtime seconds are the fourth 8-byte field.
    const mtimeReply = await request(
      handle,
      26,
      4,
      setattrPayload(0x120, 0n, 111n, 222n, 333n, 444n),
    );
    expect(mtimeReply.type).toBe(27);
    expect(node.mtime).toBe(333);
    expect(node.atime).not.toBe(111);

    // valid = ATIME | ATIME_SET: the atime seconds are the second 8-byte field.
    const atimeReply = await request(
      handle,
      26,
      5,
      setattrPayload(0x90, 0n, 555n, 666n, 777n, 888n),
    );
    expect(atimeReply.type).toBe(27);
    expect(node.atime).toBe(555);
    expect(node.mtime).toBe(333);

    // valid = MTIME without MTIME_SET means "now" and must not touch atime.
    const before = Math.floor(Date.now() / 1000);
    await request(handle, 26, 6, setattrPayload(0x20, 0n, 111n, 0n, 0n, 0n));
    expect(node.mtime).toBeGreaterThanOrEqual(before);
    expect(node.atime).toBe(555);

    await handle.flush();
  });

  it('lists directory entries with Treaddir', async () => {
    const { deps } = makeDeps();
    const handle = create9pHandler(deps, { autoPersist: false });

    await request(handle, 100, 1, new FrameWriter().u32(8192).string('9P2000.L').build());
    await request(handle, 104, 2, attachPayload(1));
    await request(
      handle,
      14,
      3,
      new FrameWriter().u32(1).string('a.txt').u32(0x2).u32(0o100644).u32(0).build(),
    );
    await request(handle, 120, 4, new FrameWriter().u32(1).build());
    await request(handle, 104, 5, attachPayload(2));
    await request(
      handle,
      14,
      6,
      new FrameWriter().u32(2).string('b.txt').u32(0x2).u32(0o100644).u32(0).build(),
    );
    await request(handle, 120, 7, new FrameWriter().u32(2).build());

    await request(handle, 104, 8, attachPayload(9));
    await request(handle, 12, 9, new FrameWriter().u32(9).u32(0).build());
    const readdir = await request(
      handle,
      40,
      10,
      new FrameWriter().u32(9).u64(0).u32(1024).build(),
    );
    expect(readdir.type).toBe(41);
    const r = new FrameReader(readdir.payload);
    expect(r.u32()).toBeGreaterThan(0);
    const names: string[] = [];
    // Parse two dirents: qid, offset, type, name.
    for (let i = 0; i < 2; i++) {
      r.qid();
      r.u64();
      r.u8();
      names.push(r.string());
    }
    expect(names.sort()).toEqual(['a.txt', 'b.txt']);

    await handle.flush();
  });

  it('removes files with Tunlinkat', async () => {
    const { deps } = makeDeps();
    const handle = create9pHandler(deps, { autoPersist: false });

    await request(handle, 100, 1, new FrameWriter().u32(8192).string('9P2000.L').build());
    await request(handle, 104, 2, attachPayload(1));
    await request(handle, 104, 3, attachPayload(2));
    // Tlcreate turns fid 1 into the new file; fid 2 stays on the root directory.
    await request(
      handle,
      14,
      4,
      new FrameWriter().u32(1).string('gone.txt').u32(0x2).u32(0o100644).u32(0).build(),
    );

    const unlink = await request(
      handle,
      76,
      5,
      new FrameWriter().u32(2).string('gone.txt').u32(0).build(),
    );
    expect(unlink.type).toBe(77);

    const again = await request(
      handle,
      76,
      6,
      new FrameWriter().u32(2).string('gone.txt').u32(0).build(),
    );
    expect(again.type).toBe(7);
    expect(new FrameReader(again.payload).u32()).toBe(2); // ENOENT

    await handle.flush();
  });

  it('rejects unsupported messages with EOPNOTSUPP', async () => {
    const { deps } = makeDeps();
    const handle = create9pHandler(deps, { autoPersist: false });
    await request(handle, 100, 1, new FrameWriter().u32(8192).string('9P2000.L').build());

    const reply = await request(handle, 102, 2, new FrameWriter().u32(1).u32(0).string('x').build());
    expect(reply.type).toBe(7);
    expect(new FrameReader(reply.payload).u32()).toBe(95);

    await handle.flush();
  });

  it('persists the tree and loads it into a fresh handler', async () => {
    const { deps } = makeDeps();
    const handle = create9pHandler(deps, { autoPersist: false });
    await request(handle, 100, 1, new FrameWriter().u32(8192).string('9P2000.L').build());
    await request(handle, 104, 2, attachPayload(1));
    const data = text.encode('persisted');
    await request(
      handle,
      14,
      3,
      new FrameWriter().u32(1).string('note.txt').u32(0x2).u32(0o100644).u32(0).build(),
    );
    await request(
      handle,
      118,
      4,
      new FrameWriter().u32(1).u64(0).u32(data.byteLength).bytes(data).build(),
    );
    await handle.persist();

    const reloaded = await loadTree(deps, 'test');
    expect(reloaded).toBeDefined();
    const node = findNode(reloaded!, '/note.txt');
    expect(node?.kind).toBe('file');
    expect(new TextDecoder().decode(node?.data)).toBe('persisted');

    const handle2 = create9pHandler(deps, { autoPersist: false });
    await handle2.ready();
    await request(handle2, 100, 1, new FrameWriter().u32(8192).string('9P2000.L').build());
    await request(handle2, 104, 2, attachPayload(1));
    await request(
      handle2,
      110,
      3,
      new FrameWriter().u32(1).u32(2).u16(1).string('note.txt').build(),
    );
    await request(handle2, 12, 4, new FrameWriter().u32(2).u32(0).build());
    const read = await request(
      handle2,
      116,
      5,
      new FrameWriter().u32(2).u64(0).u32(data.byteLength).build(),
    );
    const reader = new FrameReader(read.payload);
    expect(reader.u32()).toBe(data.byteLength);
    expect(new TextDecoder().decode(reader.bytes(data.byteLength))).toBe('persisted');
    await handle2.flush();
  });

  it('reaches the v86 filesystem option with the expected call signature', async () => {
    const { deps } = makeDeps();
    const filesystem = createV86Filesystem(deps, { autoPersist: false });

    // The exact option shape v86 consumes.
    const options: V86Options = { filesystem };
    const handle9p = options.filesystem?.handle9p;
    expect(handle9p).toBeTypeOf('function');

    // v86 calls it as handle9p(reqbuf, reply) with a complete 9P frame.
    const reply = await new Promise<Reply>((resolve) => {
      handle9p!(
        encodeFrame(100, 1, new FrameWriter().u32(8192).string('9P2000.L').build()),
        (buf) => resolve(decodeReply(buf)),
      );
    });
    expect(reply.type).toBe(101);
    expect(reply.tag).toBe(1);

    // The host-side controls remain reachable on the same function object.
    const host = filesystem.handle9p as Fs9pHandle;
    expect(typeof host.flush).toBe('function');
  });

  it('returns undefined from loadTree when nothing is stored', async () => {
    const { deps } = makeDeps();
    expect(await loadTree(deps, 'missing')).toBeUndefined();
  });

  it('fails closed on a corrupt manifest and leaves it untouched', async () => {
    const { deps, root } = makeDeps();
    const corrupt = text.encode('{ this is not json');
    await writeOpfsFile(root, 'test', 'manifest.json', corrupt);

    await expect(loadTree(deps, 'test')).rejects.toBeInstanceOf(ManifestError);

    const handle = create9pHandler(deps, { autoPersist: false });
    await expect(handle.ready()).rejects.toBeInstanceOf(ManifestError);
    // An explicit persist must not replace the corrupt manifest with an empty tree.
    await handle.persist();

    expect(Array.from(await readOpfsFile(root, 'test', 'manifest.json'))).toEqual(
      Array.from(corrupt),
    );
  });

  it('fails closed on a manifest with a non-integer qidPath', async () => {
    const { deps, root } = makeDeps();
    const raw = text.encode(manifestJson('not-a-number'));
    await writeOpfsFile(root, 'test', 'manifest.json', raw);

    await expect(loadTree(deps, 'test')).rejects.toBeInstanceOf(ManifestError);

    const handle = create9pHandler(deps, { autoPersist: false });
    await expect(handle.ready()).rejects.toBeInstanceOf(ManifestError);
    await handle.persist();

    expect(Array.from(await readOpfsFile(root, 'test', 'manifest.json'))).toEqual(
      Array.from(raw),
    );
  });

  it('propagates a non-NotFound manifest read error instead of resetting the tree', async () => {
    const { deps, root } = makeDeps();
    const original = text.encode(manifestJson('1'));
    await writeOpfsFile(root, 'test', 'manifest.json', original);

    const dir = await root.getDirectoryHandle('test');
    const manifestHandle = await dir.getFileHandle('manifest.json');
    (manifestHandle as FakeFileHandle).readError = Object.assign(
      new Error('transient I/O failure'),
      { name: 'SecurityError' },
    );

    await expect(loadTree(deps, 'test')).rejects.toMatchObject({ name: 'SecurityError' });

    const handle = create9pHandler(deps, { autoPersist: false });
    await expect(handle.ready()).rejects.toMatchObject({ name: 'SecurityError' });
    // The failed read must not be mistaken for "nothing stored": a persist
    // attempt must leave the real manifest in place.
    await handle.persist().catch(() => {});

    // Read the fake's stored bytes directly so the injected read error does
    // not interfere with the assertion.
    expect(Array.from((manifestHandle as FakeFileHandle).data)).toEqual(
      Array.from(original),
    );
  });

  it('propagates a non-NotFound directory lookup error', async () => {
    const { deps } = makeDeps();
    const root = deps.storage as unknown as FakeDirHandle;
    // Force getDirectoryHandle to fail for the prefix without a NotFound signal.
    root.getDirectoryHandle = async () => {
      throw Object.assign(new Error('storage unreachable'), { name: 'UnknownError' });
    };

    await expect(loadTree(deps, 'test')).rejects.toMatchObject({ name: 'UnknownError' });
  });
});

describe('copy-on-write helpers', () => {
  function makeTree(): P9Node {
    const root = createEmptyTree();
    const file = createEmptyTree('/a.txt') as P9Node;
    file.kind = 'file';
    file.mode = 0o100644;
    file.data = text.encode('original');
    file.size = 8;
    root.children.set('a.txt', file);
    return root;
  }

  it('cowWrite leaves the original untouched', () => {
    const root = makeTree();
    const original = root.children.get('a.txt')!;
    const updated = cowWrite(original, 0, text.encode('CHANGED'));
    expect(new TextDecoder().decode(original.data)).toBe('original');
    // pwrite semantics: a short write overwrites in place and keeps the tail.
    expect(new TextDecoder().decode(updated.data)).toBe('CHANGEDl');
    expect(updated.size).toBe(8);
    expect(updated.qidVersion).toBe(original.qidVersion + 1);
  });

  it('cowWrite extends the file when writing past the end', () => {
    const root = makeTree();
    const original = root.children.get('a.txt')!;
    const updated = cowWrite(original, 8, text.encode('!'));
    expect(new TextDecoder().decode(updated.data)).toBe('original!');
    expect(updated.size).toBe(9);
  });

  it('cowSetChild and cowRemoveChild leave the original untouched', () => {
    const root = makeTree();
    const child = createEmptyTree('/b.txt') as P9Node;
    child.kind = 'file';
    child.mode = 0o100644;

    const withChild = cowSetChild(root, 'b.txt', child);
    expect(root.children.has('b.txt')).toBe(false);
    expect(withChild.children.has('b.txt')).toBe(true);

    const without = cowRemoveChild(withChild, 'b.txt');
    expect(withChild.children.has('b.txt')).toBe(true);
    expect(without.children.has('b.txt')).toBe(false);
  });

  it('cloneTree deep-copies data and children', () => {
    const root = makeTree();
    const copy = cloneTree(root);
    expect(copy).not.toBe(root);
    expect(copy.children.get('a.txt')).not.toBe(root.children.get('a.txt'));
    copy.children.get('a.txt')!.data.set(text.encode('mutated'), 0);
    expect(new TextDecoder().decode(root.children.get('a.txt')!.data)).toBe('original');
  });

  it('cloneNode preserves inode identity', () => {
    const root = makeTree();
    const node = root.children.get('a.txt')!;
    const copy = cloneNode(node, '/copy.txt');
    expect(copy.path).toBe('/copy.txt');
    expect(copy.qidPath).toBe(node.qidPath);
    expect(copy.qidVersion).toBe(node.qidVersion);
  });
});
