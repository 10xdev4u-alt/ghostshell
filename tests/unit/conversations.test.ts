import { describe, expect, it, vi } from 'vitest';
import type { Conversation, Database, Message } from '@/types/index.js';
import { ConversationRepository } from '@/core/persistence/conversations.js';

function makeDb() {
  const conversations = new Map<string, Conversation>();
  const db = {
    putConversation: vi.fn(async (conversation: Conversation) => {
      conversations.set(conversation.id, conversation);
    }),
    getConversation: vi.fn(async (id: string) => conversations.get(id)),
    listConversations: vi.fn(async () => [...conversations.values()]),
    deleteConversation: vi.fn(async (id: string) => {
      conversations.delete(id);
    }),
  };
  return { db: db as unknown as Database, conversations };
}

function makeMessage(content: string): Message {
  return { id: 'm1', role: 'user', content, timestamp: 1 };
}

describe('ConversationRepository', () => {
  it('creates a conversation with a default title and persists it', async () => {
    const { db, conversations } = makeDb();
    const repo = new ConversationRepository(db);

    const conversation = await repo.create(undefined, 'model-1');

    expect(conversation.title).toBe('New session');
    expect(conversation.modelId).toBe('model-1');
    expect(conversation.messages).toEqual([]);
    expect(conversation.createdAt).toBe(conversation.updatedAt);
    expect(conversations.get(conversation.id)).toBe(conversation);
    expect(db.putConversation).toHaveBeenCalledOnce();
  });

  it('creates a conversation with an explicit title', async () => {
    const { db } = makeDb();
    const repo = new ConversationRepository(db);

    const conversation = await repo.create('My session', 'model-1');

    expect(conversation.title).toBe('My session');
  });

  it('gets a stored conversation and returns undefined for a missing one', async () => {
    const { db } = makeDb();
    const repo = new ConversationRepository(db);
    const conversation = await repo.create('Stored', 'model-1');

    await expect(repo.get(conversation.id)).resolves.toBe(conversation);
    await expect(repo.get('missing')).resolves.toBeUndefined();
  });

  it('lists every stored conversation', async () => {
    const { db } = makeDb();
    const repo = new ConversationRepository(db);
    const first = await repo.create('First', 'model-1');
    const second = await repo.create('Second', 'model-1');

    await expect(repo.list()).resolves.toEqual([first, second]);
  });

  it('deletes a stored conversation', async () => {
    const { db, conversations } = makeDb();
    const repo = new ConversationRepository(db);
    const conversation = await repo.create('Doomed', 'model-1');

    await repo.delete(conversation.id);

    expect(conversations.has(conversation.id)).toBe(false);
    expect(db.deleteConversation).toHaveBeenCalledWith(conversation.id);
  });

  it('appends a message and bumps updatedAt', async () => {
    const { db } = makeDb();
    const repo = new ConversationRepository(db);
    const conversation = await repo.create('Chat', 'model-1');
    const message = makeMessage('hello');

    const updated = await repo.appendMessage(conversation.id, message);

    expect(updated.messages).toEqual([message]);
    expect(updated.updatedAt).toBeGreaterThanOrEqual(conversation.updatedAt);
    expect(db.putConversation).toHaveBeenCalledWith(updated);
  });

  it('refuses to append to a missing conversation', async () => {
    const { db } = makeDb();
    const repo = new ConversationRepository(db);

    await expect(repo.appendMessage('missing', makeMessage('hello'))).rejects.toThrow(
      'Conversation not found: missing',
    );
  });

  it('renames a conversation and bumps updatedAt', async () => {
    const { db } = makeDb();
    const repo = new ConversationRepository(db);
    const conversation = await repo.create('Old title', 'model-1');

    await repo.rename(conversation.id, 'New title');

    const renamed = await repo.get(conversation.id);
    expect(renamed!.title).toBe('New title');
    expect(renamed!.updatedAt).toBeGreaterThanOrEqual(conversation.updatedAt);
    expect(db.putConversation).toHaveBeenCalledWith(renamed);
  });

  it('refuses to rename a missing conversation', async () => {
    const { db } = makeDb();
    const repo = new ConversationRepository(db);

    await expect(repo.rename('missing', 'New title')).rejects.toThrow(
      'Conversation not found: missing',
    );
  });
});
