import { describe, expect, it, vi } from 'vitest';
import type { Conversation, Database, VMSnapshot } from '@/types/index.js';
import {
  IdbSnapshotStore,
  LazyBlobStore,
  OpfsSnapshotStore,
  SnapshotManager,
  type SnapshotBlobStore,
  type SnapshotDatabase,
} from '@/core/persistence/snapshots.js';

// ---------------------------------------------------------------------------
// Fake OPFS
// ---------------------------------------------------------------------------

class FakeFileHandle {
  data = new Uint8Array();

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
    if (!options?.create) throw new Error(`not found: ${name}`);
    const dir = new FakeDirHandle(name);
    this.dirs.set(name, dir);
    return dir;
  }

  async getFileHandle(name: string, options?: { create?: boolean }) {
    const existing = this.files.get(name);
    if (existing) return existing;
    if (!options?.create) throw new Error(`not found: ${name}`);
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

function mockOpfs(root: FakeDirHandle): void {
  const nav = navigator as unknown as { storage?: unknown };
  Object.defineProperty(nav, 'storage', {
    value: { getDirectory: async () => root },
    configurable: true,
  });
}

function clearOpfs(): void {
  const nav = navigator as unknown as { storage?: unknown };
  try {
    delete nav.storage;
  } catch {
    nav.storage = undefined;
  }
}

// ---------------------------------------------------------------------------
// Fake databases
// ---------------------------------------------------------------------------

class FakeSnapshotDb implements SnapshotDatabase {
  readonly snapshots = new Map<string, VMSnapshot>();
  readonly blobs = new Map<string, Uint8Array>();
  readonly conversations = new Map<string, Conversation>();
  readonly settings = new Map<string, unknown>();

  async open(): Promise<void> {}
  async close(): Promise<void> {}
  async putConversation(c: Conversation): Promise<void> {
    this.conversations.set(c.id, c);
  }
  async getConversation(id: string): Promise<Conversation | undefined> {
    return this.conversations.get(id);
  }
  async listConversations(): Promise<Conversation[]> {
    return [...this.conversations.values()];
  }
  async deleteConversation(id: string): Promise<void> {
    this.conversations.delete(id);
  }
  async putSnapshot(s: VMSnapshot, data: Uint8Array): Promise<void> {
    this.snapshots.set(s.id, s);
    this.blobs.set(s.id, data);
  }
  async getSnapshot(id: string) {
    const meta = this.snapshots.get(id);
    if (!meta) return undefined;
    const data = this.blobs.get(id);
    return data ? { meta, data } : undefined;
  }
  async putSnapshotMeta(s: VMSnapshot): Promise<void> {
    this.snapshots.set(s.id, s);
  }
  async getSnapshotMeta(id: string): Promise<VMSnapshot | undefined> {
    return this.snapshots.get(id);
  }
  async deleteSnapshot(id: string): Promise<void> {
    this.snapshots.delete(id);
    this.blobs.delete(id);
  }
  async listSnapshotsByConversation(conversationId: string): Promise<VMSnapshot[]> {
    return [...this.snapshots.values()]
      .filter((s) => s.conversationId === conversationId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }
  async listSnapshots(): Promise<VMSnapshot[]> {
    return [...this.snapshots.values()];
  }
  async putSnapshotData(id: string, data: Uint8Array): Promise<void> {
    this.blobs.set(id, data);
  }
  async getSnapshotData(id: string): Promise<Uint8Array | undefined> {
    return this.blobs.get(id);
  }
  async deleteSnapshotData(id: string): Promise<void> {
    this.blobs.delete(id);
  }
  async setSetting(key: string, value: unknown): Promise<void> {
    this.settings.set(key, value);
  }
  async getSetting<T>(key: string): Promise<T | undefined> {
    return this.settings.get(key) as T | undefined;
  }
}

/** A base `Database` with no OPFS-specific accessors. */
function makePlainDb(): Database {
  const snapshots = new Map<string, VMSnapshot>();
  const blobs = new Map<string, Uint8Array>();
  return {
    async open() {},
    async close() {},
    async putConversation() {},
    async getConversation() {
      return undefined;
    },
    async listConversations() {
      return [];
    },
    async deleteConversation() {},
    async putSnapshot(s, data) {
      snapshots.set(s.id, s);
      blobs.set(s.id, data);
    },
    async getSnapshot(id) {
      const meta = snapshots.get(id);
      if (!meta) return undefined;
      const data = blobs.get(id);
      return data ? { meta, data } : undefined;
    },
    async setSetting() {},
    async getSetting() {
      return undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const text = new TextEncoder();

async function readOpfsFile(root: FakeDirHandle, prefix: string, id: string): Promise<Uint8Array> {
  const dir = await root.getDirectoryHandle(prefix);
  const handle = await dir.getFileHandle(`${id}.bin`);
  const file = await handle.getFile();
  return new Uint8Array(await file.arrayBuffer());
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SnapshotManager', () => {
  it('captures to OPFS and records metadata', async () => {
    const root = new FakeDirHandle('root');
    mockOpfs(root);
    const db = new FakeSnapshotDb();
    const manager = new SnapshotManager(db);
    const data = text.encode('state-1');

    try {
      const snap = await manager.capture('c1', data);

      expect(snap.conversationId).toBe('c1');
      expect(snap.kind).toBe('full');
      expect(snap.sizeBytes).toBe(data.byteLength);
      expect(snap.stateRef).toBe(`opfs:snapshots/${snap.id}.bin`);
      expect(db.snapshots.get(snap.id)?.stateRef).toBe(snap.stateRef);
      expect(await readOpfsFile(root, 'snapshots', snap.id)).toEqual(data);
    } finally {
      clearOpfs();
    }
  });

  it('loads a captured snapshot', async () => {
    const root = new FakeDirHandle('root');
    mockOpfs(root);
    const manager = new SnapshotManager(new FakeSnapshotDb());
    const data = text.encode('restore-me');

    try {
      const snap = await manager.capture('c1', data);
      const loaded = await manager.load(snap.id);

      expect(loaded?.meta.id).toBe(snap.id);
      expect(loaded?.meta.conversationId).toBe('c1');
      expect(loaded?.data).toEqual(data);
    } finally {
      clearOpfs();
    }
  });

  it('returns undefined when loading an unknown snapshot', async () => {
    const manager = new SnapshotManager(new FakeSnapshotDb());
    expect(await manager.load('missing')).toBeUndefined();
  });

  it('lists a conversation newest first', async () => {
    const root = new FakeDirHandle('root');
    mockOpfs(root);
    const db = new FakeSnapshotDb();
    const manager = new SnapshotManager(db);
    const now = vi.spyOn(Date, 'now');

    try {
      now.mockReturnValueOnce(1000);
      const older = await manager.capture('c1', text.encode('a'));
      now.mockReturnValueOnce(2000);
      const newer = await manager.capture('c1', text.encode('b'));
      await manager.capture('c2', text.encode('other'));

      const list = await manager.listForConversation('c1');
      expect(list.map((s) => s.id)).toEqual([newer.id, older.id]);
    } finally {
      now.mockRestore();
      clearOpfs();
    }
  });

  it('deletes metadata and blob', async () => {
    const root = new FakeDirHandle('root');
    mockOpfs(root);
    const db = new FakeSnapshotDb();
    const manager = new SnapshotManager(db);

    try {
      const snap = await manager.capture('c1', text.encode('bye'));
      await manager.delete(snap.id);

      expect(db.snapshots.has(snap.id)).toBe(false);
      await expect(readOpfsFile(root, 'snapshots', snap.id)).rejects.toThrow();
      expect(await manager.load(snap.id)).toBeUndefined();
    } finally {
      clearOpfs();
    }
  });

  it('falls back to IndexedDB blobs when OPFS is unavailable', async () => {
    clearOpfs();
    const db = new FakeSnapshotDb();
    const manager = new SnapshotManager(db);
    const data = text.encode('idb-fallback');

    const snap = await manager.capture('c1', data);
    expect(snap.stateRef).toBe(`idb:${snap.id}`);
    expect(db.blobs.get(snap.id)).toEqual(data);

    const loaded = await manager.load(snap.id);
    expect(loaded?.data).toEqual(data);

    await manager.delete(snap.id);
    expect(db.blobs.has(snap.id)).toBe(false);
    expect(await manager.load(snap.id)).toBeUndefined();
  });

  it('falls back to IndexedDB when getDirectory throws', async () => {
    const nav = navigator as unknown as { storage?: unknown };
    Object.defineProperty(nav, 'storage', {
      value: {
        getDirectory: async () => {
          throw new Error('no OPFS');
        },
      },
      configurable: true,
    });
    const db = new FakeSnapshotDb();
    const manager = new SnapshotManager(db);

    try {
      const snap = await manager.capture('c1', text.encode('recover'));
      expect(snap.stateRef).toBe(`idb:${snap.id}`);
      expect(db.blobs.get(snap.id)).toEqual(text.encode('recover'));
    } finally {
      clearOpfs();
    }
  });

  it('works with a plain Database without extended accessors', async () => {
    const db = makePlainDb();
    const manager = new SnapshotManager(db);
    const data = text.encode('plain');

    const snap = await manager.capture('c1', data);
    expect(snap.stateRef).toBe(`idb:${snap.id}`);

    const loaded = await manager.load(snap.id);
    expect(loaded?.data).toEqual(data);

    const list = await manager.listForConversation('c1');
    expect(list.map((s) => s.id)).toEqual([snap.id]);
  });
});

describe('OpfsSnapshotStore', () => {
  it('round-trips, lists, and removes blobs', async () => {
    const root = new FakeDirHandle('root');
    const store = new OpfsSnapshotStore(root as unknown as FileSystemDirectoryHandle, 'blobs');
    const data = text.encode('opfs-store');

    const ref = await store.save('id-1', data);
    expect(ref).toBe('opfs:blobs/id-1.bin');
    expect(await store.load('id-1')).toEqual(data);
    expect(await store.list()).toEqual(['id-1']);

    await store.remove('id-1');
    expect(await store.load('id-1')).toBeUndefined();
    expect(await store.list()).toEqual([]);
    // Removing a missing blob is a no-op.
    await store.remove('id-1');
  });
});

describe('IdbSnapshotStore', () => {
  it('stores blobs through the extended database accessors', async () => {
    const db = new FakeSnapshotDb();
    const store: SnapshotBlobStore = new IdbSnapshotStore(db);
    const data = text.encode('idb-store');

    const ref = await store.save('id-2', data);
    expect(ref).toBe('idb:id-2');
    expect(await store.load('id-2')).toEqual(data);

    await store.remove('id-2');
    expect(await store.load('id-2')).toBeUndefined();
  });
});

describe('LazyBlobStore', () => {
  it('prefers OPFS and caches the resolved store', async () => {
    const root = new FakeDirHandle('root');
    mockOpfs(root);
    const db = new FakeSnapshotDb();
    const store = new LazyBlobStore(db, 'lazy');

    try {
      const ref = await store.save('id-3', text.encode('lazy'));
      expect(ref).toBe('opfs:lazy/id-3.bin');
      expect(await readOpfsFile(root, 'lazy', 'id-3')).toEqual(text.encode('lazy'));
      expect(db.blobs.has('id-3')).toBe(false);
    } finally {
      clearOpfs();
    }
  });

  it('falls back to IndexedDB when OPFS is missing', async () => {
    clearOpfs();
    const db = new FakeSnapshotDb();
    const store = new LazyBlobStore(db, 'lazy');

    const ref = await store.save('id-4', text.encode('lazy-idb'));
    expect(ref).toBe('idb:id-4');
    expect(await store.load('id-4')).toEqual(text.encode('lazy-idb'));
  });
});
