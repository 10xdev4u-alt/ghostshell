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

/** The summary body is capped at this many tokens (mirrors the loop's request). */
export const SUMMARY_MAX_TOKENS = 300;

const SUMMARY_PREFIX = 'Summary of earlier conversation:\n';

export function estimateTokens(text: string): number {
  // Rough heuristic: ~4 chars per token for English/code.
  return Math.ceil(text.length / 4);
}

/**
 * Tokens reserved for the summary message while dropping. The summary body is
 * capped at `SUMMARY_MAX_TOKENS` and the prefix adds a few more, so the
 * headroom must cover both or compaction can exceed the budget again.
 */
const SUMMARY_HEADROOM_TOKENS = SUMMARY_MAX_TOKENS + estimateTokens(SUMMARY_PREFIX);

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

  const fitsWith = (summaryTokens: number): boolean =>
    tokenBudget(systems) + tokenBudget(kept) + summaryTokens <= maxTokens;

  // Drop until the retained conversation leaves room for the worst-case summary.
  for (const candidate of ordered) {
    if (fitsWith(SUMMARY_HEADROOM_TOKENS)) break;
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
    content: `${SUMMARY_PREFIX}${summary}`,
    timestamp: Date.now(),
  };

  // The summary is capped, but a model may overrun its token budget. Drop
  // further old messages until the real summary fits, so the result never
  // exceeds maxTokens when there is anything left to drop. Those extra drops
  // are not covered by the summary; they are already past the compaction point.
  for (const candidate of ordered) {
    if (fitsWith(messageTokens(summaryMessage))) break;
    const index = kept.indexOf(candidate);
    if (index === -1) continue;
    kept.splice(index, 1);
    dropped.push(candidate);
  }

  return {
    messages: [...systems, summaryMessage, ...kept],
    compacted: true,
    removed: dropped.length,
  };
}
