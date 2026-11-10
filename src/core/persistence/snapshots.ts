import type { Database, VMSnapshot } from '@/types/index.js';
import { uuid } from '@/lib/utils.js';

/**
 * VM snapshot manager.
 *
 * Snapshots are the foundation for time-travel / fork sessions. v0.1 stores
 * full v86 state images; v0.2 adds copy-on-write deltas over OPFS.
 *
 * Storage layout:
 *  - metadata always lives in IndexedDB (`snapshots` store)
 *  - blobs live in OPFS when available, otherwise in IndexedDB
 *    (`snapshot_data` store)
 *
 * `VMSnapshot.stateRef` records where the blob is:
 *  - `opfs:<prefix>/<id>.bin`
 *  - `idb:<id>`
 *
 * The base `Database` interface predates OPFS, so the extended accessors are
 * feature-detected: `IdbDatabase` implements them, and the manager falls back
 * to `putSnapshot`/`getSnapshot` plus an in-memory index when they are absent.
 */

const DEFAULT_OPFS_PREFIX = 'snapshots';

/** Backend-agnostic blob store for snapshot payloads. */
export interface SnapshotBlobStore {
  /** Store a blob and return the `stateRef` that locates it. */
  save(id: string, data: Uint8Array): Promise<string>;
  /** Load a blob. Returns undefined when it does not exist. */
  load(id: string): Promise<Uint8Array | undefined>;
  /** Remove a blob. Missing blobs are ignored. */
  remove(id: string): Promise<void>;
  /** List stored blob ids. */
  list(): Promise<string[]>;
}

/** Snapshot accessors `IdbDatabase` exposes beyond the `Database` interface. */
export interface SnapshotDatabase extends Database {
  putSnapshotMeta?(s: VMSnapshot): Promise<void>;
  getSnapshotMeta?(id: string): Promise<VMSnapshot | undefined>;
  deleteSnapshot?(id: string): Promise<void>;
  listSnapshotsByConversation?(conversationId: string): Promise<VMSnapshot[]>;
  listSnapshots?(): Promise<VMSnapshot[]>;
  putSnapshotData?(id: string, data: Uint8Array): Promise<void>;
  getSnapshotData?(id: string): Promise<Uint8Array | undefined>;
  deleteSnapshotData?(id: string): Promise<void>;
}

export interface SnapshotManagerOptions {
  /** OPFS directory (under the storage root) that holds snapshot blobs. */
  opfsPrefix?: string;
  /** Called with diagnostics (notably blob-backend failovers). */
  onLog?: (message: string) => void;
}

/** OPFS-backed blob store. Preferred: fast and quota-friendly for large blobs. */
export class OpfsSnapshotStore implements SnapshotBlobStore {
  constructor(
    private readonly root: FileSystemDirectoryHandle,
    private readonly prefix: string,
  ) {}

  private async dir(): Promise<FileSystemDirectoryHandle> {
    return this.root.getDirectoryHandle(this.prefix, { create: true });
  }

  async save(id: string, data: Uint8Array): Promise<string> {
    const dir = await this.dir();
    const handle = await dir.getFileHandle(`${id}.bin`, { create: true });
    const writable = await handle.createWritable();
    // Copy into a fresh ArrayBuffer-backed view: DOM write() rejects views over
    // SharedArrayBuffer, and `Uint8Array.slice()` is typed as ArrayBuffer-backed.
    await writable.write(data.slice());
    await writable.close();
    return `opfs:${this.prefix}/${id}.bin`;
  }

  async load(id: string): Promise<Uint8Array | undefined> {
    try {
      const dir = await this.dir();
      const handle = await dir.getFileHandle(`${id}.bin`);
      const file = await handle.getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch {
      return undefined;
    }
  }

  async remove(id: string): Promise<void> {
    try {
      const dir = await this.dir();
      await dir.removeEntry(`${id}.bin`);
    } catch {
      // already gone
    }
  }

  async list(): Promise<string[]> {
    const ids: string[] = [];
    try {
      const dir = await this.dir();
      // DOM.AsyncIterable is not in the configured lib; use the runtime shape.
      const keys = (dir as unknown as { keys(): AsyncIterableIterator<string> }).keys();
      for await (const name of keys) {
        if (name.endsWith('.bin')) ids.push(name.slice(0, -'.bin'.length));
      }
    } catch {
      // directory does not exist yet
    }
    return ids;
  }
}

/** IndexedDB-backed blob store. Fallback when OPFS is unavailable. */
export class IdbSnapshotStore implements SnapshotBlobStore {
  constructor(private readonly db: SnapshotDatabase) {}

  async save(id: string, data: Uint8Array): Promise<string> {
    if (this.db.putSnapshotData) {
      await this.db.putSnapshotData(id, data);
    } else {
      // Last-resort fallback: reuse putSnapshot with a placeholder record.
      await this.db.putSnapshot(
        {
          id,
          conversationId: '',
          createdAt: 0,
          kind: 'full',
          sizeBytes: data.byteLength,
          stateRef: `idb:${id}`,
        },
        data,
      );
    }
    return `idb:${id}`;
  }

  async load(id: string): Promise<Uint8Array | undefined> {
    if (this.db.getSnapshotData) return this.db.getSnapshotData(id);
    const result = await this.db.getSnapshot(id);
    return result?.data;
  }

  async remove(id: string): Promise<void> {
    if (this.db.deleteSnapshotData) await this.db.deleteSnapshotData(id);
  }

  async list(): Promise<string[]> {
    return [];
  }
}

/**
 * Resolves the blob backend lazily: OPFS on first use, IndexedDB when OPFS is
 * missing or fails. Construction never touches the filesystem.
 *
 * The fallback is not limited to resolution: any OPFS operation that throws at
 * runtime (quota exceeded, storage eviction, write error) fails over to
 * IndexedDB. After a write failover, loads still consult OPFS so snapshots
 * written while OPFS was healthy stay readable.
 */
export class LazyBlobStore implements SnapshotBlobStore {
  private store: SnapshotBlobStore | null = null;
  private resolving: Promise<SnapshotBlobStore> | null = null;
  private opfs: OpfsSnapshotStore | null = null;
  private idb: IdbSnapshotStore | null = null;

  constructor(
    private readonly db: SnapshotDatabase,
    private readonly prefix: string,
    private readonly onLog?: (message: string) => void,
  ) {}

  private idbStore(): IdbSnapshotStore {
    if (!this.idb) this.idb = new IdbSnapshotStore(this.db);
    return this.idb;
  }

  private async opfsStore(): Promise<OpfsSnapshotStore> {
    if (!this.opfs) {
      const storage = (globalThis as { navigator?: Navigator }).navigator?.storage;
      if (!storage || typeof storage.getDirectory !== 'function') {
        throw new Error('OPFS is not available');
      }
      const root = await storage.getDirectory();
      this.opfs = new OpfsSnapshotStore(root, this.prefix);
    }
    return this.opfs;
  }

  private resolve(): Promise<SnapshotBlobStore> {
    if (this.store) return Promise.resolve(this.store);
    if (!this.resolving) {
      this.resolving = this.create().then((store) => {
        this.store = store;
        return store;
      });
    }
    return this.resolving;
  }

  private async create(): Promise<SnapshotBlobStore> {
    try {
      return await this.opfsStore();
    } catch (err) {
      this.onLog?.(`snapshot store: OPFS unavailable (${String(err)}); using IndexedDB`);
      return this.idbStore();
    }
  }

  /** Switch writes to IndexedDB after an OPFS failure. */
  private failover(err: unknown): IdbSnapshotStore {
    this.onLog?.(`snapshot store: OPFS operation failed (${String(err)}); using IndexedDB`);
    const idb = this.idbStore();
    this.store = idb;
    this.resolving = null;
    return idb;
  }

  async save(id: string, data: Uint8Array): Promise<string> {
    try {
      return await (await this.resolve()).save(id, data);
    } catch (err) {
      return this.failover(err).save(id, data);
    }
  }

  async load(id: string): Promise<Uint8Array | undefined> {
    let primary: SnapshotBlobStore;
    try {
      primary = await this.resolve();
    } catch (err) {
      return this.failover(err).load(id);
    }

    let data: Uint8Array | undefined;
    try {
      data = await primary.load(id);
    } catch (err) {
      return this.failover(err).load(id);
    }
    if (data !== undefined) return data;

    // The active backend has no such blob; check the other one. After a write
    // failover, snapshots written while OPFS was healthy still live there.
    const other = primary === this.opfs ? this.idbStore() : this.opfs;
    return other ? other.load(id) : undefined;
  }

  async remove(id: string): Promise<void> {
    try {
      await (await this.resolve()).remove(id);
    } catch (err) {
      await this.failover(err).remove(id);
    }
  }

  async list(): Promise<string[]> {
    try {
      return await (await this.resolve()).list();
    } catch (err) {
      return this.failover(err).list();
    }
  }
}

export class SnapshotManager {
  private readonly db: SnapshotDatabase;
  private readonly blobs: SnapshotBlobStore | null;
  private readonly byConversation = new Map<string, VMSnapshot[]>();
  private indexLoaded = false;

  constructor(database: Database, options: SnapshotManagerOptions = {}) {
    this.db = database as SnapshotDatabase;
    this.blobs =
      typeof this.db.putSnapshotMeta === 'function'
        ? new LazyBlobStore(
            this.db,
            options.opfsPrefix ?? DEFAULT_OPFS_PREFIX,
            options.onLog,
          )
        : null;
  }

  /**
   * Capture a snapshot: write the blob, then persist metadata that points at it.
   * The blob backend is chosen on first write (OPFS preferred, IndexedDB fallback).
   */
  async capture(
    conversationId: string,
    data: Uint8Array,
    kind: VMSnapshot['kind'] = 'full',
  ): Promise<VMSnapshot> {
    const id = uuid();
    const snapshot: VMSnapshot = {
      id,
      conversationId,
      createdAt: Date.now(),
      kind,
      sizeBytes: data.byteLength,
      stateRef: '',
    };

    if (this.blobs) {
      snapshot.stateRef = await this.blobs.save(id, data);
      await this.db.putSnapshotMeta!(snapshot);
    } else {
      snapshot.stateRef = `idb:${id}`;
      await this.db.putSnapshot(snapshot, data);
      this.indexSnapshot(snapshot);
    }

    return snapshot;
  }

  /** Load a snapshot's metadata and blob. */
  async load(id: string): Promise<{ meta: VMSnapshot; data: Uint8Array } | undefined> {
    if (this.blobs) {
      const meta = await this.db.getSnapshotMeta!(id);
      if (!meta) return undefined;
      const data = await this.blobs.load(id);
      if (!data) return undefined;
      return { meta, data };
    }
    return this.db.getSnapshot(id);
  }

  /** List a conversation's snapshots, newest first. */
  async listForConversation(conversationId: string): Promise<VMSnapshot[]> {
    if (this.db.listSnapshotsByConversation) {
      return this.db.listSnapshotsByConversation(conversationId);
    }
    await this.loadIndex();
    const list = this.byConversation.get(conversationId) ?? [];
    return [...list].sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Delete a snapshot's metadata and blob. */
  async delete(id: string): Promise<void> {
    if (this.db.deleteSnapshot) await this.db.deleteSnapshot(id);
    await this.blobs?.remove(id);
    this.unindexSnapshot(id);
  }

  private indexSnapshot(snapshot: VMSnapshot): void {
    const list = this.byConversation.get(snapshot.conversationId) ?? [];
    list.push(snapshot);
    this.byConversation.set(snapshot.conversationId, list);
  }

  private unindexSnapshot(id: string): void {
    for (const [conversationId, list] of this.byConversation) {
      const index = list.findIndex((s) => s.id === id);
      if (index >= 0) {
        list.splice(index, 1);
        this.byConversation.set(conversationId, list);
        return;
      }
    }
  }

  private async loadIndex(): Promise<void> {
    if (this.indexLoaded) return;
    this.indexLoaded = true;
    if (this.db.listSnapshots) {
      for (const snapshot of await this.db.listSnapshots()) this.indexSnapshot(snapshot);
    }
  }
}
