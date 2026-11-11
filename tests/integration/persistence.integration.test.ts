import { describe, expect, it } from 'vitest';
import type { Conversation, Database, Message, VMSnapshot } from '@/types/index.js';
import { uuid } from '@/lib/utils.js';
import { ConversationRepository } from '@/core/persistence/conversations.js';
import { SnapshotManager } from '@/core/persistence/snapshots.js';

// ---------------------------------------------------------------------------
// Fake database
// ---------------------------------------------------------------------------

/**
 * A plain `Database` with no OPFS-specific accessors. It stores deep copies so
 * a "reload" really goes through the persistence boundary, and it exercises
 * the base `deleteSnapshot` contract from issue #54.
 */
class FakeDatabase implements Database {
  private readonly conversations = new Map<string, Conversation>();
  private readonly snapshots = new Map<string, VMSnapshot>();
  private readonly snapshotData = new Map<string, Uint8Array>();

  async open(): Promise<void> {}
  async close(): Promise<void> {}

  async putConversation(c: Conversation): Promise<void> {
    this.conversations.set(c.id, structuredClone(c));
  }

  async getConversation(id: string): Promise<Conversation | undefined> {
    const found = this.conversations.get(id);
    return found === undefined ? undefined : structuredClone(found);
  }

  async listConversations(): Promise<Conversation[]> {
    return [...this.conversations.values()].map((c) => structuredClone(c));
  }

  async deleteConversation(id: string): Promise<void> {
    this.conversations.delete(id);
  }

  async putSnapshot(s: VMSnapshot, data: Uint8Array): Promise<void> {
    this.snapshots.set(s.id, structuredClone(s));
    this.snapshotData.set(s.id, data.slice());
  }

  async getSnapshot(id: string): Promise<{ meta: VMSnapshot; data: Uint8Array } | undefined> {
    const meta = this.snapshots.get(id);
    const data = this.snapshotData.get(id);
    if (!meta || !data) return undefined;
    return { meta: structuredClone(meta), data: data.slice() };
  }

  async deleteSnapshot(id: string): Promise<void> {
    this.snapshots.delete(id);
    this.snapshotData.delete(id);
  }

  async setSetting(_key: string, _value: unknown): Promise<void> {}

  async getSetting<T>(_key: string): Promise<T | undefined> {
    return undefined;
  }

  hasSnapshot(id: string): boolean {
    return this.snapshots.has(id);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessage(role: Message['role'], content: string): Message {
  return { id: uuid(), role, content, timestamp: 1 };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('persistence integration', () => {
  it('persists conversations and their messages across a reload', async () => {
    const db = new FakeDatabase();
    const repo = new ConversationRepository(db);

    const created = await repo.create('Integration session', 'fake-model');
    await repo.appendMessage(created.id, makeMessage('user', 'read the file'));
    await repo.appendMessage(created.id, makeMessage('assistant', 'the file says hello'));

    const reloaded = await repo.get(created.id);
    expect(reloaded).toBeDefined();
    expect(reloaded!.id).toBe(created.id);
    expect(reloaded!.messages).toHaveLength(2);
    expect(reloaded!.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(reloaded!.messages[0]!.content).toBe('read the file');
    expect(reloaded!.messages[1]!.content).toBe('the file says hello');
    expect(reloaded!.messages[0]!.id).toBeTruthy();
    expect(reloaded!.messages[1]!.id).toBeTruthy();

    // The conversation is listed with its persisted messages.
    const listed = await repo.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.id).toBe(created.id);
    expect(listed[0]!.messages).toHaveLength(2);
  });

  it('captures a snapshot and loads the same bytes', async () => {
    const db = new FakeDatabase();
    const manager = new SnapshotManager(db);
    const bytes = new Uint8Array([0, 1, 2, 3, 250, 251, 252]);

    const snapshot = await manager.capture('c1', bytes);

    expect(snapshot.conversationId).toBe('c1');
    expect(snapshot.kind).toBe('full');
    expect(snapshot.sizeBytes).toBe(bytes.byteLength);
    expect(snapshot.stateRef).toBe(`idb:${snapshot.id}`);

    const loaded = await manager.load(snapshot.id);
    expect(loaded).toBeDefined();
    expect(loaded!.meta.id).toBe(snapshot.id);
    expect(loaded!.meta.conversationId).toBe('c1');
    expect(loaded!.data).toBeInstanceOf(Uint8Array);
    expect(loaded!.data).toEqual(bytes);
    expect(Array.from(loaded!.data)).toEqual([0, 1, 2, 3, 250, 251, 252]);
  });

  it('deletes a snapshot so it can no longer be loaded', async () => {
    const db = new FakeDatabase();
    const manager = new SnapshotManager(db);
    const snapshot = await manager.capture('c1', new Uint8Array([1, 2, 3]));
    expect(await manager.load(snapshot.id)).toBeDefined();

    await manager.delete(snapshot.id);

    expect(await manager.load(snapshot.id)).toBeUndefined();
    expect(db.hasSnapshot(snapshot.id)).toBe(false);
  });
});
