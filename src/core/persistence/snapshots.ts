import type { Database, VMSnapshot } from '@/types/index.js';
import { uuid } from '@/lib/utils.js';

/**
 * VM snapshot manager.
 *
 * Snapshots are the foundation for time-travel / fork sessions. v0.1 stores
 * full v86 state images; v0.2 adds copy-on-write deltas over OPFS.
 */

export class SnapshotManager {
  constructor(private readonly db: Database) {}

  async capture(conversationId: string, data: Uint8Array, kind: VMSnapshot['kind'] = 'full'): Promise<VMSnapshot> {
    const snapshot: VMSnapshot = {
      id: uuid(),
      conversationId,
      createdAt: Date.now(),
      kind,
      sizeBytes: data.byteLength,
      stateRef: `snapshots/${uuid()}.bin`,
    };
    await this.db.putSnapshot(snapshot, data);
    return snapshot;
  }

  async load(id: string): Promise<{ meta: VMSnapshot; data: Uint8Array } | undefined> {
    return this.db.getSnapshot(id);
  }

  async listForConversation(conversationId: string): Promise<VMSnapshot[]> {
    // TODO: add an index query once Database exposes it.
    void conversationId;
    throw new Error('listForConversation not implemented (issue #19)');
  }
}
