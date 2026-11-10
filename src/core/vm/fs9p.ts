/**
 * 9P2000.L filesystem server for v86, backed by OPFS.
 *
 * v86 calls `filesystem.handle9p(reqbuf, reply)` for every 9p request. The
 * request buffer contains the full 9P frame (4-byte size, 1-byte type,
 * 2-byte tag, payload); the reply must be a complete frame with the same tag.
 *
 * Implemented messages (9P2000.L unless noted):
 *  - Tversion/Rversion (100/101)
 *  - Tattach/Rattach (104/105)
 *  - Twalk/Rwalk (110/111)
 *  - Tlopen/Rlopen (12/13) and Topen/Ropen (112/113)
 *  - Tread/Rread (116/117), including directory reads
 *  - Treaddir/Rreaddir (40/41)
 *  - Twrite/Rwrite (118/119)
 *  - Tclunk/Rclunk (120/121)
 *  - Tremove/Rremove (122/123)
 *  - Tstat/Rstat (124/125, 9P2000.u layout)
 *  - Tgetattr/Rgetattr (24/25)
 *  - Tsetattr/Rsetattr (26/27)
 *  - Tstatfs/Rstatfs (8/9)
 *  - Tlcreate/Rlcreate (14/15)
 *  - Tmkdir/Rmkdir (72/73)
 *  - Tsymlink/Rsymlink (16/17)
 *  - Treadlink/Rreadlink (22/23)
 *  - Tmknod/Rmknod (18/19)
 *  - Trenameat/Rrenameat (74/75)
 *  - Tunlinkat/Runlinkat (76/77)
 *  - Tfsync/Rfsync (50/51)
 *  - Tflush/Rflush (108/109)
 *
 * Everything else throws {@link NotImplementedError}, which the handler
 * converts into an Rlerror with EOPNOTSUPP (95): Tauth, Tcreate, Twstat,
 * Txattrwalk, Txattrcreate, Tlink, Tlock, Tgetlock.
 *
 * Persistence: the tree is written to OPFS as `manifest.json` plus one
 * `<qidPath>.bin` blob per file. When OPFS is unavailable the tree stays in
 * memory and every load/persist is skipped with a log message.
 *
 * A manifest that exists but cannot be parsed, or whose nodes are not valid,
 * is a corruption signal: {@link loadTree} throws {@link ManifestError} and
 * the handler refuses to persist, so a corrupt manifest is never overwritten
 * with an empty tree. A missing manifest is not an error (fresh storage).
 */

// ---------------------------------------------------------------------------
// Domain model
// ---------------------------------------------------------------------------

export type P9Kind = 'file' | 'dir' | 'symlink';

export interface P9Node {
  /** Absolute path from the tree root. */
  path: string;
  kind: P9Kind;
  /** File contents. Empty for directories and symlinks. */
  data: Uint8Array;
  children: Map<string, P9Node>;
  /** Unix mode: S_IFMT bits plus permission bits. */
  mode: number;
  uid: number;
  gid: number;
  nlink: number;
  rdev: number;
  size: number;
  atime: number;
  mtime: number;
  ctime: number;
  qidPath: bigint;
  qidVersion: number;
  /** Symlink target. */
  symlink?: string;
  /** v86 convention: 4 marks an unlinked inode. */
  status?: number;
}

export interface Fs9pDeps {
  /** OPFS root directory. Defaults to `navigator.storage.getDirectory()`. */
  storage?: FileSystemDirectoryHandle;
  /** Directory under the OPFS root that holds the tree. */
  prefix?: string;
  /** Called with (written, total) as file blobs are persisted. */
  onProgress?: (written: number, total: number) => void;
  /** Called with diagnostic messages. */
  onLog?: (message: string) => void;
}

export interface Fs9pOptions {
  /** Debounce for automatic persistence after a mutation. Default 250 ms. */
  persistDebounceMs?: number;
  /** Set false to disable automatic persistence. Default true. */
  autoPersist?: boolean;
  /** Use this tree instead of an empty one when nothing is persisted yet. */
  initialTree?: P9Node;
}

export interface Fs9pHandle {
  (reqbuf: Uint8Array, reply: (replybuf: Uint8Array) => void): void;
  /** Current in-memory tree (replaced after a successful load). */
  readonly tree: P9Node;
  /** Resolve once the persisted tree has been loaded. */
  ready(): Promise<void>;
  /** Flush any pending automatic persistence and persist immediately. */
  flush(): Promise<void>;
  /** Persist the current tree now. */
  persist(): Promise<void>;
}

export interface Qid {
  type: number;
  version: number;
  path: bigint;
}

export interface P9Request {
  size: number;
  type: number;
  tag: number;
  payload: Uint8Array;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const P9_VERSION = '9P2000.L';
export const DEFAULT_FS_PREFIX = 'fs9p';

const MAX_MSIZE = 1 << 20;

// Message types
const T_STATFS = 8;
const T_LOPEN = 12;
const T_LCREATE = 14;
const T_SYMLINK = 16;
const T_MKNOD = 18;
const T_READLINK = 22;
const T_GETATTR = 24;
const T_SETATTR = 26;
const T_XATTRWALK = 30;
const T_XATTRCREATE = 32;
const T_READDIR = 40;
const T_FSYNC = 50;
const T_LOCK = 52;
const T_GETLOCK = 54;
const T_LINK = 70;
const T_MKDIR = 72;
const T_RENAMEAT = 74;
const T_UNLINKAT = 76;
const T_VERSION = 100;
const T_AUTH = 102;
const T_ATTACH = 104;
const T_FLUSH = 108;
const T_WALK = 110;
const T_OPEN = 112;
const T_CREATE = 114;
const T_READ = 116;
const T_WRITE = 118;
const T_CLUNK = 120;
const T_REMOVE = 122;
const T_STAT = 124;
const T_WSTAT = 126;

const R_LERROR = 7;

// errno values used by the server
const EPERM = 1;
const ENOENT = 2;
const EIO = 5;
const EBADF = 9;
const EEXIST = 17;
const ENOTDIR = 20;
const EISDIR = 21;
const EINVAL = 22;
const ENOTEMPTY = 39;
const EOPNOTSUPP = 95;

// Unix file type bits
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

// Plan 9 mode bits (used by Rstat)
const P9_DMDIR = 0x80000000;
const P9_DMSYMLINK = 0x02000000;
const P9_DMSETUID = 0x00800000;
const P9_DMSETGID = 0x00400000;
const P9_DMSETVTX = 0x00200000;

// Tunlinkat flags
const AT_REMOVEDIR = 0x200;

// Tsetattr valid bits
const SETATTR_MODE = 0x1;
const SETATTR_UID = 0x2;
const SETATTR_GID = 0x4;
const SETATTR_SIZE = 0x8;
const SETATTR_ATIME = 0x10;
const SETATTR_MTIME = 0x20;
const SETATTR_CTIME = 0x40;
const SETATTR_ATIME_SET = 0x80;
const SETATTR_MTIME_SET = 0x100;

const P9_STATFS_MAGIC = 0x01021997;
const BLOCK_SIZE = 4096;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown for messages the server does not implement; maps to EOPNOTSUPP. */
export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotImplementedError';
  }
}

/** An error that maps directly onto a 9p Rlerror errno. */
export class P9Error extends Error {
  constructor(public readonly errno: number) {
    super(`9p error ${errno}`);
    this.name = 'P9Error';
  }
}

/** Thrown when a persisted manifest exists but cannot be trusted. */
export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestError';
  }
}

function toErrno(err: unknown): number {
  if (err instanceof P9Error) return err.errno;
  if (err instanceof NotImplementedError) return EOPNOTSUPP;
  return EIO;
}

// ---------------------------------------------------------------------------
// Wire codec
// ---------------------------------------------------------------------------

/** Parse a complete 9P frame (size header included). */
export function parseFrame(buf: Uint8Array): P9Request {
  if (buf.byteLength < 7) throw new P9Error(EINVAL);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const size = view.getUint32(0, true);
  if (size < 7 || size > buf.byteLength) throw new P9Error(EINVAL);
  return {
    size,
    type: view.getUint8(4),
    tag: view.getUint16(5, true),
    payload: buf.subarray(7, size),
  };
}

class Reader {
  private readonly view: DataView;
  offset = 0;

  constructor(private readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  get remaining(): number {
    return this.buf.byteLength - this.offset;
  }

  u8(): number {
    if (this.offset + 1 > this.buf.byteLength) throw new P9Error(EINVAL);
    return this.buf[this.offset++]!;
  }

  u16(): number {
    if (this.offset + 2 > this.buf.byteLength) throw new P9Error(EINVAL);
    const v = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return v;
  }

  u32(): number {
    if (this.offset + 4 > this.buf.byteLength) throw new P9Error(EINVAL);
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }

  u64(): bigint {
    if (this.offset + 8 > this.buf.byteLength) throw new P9Error(EINVAL);
    const v = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    return v;
  }

  string(): string {
    const len = this.u16();
    return textDecoder.decode(this.bytes(len));
  }

  bytes(n: number): Uint8Array {
    const count = Math.max(0, Math.min(n, this.remaining));
    const out = this.buf.subarray(this.offset, this.offset + count);
    this.offset += count;
    return out;
  }

  qid(): Qid {
    return { type: this.u8(), version: this.u32(), path: this.u64() };
  }
}

class Writer {
  private buf: Uint8Array;
  private view: DataView;
  offset = 0;

  constructor(initial = 1024) {
    this.buf = new Uint8Array(initial);
    this.view = new DataView(this.buf.buffer);
  }

  private ensure(n: number): void {
    if (this.offset + n <= this.buf.byteLength) return;
    let capacity = this.buf.byteLength || 1024;
    while (capacity < this.offset + n) capacity *= 2;
    const next = new Uint8Array(capacity);
    next.set(this.buf.subarray(0, this.offset));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v: number): void {
    this.ensure(1);
    this.buf[this.offset++] = v & 0xff;
  }

  u16(v: number): void {
    this.ensure(2);
    this.view.setUint16(this.offset, v & 0xffff, true);
    this.offset += 2;
  }

  u32(v: number): void {
    this.ensure(4);
    this.view.setUint32(this.offset, v >>> 0, true);
    this.offset += 4;
  }

  u64(v: bigint | number): void {
    this.ensure(8);
    this.view.setBigUint64(this.offset, BigInt(v), true);
    this.offset += 8;
  }

  string(s: string): void {
    const bytes = textEncoder.encode(s);
    this.u16(bytes.byteLength);
    this.bytes(bytes);
  }

  bytes(b: Uint8Array): void {
    this.ensure(b.byteLength);
    this.buf.set(b, this.offset);
    this.offset += b.byteLength;
  }

  qid(q: Qid): void {
    this.u8(q.type);
    this.u32(q.version);
    this.u64(q.path);
  }

  /** Payload written so far (no frame header). */
  payload(): Uint8Array {
    return this.buf.slice(0, this.offset);
  }

  /** Complete frame: size header + type + tag + payload. */
  finish(type: number, tag: number): Uint8Array {
    const out = new Uint8Array(this.offset + 7);
    const view = new DataView(out.buffer);
    view.setUint32(0, out.byteLength, true);
    view.setUint8(4, type);
    view.setUint16(5, tag, true);
    out.set(this.buf.subarray(0, this.offset), 7);
    return out;
  }
}

function buildReply(type: number, tag: number, payload: Uint8Array): Uint8Array {
  const w = new Writer(payload.byteLength + 7);
  w.bytes(payload);
  return w.finish(type, tag);
}

function buildErrorFrame(tag: number, errno: number): Uint8Array {
  const w = new Writer();
  w.u32(errno);
  return w.finish(R_LERROR, tag);
}

// ---------------------------------------------------------------------------
// Tree helpers
// ---------------------------------------------------------------------------

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function createEmptyTree(rootPath = '/'): P9Node {
  const now = nowSeconds();
  return {
    path: rootPath,
    kind: 'dir',
    data: new Uint8Array(),
    children: new Map(),
    mode: S_IFDIR | 0o755,
    uid: 0,
    gid: 0,
    nlink: 1,
    rdev: 0,
    size: 0,
    atime: now,
    mtime: now,
    ctime: now,
    qidPath: 0n,
    qidVersion: 0,
  };
}

export function nodeName(node: P9Node): string {
  if (node.path === '/' || node.path === '') return '/';
  const index = node.path.lastIndexOf('/');
  return index < 0 ? node.path : node.path.slice(index + 1);
}

export function joinPath(parent: string, name: string): string {
  if (parent === '/' || parent === '') return `/${name}`;
  return `${parent}/${name}`;
}

/** Qid type byte, matching v86: `(mode & S_IFMT) >> 8`. */
export function qidType(node: P9Node): number {
  return (node.mode & S_IFMT) >> 8;
}

export function nodeQid(node: P9Node): Qid {
  return { type: qidType(node), version: node.qidVersion, path: node.qidPath };
}

/** Convert a Unix mode to the Plan 9 mode field used by Rstat. */
export function toP9Mode(node: P9Node): number {
  let mode = node.mode & 0o777;
  if (node.kind === 'dir') mode |= P9_DMDIR;
  else if (node.kind === 'symlink') mode |= P9_DMSYMLINK;
  if (node.mode & 0o4000) mode |= P9_DMSETUID;
  if (node.mode & 0o2000) mode |= P9_DMSETGID;
  if (node.mode & 0o1000) mode |= P9_DMSETVTX;
  return mode >>> 0;
}

/** Depth-first iteration over a node and all descendants. */
export function* walk(node: P9Node): Generator<P9Node> {
  yield node;
  for (const child of node.children.values()) yield* walk(child);
}

export function findNode(root: P9Node, path: string): P9Node | undefined {
  if (path === '/' || path === '') return root;
  let node = root;
  for (const part of path.split('/').filter(Boolean)) {
    if (node.kind !== 'dir') return undefined;
    const child = node.children.get(part);
    if (!child) return undefined;
    node = child;
  }
  return node;
}

function findParent(root: P9Node, path: string): P9Node | undefined {
  const index = path.lastIndexOf('/');
  if (index <= 0) return root;
  return findNode(root, path.slice(0, index));
}

function retargetPaths(node: P9Node, newPath: string): void {
  node.path = newPath;
  for (const [name, child] of node.children) {
    retargetPaths(child, joinPath(newPath, name));
  }
}

/** Deep copy of a node, preserving inode identity (qidPath/qidVersion). */
export function cloneNode(node: P9Node, newPath?: string): P9Node {
  const copy: P9Node = {
    path: newPath ?? node.path,
    kind: node.kind,
    data: node.data.slice(),
    children: new Map(),
    mode: node.mode,
    uid: node.uid,
    gid: node.gid,
    nlink: node.nlink,
    rdev: node.rdev,
    size: node.size,
    atime: node.atime,
    mtime: node.mtime,
    ctime: node.ctime,
    qidPath: node.qidPath,
    qidVersion: node.qidVersion,
  };
  if (node.symlink !== undefined) copy.symlink = node.symlink;
  if (node.status !== undefined) copy.status = node.status;
  for (const [name, child] of node.children) {
    copy.children.set(name, cloneNode(child, joinPath(copy.path, name)));
  }
  return copy;
}

export function cloneTree(root: P9Node): P9Node {
  return cloneNode(root, root.path);
}

/** Copy-on-write write: returns a new node, leaving the original untouched. */
export function cowWrite(node: P9Node, offset: number, data: Uint8Array): P9Node {
  const copy = cloneNode(node);
  const end = offset + data.byteLength;
  if (end > copy.data.byteLength) {
    const next = new Uint8Array(end);
    next.set(copy.data);
    copy.data = next;
  }
  copy.data.set(data, offset);
  copy.size = copy.data.byteLength;
  copy.mtime = nowSeconds();
  copy.ctime = copy.mtime;
  copy.qidVersion++;
  return copy;
}

/** Copy-on-write child insertion: returns a new parent. */
export function cowSetChild(parent: P9Node, name: string, child: P9Node): P9Node {
  const copy = cloneNode(parent);
  copy.children.set(name, cloneNode(child, joinPath(copy.path, name)));
  copy.mtime = nowSeconds();
  copy.ctime = copy.mtime;
  copy.qidVersion++;
  return copy;
}

/** Copy-on-write child removal: returns a new parent. */
export function cowRemoveChild(parent: P9Node, name: string): P9Node {
  const copy = cloneNode(parent);
  copy.children.delete(name);
  copy.mtime = nowSeconds();
  copy.ctime = copy.mtime;
  copy.qidVersion++;
  return copy;
}

// ---------------------------------------------------------------------------
// OPFS persistence
// ---------------------------------------------------------------------------

interface ManifestNode {
  name: string;
  kind: P9Kind;
  mode: number;
  uid: number;
  gid: number;
  nlink: number;
  rdev: number;
  size: number;
  atime: number;
  mtime: number;
  ctime: number;
  qidPath: string;
  qidVersion: number;
  symlink?: string;
  children?: ManifestNode[];
}

interface Manifest {
  version: 1;
  nextQidPath: string;
  root: ManifestNode;
}

async function opfsRoot(deps: Fs9pDeps): Promise<FileSystemDirectoryHandle> {
  if (deps.storage) return deps.storage;
  const navigator = (globalThis as { navigator?: Navigator }).navigator;
  if (!navigator?.storage || typeof navigator.storage.getDirectory !== 'function') {
    throw new Error('OPFS is not available');
  }
  return navigator.storage.getDirectory();
}

async function ensureDir(
  root: FileSystemDirectoryHandle,
  prefix: string,
  create: boolean,
): Promise<FileSystemDirectoryHandle> {
  let dir = root;
  for (const part of prefix.split('/').filter(Boolean)) {
    dir = await dir.getDirectoryHandle(part, { create });
  }
  return dir;
}

async function readOpfsFile(
  dir: FileSystemDirectoryHandle,
  name: string,
): Promise<Uint8Array | undefined> {
  try {
    const handle = await dir.getFileHandle(name);
    const file = await handle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  } catch {
    return undefined;
  }
}

async function writeOpfsFile(
  dir: FileSystemDirectoryHandle,
  name: string,
  data: Uint8Array,
): Promise<void> {
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  // Copy: DOM write() rejects views over SharedArrayBuffer.
  await writable.write(data.slice());
  await writable.close();
}

function toManifestNode(node: P9Node): ManifestNode {
  const entry: ManifestNode = {
    name: nodeName(node),
    kind: node.kind,
    mode: node.mode,
    uid: node.uid,
    gid: node.gid,
    nlink: node.nlink,
    rdev: node.rdev,
    size: node.size,
    atime: node.atime,
    mtime: node.mtime,
    ctime: node.ctime,
    qidPath: node.qidPath.toString(),
    qidVersion: node.qidVersion,
  };
  if (node.symlink !== undefined) entry.symlink = node.symlink;
  if (node.kind === 'dir') {
    entry.children = [...node.children.values()].map(toManifestNode);
  }
  return entry;
}

function blobName(node: P9Node): string {
  return `${node.qidPath.toString()}.bin`;
}

function countFiles(node: P9Node): number {
  let count = node.kind === 'file' ? 1 : 0;
  for (const child of node.children.values()) count += countFiles(child);
  return count;
}

async function readManifest(
  dir: FileSystemDirectoryHandle,
): Promise<Manifest | undefined> {
  const bytes = await readOpfsFile(dir, 'manifest.json');
  if (!bytes) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(textDecoder.decode(bytes));
  } catch (err) {
    throw new ManifestError(`manifest.json is not valid JSON (${String(err)})`);
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    (parsed as Manifest).version !== 1 ||
    !(parsed as Manifest).root
  ) {
    throw new ManifestError('manifest.json has an unrecognized schema');
  }
  return parsed as Manifest;
}

/**
 * Persist the tree to OPFS: `manifest.json` plus one blob per file.
 * Blobs whose bytes are unchanged are left alone.
 */
export async function persistTree(
  root: P9Node,
  deps: Fs9pDeps,
  prefix = DEFAULT_FS_PREFIX,
  nextQidPath = 0n,
): Promise<void> {
  const storage = await opfsRoot(deps);
  const dir = await ensureDir(storage, prefix, true);

  let maxQid = 0n;
  for (const node of walk(root)) {
    if (node.qidPath > maxQid) maxQid = node.qidPath;
  }
  const manifest: Manifest = {
    version: 1,
    nextQidPath: (nextQidPath > maxQid + 1n ? nextQidPath : maxQid + 1n).toString(),
    root: toManifestNode(root),
  };

  const total = countFiles(root);
  let written = 0;
  for (const node of walk(root)) {
    if (node.kind !== 'file') continue;
    const name = blobName(node);
    const existing = await readOpfsFile(dir, name);
    const unchanged =
      existing &&
      existing.byteLength === node.data.byteLength &&
      existing.every((byte, i) => byte === node.data[i]);
    if (!unchanged) await writeOpfsFile(dir, name, node.data);
    written++;
    deps.onProgress?.(written, total);
  }

  await writeOpfsFile(dir, 'manifest.json', textEncoder.encode(JSON.stringify(manifest)));
  deps.onLog?.(`fs9p: persisted ${written}/${total} file(s)`);
}

/**
 * Load a persisted tree from OPFS. Returns undefined when nothing is stored
 * or OPFS is unavailable.
 */
export async function loadTree(
  deps: Fs9pDeps,
  prefix = DEFAULT_FS_PREFIX,
): Promise<P9Node | undefined> {
  let storage: FileSystemDirectoryHandle;
  try {
    storage = await opfsRoot(deps);
  } catch {
    return undefined;
  }
  let dir: FileSystemDirectoryHandle;
  try {
    dir = await ensureDir(storage, prefix, false);
  } catch {
    return undefined;
  }
  const manifest = await readManifest(dir);
  if (!manifest) return undefined;
  return rebuildNode(manifest.root, '/', dir);
}

/** Parse and validate a manifest node's `qidPath` (serialized as a string). */
function parseQidPath(entry: ManifestNode, path: string): bigint {
  const raw = entry.qidPath;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw new ManifestError(`manifest node ${path} has an invalid qidPath`);
  }
  return BigInt(raw);
}

async function rebuildNode(
  entry: ManifestNode,
  parentPath: string,
  dir: FileSystemDirectoryHandle,
): Promise<P9Node> {
  const path = parentPath === '/' && entry.name === '/' ? '/' : joinPath(parentPath, entry.name);
  if (entry.kind !== 'file' && entry.kind !== 'dir' && entry.kind !== 'symlink') {
    throw new ManifestError(`manifest node ${path} has an invalid kind`);
  }
  const node: P9Node = {
    path,
    kind: entry.kind,
    data: new Uint8Array(),
    children: new Map(),
    mode: entry.mode,
    uid: entry.uid,
    gid: entry.gid,
    nlink: entry.nlink,
    rdev: entry.rdev,
    size: entry.size,
    atime: entry.atime,
    mtime: entry.mtime,
    ctime: entry.ctime,
    qidPath: parseQidPath(entry, path),
    qidVersion: entry.qidVersion,
  };
  if (entry.symlink !== undefined) node.symlink = entry.symlink;
  if (entry.kind === 'file') {
    const blob = await readOpfsFile(dir, `${node.qidPath.toString()}.bin`);
    if (blob) node.data = blob;
  } else if (entry.kind === 'dir') {
    for (const child of entry.children ?? []) {
      node.children.set(child.name, await rebuildNode(child, path, dir));
    }
  }
  return node;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

interface Fid {
  node: P9Node;
  uid: number;
  opened: boolean;
  mode: number;
}

/**
 * Create the `handle9p` function for v86.
 *
 * The returned function is callable exactly like the v86 option and also
 * exposes `tree`, `ready()`, `flush()` and `persist()` for host-side use.
 */
export function create9pHandler(deps: Fs9pDeps, options: Fs9pOptions = {}): Fs9pHandle {
  const prefix = deps.prefix ?? DEFAULT_FS_PREFIX;
  const autoPersist = options.autoPersist ?? true;

  let root: P9Node = options.initialTree ?? createEmptyTree();
  let loaded = false;
  let loadPromise: Promise<void> | null = null;
  let dirty = false;
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  let persisting: Promise<void> | null = null;
  let nextQidPath = 1n;
  let msize = 8192;

  const fids = new Map<number, Fid>();

  function ensureLoaded(): Promise<void> {
    if (loaded) return Promise.resolve();
    if (!loadPromise) {
      loadPromise = (async () => {
        // loadTree returns undefined when nothing is stored or OPFS is absent.
        // It throws ManifestError when a stored manifest is corrupt; that must
        // propagate. Falling back to an empty tree here would let the next
        // persist overwrite the user's snapshot.
        const persisted = await loadTree(deps, prefix);
        if (persisted) {
          root = persisted;
          let max = 0n;
          for (const node of walk(root)) if (node.qidPath > max) max = node.qidPath;
          nextQidPath = max + 1n;
        }
        loaded = true;
      })();
    }
    return loadPromise;
  }

  function markDirty(): void {
    dirty = true;
    if (!autoPersist) return;
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      void persist();
    }, options.persistDebounceMs ?? 250);
  }

  async function persist(): Promise<void> {
    if (persisting) return persisting;
    persisting = (async () => {
      try {
        // Never write the in-memory tree over a manifest that failed to load.
        await ensureLoaded();
        await persistTree(root, deps, prefix, nextQidPath);
        dirty = false;
      } catch (err) {
        deps.onLog?.(`fs9p: persist failed (${String(err)})`);
        dirty = true;
      } finally {
        persisting = null;
      }
    })();
    return persisting;
  }

  async function flush(): Promise<void> {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    await ensureLoaded();
    if (dirty) await persist();
  }

  function requireFid(fid: number): Fid {
    const entry = fids.get(fid);
    if (!entry) throw new P9Error(EBADF);
    return entry;
  }

  function createNode(
    parent: P9Node,
    name: string,
    kind: P9Kind,
    mode: number,
    gid: number,
  ): P9Node {
    const now = nowSeconds();
    return {
      path: joinPath(parent.path, name),
      kind,
      data: new Uint8Array(),
      children: new Map(),
      mode,
      uid: 0,
      gid,
      nlink: 1,
      rdev: 0,
      size: 0,
      atime: now,
      mtime: now,
      ctime: now,
      qidPath: nextQidPath++,
      qidVersion: 0,
    };
  }

  function removeNode(node: P9Node): void {
    const parent = findParent(root, node.path);
    if (!parent) throw new P9Error(EPERM);
    if (node.kind === 'dir' && node.children.size > 0) throw new P9Error(ENOTEMPTY);
    parent.children.delete(nodeName(node));
    const now = nowSeconds();
    parent.mtime = now;
    parent.ctime = now;
    parent.qidVersion++;
    node.status = 4;
  }

  function encodeDirent(node: P9Node, name: string, nextOffset: number): Uint8Array {
    const w = new Writer();
    w.qid(nodeQid(node));
    w.u64(nextOffset);
    w.u8(qidType(node));
    w.string(name);
    return w.payload();
  }

  function readDirectory(node: P9Node, offset: number, count: number): Uint8Array {
    const names = [...node.children.keys()].sort();
    const chunks: Uint8Array[] = [];
    let used = 0;
    for (let index = offset; index < names.length; index++) {
      const name = names[index]!;
      const child = node.children.get(name)!;
      const dirent = encodeDirent(child, name, index + 1);
      if (used + dirent.byteLength > count) break;
      chunks.push(dirent);
      used += dirent.byteLength;
    }
    const w = new Writer();
    w.u32(used);
    for (const chunk of chunks) w.bytes(chunk);
    return w.payload();
  }

  function readPayload(fid: Fid, offset: bigint, count: number): Uint8Array {
    if (!fid.opened) throw new P9Error(EBADF);
    const maxCount = Math.max(0, msize - 11);
    const want = Math.min(count, maxCount);
    const off = Number(offset);
    if (fid.node.kind === 'dir') return readDirectory(fid.node, off, want);
    if (fid.node.kind === 'symlink') {
      const data = textEncoder.encode(fid.node.symlink ?? '');
      const slice = data.subarray(off, off + want);
      const w = new Writer();
      w.u32(slice.byteLength);
      w.bytes(slice);
      return w.payload();
    }
    const data = fid.node.data.subarray(off, off + want);
    const w = new Writer();
    w.u32(data.byteLength);
    w.bytes(data);
    return w.payload();
  }

  function statPayload(node: P9Node): Uint8Array {
    const name = nodeName(node);
    const uid = String(node.uid);
    const gid = String(node.gid);
    const muid = String(node.uid);
    const extension = node.kind === 'symlink' ? (node.symlink ?? '') : '';
    const lengths = [name, uid, gid, muid, extension].reduce(
      (sum, s) => sum + textEncoder.encode(s).byteLength,
      0,
    );
    // type(2) + dev(4) + qid(13) + mode/atime/mtime(12) + length(8)
    // + 5 strings (2-byte length each) + n_uid/n_gid/n_muid(12)
    const size = 2 + 4 + 13 + 12 + 8 + 10 + lengths + 12;
    const w = new Writer();
    w.u16(size);
    w.u16(0); // type
    w.u32(0); // dev
    w.qid(nodeQid(node));
    w.u32(toP9Mode(node));
    w.u32(node.atime);
    w.u32(node.mtime);
    w.u64(BigInt(node.size));
    w.string(name);
    w.string(uid);
    w.string(gid);
    w.string(muid);
    w.string(extension);
    w.u32(node.uid);
    w.u32(node.gid);
    w.u32(node.uid);
    return w.payload();
  }

  function dispatch(type: number, payload: Uint8Array): Uint8Array {
    const r = new Reader(payload);

    switch (type) {
      case T_ATTACH: {
        const fid = r.u32();
        r.u32(); // afid
        r.string(); // uname
        r.string(); // aname
        const n_uname = r.u32();
        fids.set(fid, { node: root, uid: n_uname, opened: false, mode: 0 });
        const w = new Writer();
        w.qid(nodeQid(root));
        return w.payload();
      }

      case T_WALK: {
        const fid = r.u32();
        const newfid = r.u32();
        const nwname = r.u16();
        const names: string[] = [];
        for (let i = 0; i < nwname; i++) names.push(r.string());

        const source = requireFid(fid);
        if (nwname === 0) {
          fids.set(newfid, { node: source.node, uid: source.uid, opened: false, mode: 0 });
          const w = new Writer();
          w.u16(0);
          return w.payload();
        }

        let node = source.node;
        const qids: Qid[] = [];
        for (const name of names) {
          if (name === '.') {
            qids.push(nodeQid(node));
            continue;
          }
          if (name === '..') {
            const parent = findParent(root, node.path) ?? root;
            node = parent;
            qids.push(nodeQid(node));
            continue;
          }
          if (node.kind !== 'dir') throw new P9Error(ENOTDIR);
          const child = node.children.get(name);
          if (!child) break;
          node = child;
          qids.push(nodeQid(node));
        }
        if (qids.length === names.length) {
          fids.set(newfid, { node, uid: source.uid, opened: false, mode: 0 });
        }
        const w = new Writer();
        w.u16(qids.length);
        for (const qid of qids) w.qid(qid);
        return w.payload();
      }

      case T_LOPEN:
      case T_OPEN: {
        const fid = r.u32();
        const flags = r.u32();
        const entry = requireFid(fid);
        if (entry.node.kind === 'symlink') throw new P9Error(ENOENT);
        entry.opened = true;
        entry.mode = flags;
        const w = new Writer();
        w.qid(nodeQid(entry.node));
        w.u32(Math.max(0, msize - 24));
        return w.payload();
      }

      case T_READ:
      case T_READDIR: {
        const fid = r.u32();
        const offset = r.u64();
        const count = r.u32();
        const entry = requireFid(fid);
        if (type === T_READDIR && entry.node.kind !== 'dir') throw new P9Error(ENOTDIR);
        return readPayload(entry, offset, count);
      }

      case T_WRITE: {
        const fid = r.u32();
        const offset = r.u64();
        const count = r.u32();
        const data = r.bytes(count);
        const entry = requireFid(fid);
        if (!entry.opened) throw new P9Error(EBADF);
        if (entry.node.kind === 'dir') throw new P9Error(EISDIR);
        if (entry.node.kind === 'symlink') throw new P9Error(EBADF);
        const off = Number(offset);
        const end = off + data.byteLength;
        if (end > entry.node.data.byteLength) {
          const next = new Uint8Array(end);
          next.set(entry.node.data);
          entry.node.data = next;
        }
        entry.node.data.set(data, off);
        entry.node.size = entry.node.data.byteLength;
        const now = nowSeconds();
        entry.node.mtime = now;
        entry.node.ctime = now;
        entry.node.qidVersion++;
        markDirty();
        const w = new Writer();
        w.u32(data.byteLength);
        return w.payload();
      }

      case T_CLUNK: {
        const fid = r.u32();
        fids.delete(fid);
        return new Uint8Array(0);
      }

      case T_REMOVE: {
        const fid = r.u32();
        const entry = requireFid(fid);
        removeNode(entry.node);
        fids.delete(fid);
        markDirty();
        return new Uint8Array(0);
      }

      case T_STAT: {
        const fid = r.u32();
        return statPayload(requireFid(fid).node);
      }

      case T_GETATTR: {
        const fid = r.u32();
        const mask = r.u64();
        const node = requireFid(fid).node;
        const w = new Writer();
        w.u64(mask); // valid: echo the requested fields
        w.qid(nodeQid(node));
        w.u32(node.mode);
        w.u32(node.uid);
        w.u32(node.gid);
        w.u64(BigInt(node.nlink));
        w.u64(BigInt(node.rdev));
        w.u64(BigInt(node.size));
        w.u64(BigInt(BLOCK_SIZE));
        w.u64(BigInt(Math.floor(node.size / 512) + (node.size > 0 ? 1 : 0)));
        w.u64(BigInt(node.atime));
        w.u64(0n); // atime nsec
        w.u64(BigInt(node.mtime));
        w.u64(0n); // mtime nsec
        w.u64(BigInt(node.ctime));
        w.u64(0n); // ctime nsec
        w.u64(0n); // btime sec
        w.u64(0n); // btime nsec
        w.u64(0n); // gen
        w.u64(0n); // data version
        return w.payload();
      }

      case T_SETATTR: {
        const fid = r.u32();
        const valid = r.u32();
        const mode = r.u32();
        const uid = r.u32();
        const gid = r.u32();
        const size = r.u64();
        const atimeSec = r.u64();
        const mtimeSec = r.u64();
        r.u64(); // atime nsec
        r.u64(); // mtime nsec
        const node = requireFid(fid).node;
        if (valid & SETATTR_MODE) node.mode = mode;
        if (valid & SETATTR_UID) node.uid = uid;
        if (valid & SETATTR_GID) node.gid = gid;
        if (valid & SETATTR_SIZE) {
          const nextSize = Number(size);
          if (nextSize < node.data.byteLength) {
            node.data = node.data.subarray(0, nextSize);
          } else if (nextSize > node.data.byteLength) {
            const next = new Uint8Array(nextSize);
            next.set(node.data);
            node.data = next;
          }
          node.size = nextSize;
        }
        if (valid & SETATTR_ATIME) node.atime = Number(atimeSec);
        if (valid & SETATTR_MTIME) node.mtime = Number(mtimeSec);
        if (valid & SETATTR_CTIME) node.ctime = Number(mtimeSec);
        if (valid & SETATTR_ATIME_SET) node.atime = Number(atimeSec);
        if (valid & SETATTR_MTIME_SET) node.mtime = Number(mtimeSec);
        markDirty();
        return new Uint8Array(0);
      }

      case T_STATFS: {
        const fid = r.u32();
        requireFid(fid);
        const files = countFiles(root);
        const blocks = 64 * 1024 * 1024;
        const w = new Writer();
        w.u32(P9_STATFS_MAGIC);
        w.u32(BLOCK_SIZE);
        w.u64(BigInt(blocks));
        w.u64(BigInt(blocks));
        w.u64(BigInt(blocks));
        w.u64(BigInt(files));
        w.u64(BigInt(files));
        w.u64(0n); // fsid
        w.u32(255); // namelen
        return w.payload();
      }

      case T_LCREATE: {
        const fid = r.u32();
        const name = r.string();
        const flags = r.u32();
        const mode = r.u32();
        const gid = r.u32();
        const entry = requireFid(fid);
        if (entry.node.kind !== 'dir') throw new P9Error(ENOTDIR);
        if (entry.node.children.has(name)) throw new P9Error(EEXIST);
        const node = createNode(entry.node, name, 'file', mode | S_IFREG, gid);
        entry.node.children.set(name, node);
        const now = nowSeconds();
        entry.node.mtime = now;
        entry.node.ctime = now;
        entry.node.qidVersion++;
        entry.node = node;
        entry.opened = true;
        entry.mode = flags;
        markDirty();
        const w = new Writer();
        w.qid(nodeQid(node));
        w.u32(Math.max(0, msize - 24));
        return w.payload();
      }

      case T_MKDIR: {
        const dfid = r.u32();
        const name = r.string();
        const mode = r.u32();
        const gid = r.u32();
        const entry = requireFid(dfid);
        if (entry.node.kind !== 'dir') throw new P9Error(ENOTDIR);
        if (entry.node.children.has(name)) throw new P9Error(EEXIST);
        const node = createNode(entry.node, name, 'dir', mode | S_IFDIR, gid);
        entry.node.children.set(name, node);
        const now = nowSeconds();
        entry.node.mtime = now;
        entry.node.ctime = now;
        entry.node.qidVersion++;
        markDirty();
        const w = new Writer();
        w.qid(nodeQid(node));
        return w.payload();
      }

      case T_SYMLINK: {
        const fid = r.u32();
        const name = r.string();
        const target = r.string();
        const gid = r.u32();
        const entry = requireFid(fid);
        if (entry.node.kind !== 'dir') throw new P9Error(ENOTDIR);
        if (entry.node.children.has(name)) throw new P9Error(EEXIST);
        const node = createNode(entry.node, name, 'symlink', S_IFLNK | 0o777, gid);
        node.symlink = target;
        entry.node.children.set(name, node);
        const now = nowSeconds();
        entry.node.mtime = now;
        entry.node.ctime = now;
        entry.node.qidVersion++;
        markDirty();
        const w = new Writer();
        w.qid(nodeQid(node));
        return w.payload();
      }

      case T_READLINK: {
        const fid = r.u32();
        const node = requireFid(fid).node;
        if (node.kind !== 'symlink') throw new P9Error(EINVAL);
        const w = new Writer();
        w.string(node.symlink ?? '');
        return w.payload();
      }

      case T_MKNOD: {
        const fid = r.u32();
        const name = r.string();
        const mode = r.u32();
        const major = r.u32();
        const minor = r.u32();
        const gid = r.u32();
        const entry = requireFid(fid);
        if (entry.node.kind !== 'dir') throw new P9Error(ENOTDIR);
        if (entry.node.children.has(name)) throw new P9Error(EEXIST);
        const kind: P9Kind = (mode & S_IFMT) === S_IFDIR ? 'dir' : 'file';
        const node = createNode(entry.node, name, kind, mode, gid);
        node.rdev = ((major & 0xffff) << 8) | (minor & 0xffff);
        entry.node.children.set(name, node);
        const now = nowSeconds();
        entry.node.mtime = now;
        entry.node.ctime = now;
        entry.node.qidVersion++;
        markDirty();
        const w = new Writer();
        w.qid(nodeQid(node));
        return w.payload();
      }

      case T_RENAMEAT: {
        const olddirfid = r.u32();
        const oldname = r.string();
        const newdirfid = r.u32();
        const newname = r.string();
        const olddir = requireFid(olddirfid);
        const newdir = requireFid(newdirfid);
        if (olddir.node.kind !== 'dir' || newdir.node.kind !== 'dir') {
          throw new P9Error(ENOTDIR);
        }
        const node = olddir.node.children.get(oldname);
        if (!node) throw new P9Error(ENOENT);
        const target = newdir.node.children.get(newname);
        if (target) {
          if (target.kind === 'dir' && target.children.size > 0) {
            throw new P9Error(ENOTEMPTY);
          }
          newdir.node.children.delete(newname);
        }
        olddir.node.children.delete(oldname);
        node.path = joinPath(newdir.node.path, newname);
        retargetPaths(node, node.path);
        newdir.node.children.set(newname, node);
        const now = nowSeconds();
        olddir.node.mtime = now;
        olddir.node.ctime = now;
        olddir.node.qidVersion++;
        newdir.node.mtime = now;
        newdir.node.ctime = now;
        newdir.node.qidVersion++;
        markDirty();
        return new Uint8Array(0);
      }

      case T_UNLINKAT: {
        const dfid = r.u32();
        const name = r.string();
        const flags = r.u32();
        const entry = requireFid(dfid);
        if (entry.node.kind !== 'dir') throw new P9Error(ENOTDIR);
        const node = entry.node.children.get(name);
        if (!node) throw new P9Error(ENOENT);
        if (flags & AT_REMOVEDIR) {
          if (node.kind !== 'dir') throw new P9Error(ENOTDIR);
          if (node.children.size > 0) throw new P9Error(ENOTEMPTY);
        } else if (node.kind === 'dir') {
          throw new P9Error(EISDIR);
        }
        entry.node.children.delete(name);
        const now = nowSeconds();
        entry.node.mtime = now;
        entry.node.ctime = now;
        entry.node.qidVersion++;
        node.status = 4;
        markDirty();
        return new Uint8Array(0);
      }

      case T_FSYNC: {
        const fid = r.u32();
        requireFid(fid);
        return new Uint8Array(0);
      }

      case T_FLUSH: {
        r.u16(); // oldtag
        return new Uint8Array(0);
      }

      case T_AUTH:
      case T_CREATE:
      case T_WSTAT:
      case T_XATTRWALK:
      case T_XATTRCREATE:
      case T_LINK:
      case T_LOCK:
      case T_GETLOCK:
        throw new NotImplementedError(`9p message ${type} is not implemented`);

      default:
        throw new NotImplementedError(`9p message ${type} is not implemented`);
    }
  }

  async function handleRequest(
    reqbuf: Uint8Array,
    reply: (replybuf: Uint8Array) => void,
  ): Promise<void> {
    let request: P9Request;
    try {
      request = parseFrame(reqbuf);
    } catch {
      reply(buildErrorFrame(0, EINVAL));
      return;
    }

    if (request.type === T_VERSION) {
      const r = new Reader(request.payload);
      const requested = r.u32();
      r.string();
      msize = Math.min(requested, MAX_MSIZE);
      const w = new Writer();
      w.u32(msize);
      w.string(P9_VERSION);
      reply(buildReply(request.type + 1, request.tag, w.payload()));
      if (!loaded && !loadPromise) {
        void ensureLoaded().catch((err) =>
          deps.onLog?.(`fs9p: load failed (${String(err)})`),
        );
      }
      return;
    }

    try {
      await ensureLoaded();
      const payload = dispatch(request.type, request.payload);
      reply(buildReply(request.type + 1, request.tag, payload));
    } catch (err) {
      deps.onLog?.(`fs9p: ${String(err)}`);
      reply(buildErrorFrame(request.tag, toErrno(err)));
    }
  }

  const handle = ((reqbuf: Uint8Array, reply: (replybuf: Uint8Array) => void): void => {
    void handleRequest(reqbuf, reply);
  }) as Fs9pHandle;

  Object.defineProperty(handle, 'tree', { get: () => root, enumerable: true });
  handle.ready = ensureLoaded;
  handle.flush = flush;
  handle.persist = persist;

  return handle;
}

/** Alias matching the v86 `filesystem.handle9p` option name. */
export const handle9p = create9pHandler;
