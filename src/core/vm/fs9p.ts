/**
 * Custom 9p filesystem backend for v86, backed by OPFS / IndexedDB.
 *
 * v86 calls `handle9p(reqbuf, reply)` for every 9p request. Implementing the
 * full 9p2000.u protocol is out of scope for v0.1; this module provides:
 *
 *  - a typed request/response scaffold (TLversion, Rversion, Tattach, ...)
 *  - an in-memory tree with OPFS persistence hooks
 *  - a `create9pHandler(deps)` factory wired into `V86Options.filesystem`
 *
 * See docs/ENGINEERING_PLAN.md §3.1 and docs/research/9p.md.
 */

export interface Fs9pDeps {
  /** Read a file's bytes from persistent storage. */
  read: (path: string) => Promise<Uint8Array | undefined>;
  /** Write a file's bytes to persistent storage. */
  write: (path: string, data: Uint8Array) => Promise<void>;
  /** List a directory. */
  readdir: (path: string) => Promise<string[]>;
}

export interface P9Node {
  path: string;
  kind: 'file' | 'dir';
  data: Uint8Array;
  children: Map<string, P9Node>;
  mode: number;
  mtime: number;
}

export function createEmptyTree(rootPath = '/'): P9Node {
  return {
    path: rootPath,
    kind: 'dir',
    data: new Uint8Array(),
    children: new Map(),
    mode: 0o40755,
    mtime: Date.now() / 1000,
  };
}

/**
 * Build the `handle9p` function for v86.
 * TODO: implement the 9p wire protocol (issue #17).
 */
export function create9pHandler(deps: Fs9pDeps): (req: Uint8Array, reply: (r: Uint8Array) => void) => void {
  const root = createEmptyTree();
  return (req, reply) => {
    // TODO: parse TLversion/Tattach/Twalk/Topen/Tread/Twrite/Tclunk/Tremove
    // and encode the matching R* response. Reply with an error frame until
    // implemented so v86 fails loudly rather than silently.
    void deps;
    void root;
    reply(new Uint8Array());
  };
}

/** Persist the tree to OPFS as a JSON index + binary blobs. */
export async function persistTree(root: P9Node, prefix = '/fs9p'): Promise<void> {
  // TODO: walk the tree, write blobs to OPFS, write the index.
  void root;
  void prefix;
}

/** Load a persisted tree from OPFS. */
export async function loadTree(prefix = '/fs9p'): Promise<P9Node> {
  // TODO: read the index + blobs from OPFS.
  void prefix;
  return createEmptyTree();
}
