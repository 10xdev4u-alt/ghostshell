import type { Message } from '@/types/index.js';
import { uuid } from '@/lib/utils.js';

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

/**
 * Tokens reserved for the summary message itself. Dropping stops once the
 * retained conversation fits in `maxTokens - SUMMARY_HEADROOM_TOKENS`, so the
 * summary can be inserted without immediately exceeding the budget again.
 */
const SUMMARY_HEADROOM_TOKENS = 128;

export function estimateTokens(text: string): number {
  // Rough heuristic: ~4 chars per token for English/code.
  return Math.ceil(text.length / 4);
}

/** Token estimate for a single message, including its tool calls and results. */
export function messageTokens(message: Message): number {
  let tokens = estimateTokens(message.content);
  for (const call of message.toolCalls ?? []) tokens += estimateTokens(call.raw);
  for (const result of message.toolResults ?? []) tokens += estimateTokens(result.content);
  return tokens;
}

export function tokenBudget(messages: Message[]): number {
  return messages.reduce((sum, message) => sum + messageTokens(message), 0);
}

function isSystem(message: Message): boolean {
  return message.role === 'system';
}

/** A message that carries tool output (either a `tool` message or an assistant message with results). */
function isToolResult(message: Message): boolean {
  return message.role === 'tool' || (message.toolResults?.length ?? 0) > 0;
}

export async function compactMessages(
  messages: Message[],
  maxTokens: number,
  summarize: (messages: Message[]) => Promise<string>,
): Promise<CompactionResult> {
  if (tokenBudget(messages) <= maxTokens) {
    return { messages, compacted: false, removed: 0 };
  }

  const systems = messages.filter(isSystem);
  const kept = messages.filter((message) => !isSystem(message));
  const dropped: Message[] = [];

  // The most recent message is the current request; never drop it.
  const candidates = kept.slice(0, Math.max(0, kept.length - 1));
  const ordered = [
    ...candidates.filter(isToolResult),
    ...candidates.filter((message) => !isToolResult(message)),
  ];

  const fits = (): boolean =>
    tokenBudget(systems) + tokenBudget(kept) + SUMMARY_HEADROOM_TOKENS <= maxTokens;

  for (const candidate of ordered) {
    if (fits()) break;
    const index = kept.indexOf(candidate);
    if (index === -1) continue;
    kept.splice(index, 1);
    dropped.push(candidate);
  }

  if (dropped.length === 0) {
    // Nothing droppable (only system messages plus the current request).
    return { messages, compacted: false, removed: 0 };
  }

  const summary = (await summarize(dropped)).trim() || 'Earlier conversation omitted.';
  const summaryMessage: Message = {
    id: uuid(),
    role: 'system',
    content: `Summary of earlier conversation:\n${summary}`,
    timestamp: Date.now(),
  };

  return {
    messages: [...systems, summaryMessage, ...kept],
    compacted: true,
    removed: dropped.length,
  };
}
