import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Conversation, VMSnapshot } from '@/types/index.js';
import { openDB } from 'idb';
import { IdbDatabase } from '@/core/persistence/db.js';

/**
 * IdbDatabase tests.
 *
 * The class is a thin wrapper over `idb`'s `openDB`: it owns the schema
 * (stores + indexes), the read/write methods, and the two multi-store
 * snapshot transactions. `idb` is replaced with an in-memory fake so the
 * wrapper's own behavior — schema creation, key handling, ordering, and
 * transaction usage — is what gets asserted.
 */

vi.mock('idb', () => ({ openDB: vi.fn() }));

interface FakeStore {
  name: string;
  keyPath: string | undefined;
  data: Map<string, unknown>;
  indexes: Map<string, string>;
  createIndex(name: string, keyPath: string): void;
  put(value: unknown, key?: string): Promise<void>;
  get(key: string): Promise<unknown>;
  getAll(): Promise<unknown[]>;
  getAllFromIndex(name: string, key?: string): Promise<unknown[]>;
  delete(key: string): Promise<void>;
}

interface FakeDb {
  stores: Map<string, FakeStore>;
  transactions: Array<{ stores: string[]; mode: string }>;
  closed: number;
  createObjectStore(name: string, options?: { keyPath?: string }): FakeStore;
  put(store: string, value: unknown, key?: string): Promise<void>;
  get(store: string, key: string): Promise<unknown>;
  getAll(store: string): Promise<unknown[]>;
  getAllFromIndex(store: string, index: string, key?: string): Promise<unknown[]>;
  delete(store: string, key: string): Promise<void>;
  transaction(stores: string[], mode: string): {
    objectStore(name: string): FakeStore;
    done: Promise<void>;
  };
  close(): void;
}

function makeStore(name: string, keyPath?: string): FakeStore {
  const store: FakeStore = {
    name,
    keyPath,
    data: new Map(),
    indexes: new Map(),
    createIndex(indexName, indexKeyPath) {
      store.indexes.set(indexName, indexKeyPath);
    },
    async put(value, key) {
      const storeKey = key ?? (value as { id?: string }).id;
      if (storeKey === undefined) throw new Error(`${name}: no key`);
      store.data.set(storeKey, value);
    },
    async get(key) {
      return store.data.get(key);
    },
    async getAll() {
      return [...store.data.values()];
    },
    async getAllFromIndex(indexName, key) {
      const keyPath = store.indexes.get(indexName);
      if (!keyPath) throw new Error(`${name}: no index ${indexName}`);
      const values = [...store.data.values()];
      if (key === undefined) return values;
      return values.filter((value) => (value as Record<string, unknown>)[keyPath] === key);
    },
    async delete(key) {
      store.data.delete(key);
    },
  };
  return store;
}

function makeDb(): FakeDb {
  const db: FakeDb = {
    stores: new Map(),
    transactions: [],
    closed: 0,
    createObjectStore(name, options) {
      const store = makeStore(name, options?.keyPath);
      db.stores.set(name, store);
      return store;
    },
    put(store, value, key) {
      return db.stores.get(store)!.put(value, key);
    },
    get(store, key) {
      return db.stores.get(store)!.get(key);
    },
    getAll(store) {
      return db.stores.get(store)!.getAll();
    },
    getAllFromIndex(store, index, key) {
      return db.stores.get(store)!.getAllFromIndex(index, key);
    },
    delete(store, key) {
      return db.stores.get(store)!.delete(key);
    },
    transaction(stores, mode) {
      db.transactions.push({ stores, mode });
      return {
        objectStore: (name) => db.stores.get(name)!,
        done: Promise.resolve(),
      };
    },
    close() {
      db.closed += 1;
    },
  };
  return db;
}

const openDbMock = openDB as unknown as ReturnType<typeof vi.fn>;
let dbs: FakeDb[];

function makeConversation(id: string, updatedAt: number): Conversation {
  return { id, title: `t-${id}`, messages: [], createdAt: updatedAt, updatedAt, modelId: 'm' };
}

function snapshot(id: string, conversationId: string, createdAt: number): VMSnapshot {
  return {
    id,
    conversationId,
    createdAt,
    kind: 'full',
    sizeBytes: 1,
    stateRef: `opfs://${id}`,
  };
}

beforeEach(() => {
  dbs = [];
  openDbMock.mockReset();
  openDbMock.mockImplementation(async (_name, _version, options) => {
    const db = makeDb();
    dbs.push(db);
    options?.upgrade?.(db);
    return db;
  });
});

describe('IdbDatabase', () => {
  it('creates the five stores and their indexes on open', async () => {
    const db = new IdbDatabase();
    await db.open();

    expect(openDbMock).toHaveBeenCalledWith(
      'ghostshell',
      1,
      expect.objectContaining({ upgrade: expect.any(Function) }),
    );
    const fake = dbs[0]!;
    expect([...fake.stores.keys()]).toEqual([
      'conversations',
      'snapshots',
      'snapshot_data',
      'settings',
      'models',
    ]);
    expect(fake.stores.get('conversations')!.keyPath).toBe('id');
    expect(fake.stores.get('snapshots')!.keyPath).toBe('id');
    expect(fake.stores.get('conversations')!.indexes.get('by-updated')).toBe('updatedAt');
    expect(fake.stores.get('snapshots')!.indexes.get('by-conversation')).toBe('conversationId');
  });

  it('rejects every operation until open', async () => {
    const db = new IdbDatabase();
    const conversation = makeConversation('c1', 1);
    const blob = new Uint8Array([1]);

    await expect(db.putConversation(conversation)).rejects.toThrow('Database not opened');
    await expect(db.getConversation('c1')).rejects.toThrow('Database not opened');
    await expect(db.listConversations()).rejects.toThrow('Database not opened');
    await expect(db.deleteConversation('c1')).rejects.toThrow('Database not opened');
    await expect(db.putSnapshot(snapshot('s1', 'c1', 1), blob)).rejects.toThrow('Database not opened');
    await expect(db.getSnapshot('s1')).rejects.toThrow('Database not opened');
    await expect(db.putSnapshotMeta(snapshot('s1', 'c1', 1))).rejects.toThrow('Database not opened');
    await expect(db.getSnapshotMeta('s1')).rejects.toThrow('Database not opened');
    await expect(db.deleteSnapshot('s1')).rejects.toThrow('Database not opened');
    await expect(db.listSnapshotsByConversation('c1')).rejects.toThrow('Database not opened');
    await expect(db.listSnapshots()).rejects.toThrow('Database not opened');
    await expect(db.putSnapshotData('s1', blob)).rejects.toThrow('Database not opened');
    await expect(db.getSnapshotData('s1')).rejects.toThrow('Database not opened');
    await expect(db.deleteSnapshotData('s1')).rejects.toThrow('Database not opened');
    await expect(db.setSetting('k', 1)).rejects.toThrow('Database not opened');
    await expect(db.getSetting('k')).rejects.toThrow('Database not opened');
  });

  it('close is a no-op before open and blocks later use', async () => {
    const db = new IdbDatabase();
    await db.close();
    expect(dbs).toHaveLength(0);
    await expect(db.getSetting('k')).rejects.toThrow('Database not opened');
  });

  it('puts and gets a conversation', async () => {
    const db = new IdbDatabase();
    await db.open();
    await db.putConversation(makeConversation('c1', 5));
    await expect(db.getConversation('c1')).resolves.toMatchObject({ id: 'c1', updatedAt: 5 });
    await expect(db.getConversation('missing')).resolves.toBeUndefined();
  });

  it('lists conversations newest-first', async () => {
    const db = new IdbDatabase();
    await db.open();
    await db.putConversation(makeConversation('c1', 1));
    await db.putConversation(makeConversation('c2', 3));
    await db.putConversation(makeConversation('c3', 2));
    await expect(db.listConversations()).resolves.toMatchObject([
      { id: 'c3' },
      { id: 'c2' },
      { id: 'c1' },
    ]);
  });

  it('deletes a conversation', async () => {
    const db = new IdbDatabase();
    await db.open();
    await db.putConversation(makeConversation('c1', 1));
    await db.deleteConversation('c1');
    await expect(db.getConversation('c1')).resolves.toBeUndefined();
  });

  it('stores snapshot metadata and blob in one readwrite transaction', async () => {
    const db = new IdbDatabase();
    await db.open();
    const blob = new Uint8Array([1, 2, 3]);
    await db.putSnapshot(snapshot('s1', 'c1', 7), blob);

    const fake = dbs[0]!;
    expect(fake.transactions).toEqual([
      { stores: ['snapshots', 'snapshot_data'], mode: 'readwrite' },
    ]);
    await expect(fake.stores.get('snapshots')!.get('s1')).resolves.toMatchObject({ id: 's1' });
    await expect(fake.stores.get('snapshot_data')!.get('s1')).resolves.toEqual(blob);
  });

  it('reads a snapshot and its blob together', async () => {
    const db = new IdbDatabase();
    await db.open();
    const blob = new Uint8Array([9]);
    await db.putSnapshot(snapshot('s1', 'c1', 7), blob);

    const result = await db.getSnapshot('s1');
    expect(result).toBeDefined();
    expect(result!.meta).toMatchObject({ id: 's1', conversationId: 'c1' });
    expect(result!.data).toEqual(blob);
  });

  it('returns undefined when snapshot metadata is missing', async () => {
    const db = new IdbDatabase();
    await db.open();
    await expect(db.getSnapshot('missing')).resolves.toBeUndefined();
  });

  it('returns undefined when the snapshot blob is missing', async () => {
    const db = new IdbDatabase();
    await db.open();
    await db.putSnapshotMeta(snapshot('s1', 'c1', 7));
    await expect(db.getSnapshot('s1')).resolves.toBeUndefined();
  });

  it('puts and gets snapshot metadata only', async () => {
    const db = new IdbDatabase();
    await db.open();
    await db.putSnapshotMeta(snapshot('s1', 'c1', 7));
    await expect(db.getSnapshotMeta('s1')).resolves.toMatchObject({ id: 's1' });
    await expect(db.getSnapshotMeta('missing')).resolves.toBeUndefined();
  });

  it('deletes snapshot metadata and blob in one transaction', async () => {
    const db = new IdbDatabase();
    await db.open();
    await db.putSnapshot(snapshot('s1', 'c1', 7), new Uint8Array([1]));
    await db.deleteSnapshot('s1');

    const fake = dbs[0]!;
    expect(fake.transactions.at(-1)).toEqual({
      stores: ['snapshots', 'snapshot_data'],
      mode: 'readwrite',
    });
    await expect(db.getSnapshotMeta('s1')).resolves.toBeUndefined();
    await expect(db.getSnapshotData('s1')).resolves.toBeUndefined();
  });

  it('lists snapshots for a conversation newest-first', async () => {
    const db = new IdbDatabase();
    await db.open();
    await db.putSnapshotMeta(snapshot('s1', 'c1', 1));
    await db.putSnapshotMeta(snapshot('s2', 'c1', 5));
    await db.putSnapshotMeta(snapshot('s3', 'c2', 9));

    await expect(db.listSnapshotsByConversation('c1')).resolves.toMatchObject([
      { id: 's2' },
      { id: 's1' },
    ]);
  });

  it('lists every snapshot', async () => {
    const db = new IdbDatabase();
    await db.open();
    await db.putSnapshotMeta(snapshot('s1', 'c1', 1));
    await db.putSnapshotMeta(snapshot('s2', 'c2', 2));
    await expect(db.listSnapshots()).resolves.toHaveLength(2);
  });

  it('puts, gets, and deletes snapshot blobs', async () => {
    const db = new IdbDatabase();
    await db.open();
    await db.putSnapshotData('s1', new Uint8Array([4, 5]));
    await expect(db.getSnapshotData('s1')).resolves.toEqual(new Uint8Array([4, 5]));
    await db.deleteSnapshotData('s1');
    await expect(db.getSnapshotData('s1')).resolves.toBeUndefined();
  });

  it('puts and gets settings by explicit key', async () => {
    const db = new IdbDatabase();
    await db.open();
    await db.setSetting('agent-config', { modelId: 'qwen2.5-3b' });
    await expect(db.getSetting<{ modelId: string }>('agent-config')).resolves.toEqual({
      modelId: 'qwen2.5-3b',
    });
    await expect(db.getSetting('missing')).resolves.toBeUndefined();
  });
});
