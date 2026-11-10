import type { Conversation, Database, PrivacyReport } from '@/types/index.js';

/**
 * Export / import sessions.
 *
 * Format: a single JSON file with a versioned envelope. Binary snapshot data
 * is base64-encoded. Import validates the envelope before writing.
 */

export const EXPORT_VERSION = 1;

export interface ExportEnvelope {
  version: number;
  kind: 'ghostshell-export';
  exportedAt: number;
  conversations: Conversation[];
  reports?: PrivacyReport[];
}

export function buildExport(conversations: Conversation[]): ExportEnvelope {
  return {
    version: EXPORT_VERSION,
    kind: 'ghostshell-export',
    exportedAt: Date.now(),
    conversations,
  };
}

export function serializeExport(envelope: ExportEnvelope): string {
  return JSON.stringify(envelope, null, 2);
}

export function parseExport(json: string): ExportEnvelope {
  const parsed = JSON.parse(json) as ExportEnvelope;
  if (parsed.kind !== 'ghostshell-export') {
    throw new Error('Not a GhostShell export file');
  }
  if (parsed.version !== EXPORT_VERSION) {
    throw new Error(`Unsupported export version: ${parsed.version}`);
  }
  return parsed;
}

export async function importExport(json: string, db: Database): Promise<number> {
  const envelope = parseExport(json);
  for (const conversation of envelope.conversations) {
    await db.putConversation(conversation);
  }
  return envelope.conversations.length;
}
