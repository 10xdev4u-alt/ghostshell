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

  async setSetting(key: string, value: unknown): Promise<void> {
    await this.ready().put('settings', value, key);
  }

  async getSetting<T>(key: string): Promise<T | undefined> {
    return (await this.ready().get('settings', key)) as T | undefined;
  }
}
