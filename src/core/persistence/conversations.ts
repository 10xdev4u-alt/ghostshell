import type { Conversation, Database, Message } from '@/types/index.js';
import { uuid } from '@/lib/utils.js';

/**
 * Conversation repository. Thin wrapper over the Database port so the rest of
 * the app never touches IndexedDB directly.
 */

export class ConversationRepository {
  constructor(private readonly db: Database) {}

  async create(title = 'New session', modelId: string): Promise<Conversation> {
    const now = Date.now();
    const conversation: Conversation = {
      id: uuid(),
      title,
      messages: [],
      createdAt: now,
      updatedAt: now,
      modelId,
    };
    await this.db.putConversation(conversation);
    return conversation;
  }

  async get(id: string): Promise<Conversation | undefined> {
    return this.db.getConversation(id);
  }

  async list(): Promise<Conversation[]> {
    return this.db.listConversations();
  }

  async delete(id: string): Promise<void> {
    await this.db.deleteConversation(id);
  }

  async appendMessage(id: string, message: Message): Promise<Conversation> {
    const conversation = await this.db.getConversation(id);
    if (!conversation) throw new Error(`Conversation not found: ${id}`);
    conversation.messages.push(message);
    conversation.updatedAt = Date.now();
    await this.db.putConversation(conversation);
    return conversation;
  }

  async rename(id: string, title: string): Promise<void> {
    const conversation = await this.db.getConversation(id);
    if (!conversation) throw new Error(`Conversation not found: ${id}`);
    conversation.title = title;
    conversation.updatedAt = Date.now();
    await this.db.putConversation(conversation);
  }
}
