import { describe, expect, it, vi } from 'vitest';
import {
  buildExport,
  importExport,
  parseExport,
  serializeExport,
} from '@/core/persistence/export.js';
import type { Conversation, Database } from '@/types/index.js';

function makeConversation(): Conversation {
  return {
    id: 'c1',
    title: 'Test',
    messages: [],
    createdAt: 1,
    updatedAt: 2,
    modelId: 'qwen2.5-1.5b',
  };
}

describe('export', () => {
  it('round-trips conversations', () => {
    const envelope = buildExport([makeConversation()]);
    const json = serializeExport(envelope);
    const parsed = parseExport(json);
    expect(parsed.conversations).toHaveLength(1);
    expect(parsed.conversations[0]!.id).toBe('c1');
  });

  it('rejects non-ghostshell files', () => {
    expect(() => parseExport('{"kind":"other"}')).toThrow('Not a GhostShell export');
  });

  it('rejects unsupported versions', () => {
    expect(() => parseExport('{"kind":"ghostshell-export","version":99}')).toThrow(
      'Unsupported export version',
    );
  });

  it('imports every conversation into the database', async () => {
    const putConversation = vi.fn(async () => {});
    const db = { putConversation } as unknown as Database;

    const count = await importExport(serializeExport(buildExport([makeConversation()])), db);

    expect(count).toBe(1);
    expect(putConversation).toHaveBeenCalledOnce();
  });

  it('rejects an import that is not a GhostShell export', async () => {
    const db = { putConversation: vi.fn(async () => {}) } as unknown as Database;

    await expect(importExport('{"kind":"other"}', db)).rejects.toThrow('Not a GhostShell export');
  });
});
