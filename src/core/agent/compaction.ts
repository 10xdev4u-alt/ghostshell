import type { Message } from '@/types/index.js';

/**
 * Context-window management.
 *
 * Local models have a small context (4k in v0.1). When the conversation
 * exceeds the budget, older messages are summarized into a single
 * `system` message. Tool results are the first thing to go.
 */

export interface CompactionResult {
  messages: Message[];
  compacted: boolean;
  removed: number;
}

export function estimateTokens(text: string): number {
  // Rough heuristic: ~4 chars per token for English/code.
  return Math.ceil(text.length / 4);
}

export function compactMessages(
  messages: Message[],
  maxTokens: number,
  summarize: (messages: Message[]) => Promise<string>,
): Promise<CompactionResult> {
  // TODO: implement sliding-window compaction.
  //  1. Always keep the system message(s).
  //  2. Drop oldest tool results first.
  //  3. Summarize dropped turns into one system message.
  //  4. Stop when total tokens <= maxTokens.
  return Promise.resolve({ messages, compacted: false, removed: 0 });
}

export function tokenBudget(messages: Message[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
}
