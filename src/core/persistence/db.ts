import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Conversation, Database, VMSnapshot } from '@/types/index.js';

/**
 * IndexedDB schema (5 stores):
 *  - conversations : Conversation records
 *  - snapshots     : VM snapshot metadata
 *  - snapshot_data : snapshot binary blobs (Uint8Array)
 *  - settings      : key/value app settings
 *  - models        : cached model metadata
 *
 * OPFS is preferred for large blobs; IndexedDB is the fallback. See
 * docs/ENGINEERING_PLAN.md §3.5.
 */

const DB_NAME = 'ghostshell';
const DB_VERSION = 1;

interface GhostShellDB extends DBSchema {
  conversations: {
    key: string;
    value: Conversation;
    indexes: { 'by-updated': number };
  };
  snapshots: {
    key: string;
    value: VMSnapshot;
    indexes: { 'by-conversation': string };
  };
  snapshot_data: {
    key: string;
    value: Uint8Array;
  };
  settings: {
    key: string;
    value: unknown;
  };
  models: {
    key: string;
    value: unknown;
  };
}

export class IdbDatabase implements Database {
  private db: IDBPDatabase<GhostShellDB> | null = null;

  async open(): Promise<void> {
    this.db = await openDB<GhostShellDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const conversations = db.createObjectStore('conversations', { keyPath: 'id' });
        conversations.createIndex('by-updated', 'updatedAt');
        const snapshots = db.createObjectStore('snapshots', { keyPath: 'id' });
        snapshots.createIndex('by-conversation', 'conversationId');
        db.createObjectStore('snapshot_data');
        db.createObjectStore('settings');
        db.createObjectStore('models');
      },
    });
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
  }

  private ready(): IDBPDatabase<GhostShellDB> {
    if (!this.db) throw new Error('Database not opened');
    return this.db;
  }

  async putConversation(c: Conversation): Promise<void> {
    await this.ready().put('conversations', c);
  }

  async getConversation(id: string): Promise<Conversation | undefined> {
    return this.ready().get('conversations', id);
  }

  async listConversations(): Promise<Conversation[]> {
    const all = await this.ready().getAllFromIndex('conversations', 'by-updated');
    return all.reverse();
  }

  async deleteConversation(id: string): Promise<void> {
    await this.ready().delete('conversations', id);
  }

  async putSnapshot(s: VMSnapshot, data: Uint8Array): Promise<void> {
    const db = this.ready();
    const tx = db.transaction(['snapshots', 'snapshot_data'], 'readwrite');
    await tx.objectStore('snapshots').put(s);
    await tx.objectStore('snapshot_data').put(data, s.id);
    await tx.done;
  }

  async getSnapshot(id: string): Promise<{ meta: VMSnapshot; data: Uint8Array } | undefined> {
    const db = this.ready();
    const tx = db.transaction(['snapshots', 'snapshot_data'], 'readonly');
    const meta = await tx.objectStore('snapshots').get(id);
    if (!meta) return undefined;
    const data = await tx.objectStore('snapshot_data').get(id);
    await tx.done;
    return data ? { meta, data } : undefined;
  }

  /** Store snapshot metadata only (blob lives in OPFS). */
  async putSnapshotMeta(s: VMSnapshot): Promise<void> {
    await this.ready().put('snapshots', s);
  }

  /** Read snapshot metadata only. */
  async getSnapshotMeta(id: string): Promise<VMSnapshot | undefined> {
    return this.ready().get('snapshots', id);
  }

  /** Delete snapshot metadata and its IndexedDB blob (if any). */
  async deleteSnapshot(id: string): Promise<void> {
    const db = this.ready();
    const tx = db.transaction(['snapshots', 'snapshot_data'], 'readwrite');
    await tx.objectStore('snapshots').delete(id);
    await tx.objectStore('snapshot_data').delete(id);
    await tx.done;
  }

  /** List snapshot metadata for a conversation, newest first. */
  async listSnapshotsByConversation(conversationId: string): Promise<VMSnapshot[]> {
    const all = await this.ready().getAllFromIndex('snapshots', 'by-conversation', conversationId);
    return all.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** List every snapshot's metadata. */
  async listSnapshots(): Promise<VMSnapshot[]> {
    return this.ready().getAll('snapshots');
  }

  /** Store a snapshot blob in IndexedDB (fallback when OPFS is unavailable). */
  async putSnapshotData(id: string, data: Uint8Array): Promise<void> {
    await this.ready().put('snapshot_data', data, id);
  }

  /** Read a snapshot blob from IndexedDB. */
  async getSnapshotData(id: string): Promise<Uint8Array | undefined> {
    return this.ready().get('snapshot_data', id);
  }

  /** Delete a snapshot blob from IndexedDB. */
  async deleteSnapshotData(id: string): Promise<void> {
    await this.ready().delete('snapshot_data', id);
  }

  async setSetting(key: string, value: unknown): Promise<void> {
    await this.ready().put('settings', value, key);
  }

  async getSetting<T>(key: string): Promise<T | undefined> {
    return (await this.ready().get('settings', key)) as T | undefined;
  }
}
