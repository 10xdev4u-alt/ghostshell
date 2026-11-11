import type { Message } from '@/types/index.js';
import { uuid } from '@/lib/utils.js';

/**
 * Context-window management.
 *
 * Local models have a small context (4k in v0.1). When the conversation
 * exceeds the budget, older messages are summarized into a single
 * `system` message.
 *
 * Sacrifice order (what is dropped or truncated, in order):
 *  1. Tool-result messages (`tool` messages and assistant messages carrying
 *     `toolResults`), oldest first.
 *  2. Other non-system messages, oldest first.
 *  3. The generated summary: truncated to the remaining budget, then dropped
 *     entirely when no room remains.
 *  4. The current request (most recent message): truncated to fit, then
 *     dropped when no part of it can fit.
 *  5. System messages: never dropped; truncated only in the pathological case
 *     where they alone exceed the budget.
 *
 * The returned list never exceeds `maxTokens` when the budget is positive.
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
  signal?: AbortSignal,
): Promise<CompactionResult> {
  if (tokenBudget(messages) <= maxTokens) {
    return { messages, compacted: false, removed: 0 };
  }
  // An aborted run is finishing; leave the conversation untouched rather than
  // spending a summarization call on it.
  if (signal?.aborted) {
    return { messages, compacted: false, removed: 0 };
  }

  const systems = messages.filter(isSystem);
  const kept = messages.filter((message) => !isSystem(message));
  const dropped: Message[] = [];

  // The most recent message is the current request; it is not a drop
  // candidate until the summary has been truncated or dropped.
  const candidates = kept.slice(0, Math.max(0, kept.length - 1));
  const ordered = [
    ...candidates.filter(isToolResult),
    ...candidates.filter((message) => !isToolResult(message)),
  ];

  const fitsWith = (summaryTokens: number): boolean =>
    tokenBudget(systems) + tokenBudget(kept) + summaryTokens <= maxTokens;

  // Drop until the retained conversation leaves room for the worst-case
  // summary. The current request is never a candidate here.
  for (const candidate of ordered) {
    if (fitsWith(SUMMARY_HEADROOM_TOKENS)) break;
    const index = kept.indexOf(candidate);
    if (index === -1) continue;
    kept.splice(index, 1);
    dropped.push(candidate);
  }

  // Summarize what was dropped, then fit the real summary by truncating it to
  // the remaining budget or dropping it entirely. When the run aborts, return
  // undefined so no spurious "Earlier conversation omitted." message is
  // inserted into the conversation.
  const summarizeDropped = async (): Promise<string | undefined> => {
    if (signal?.aborted) return undefined;
    const summary = (await summarize(dropped)).trim();
    return signal?.aborted ? undefined : summary || 'Earlier conversation omitted.';
  };

  let summaryMessage: Message | undefined;
  if (dropped.length > 0) {
    const summary = await summarizeDropped();
    if (summary !== undefined) {
      summaryMessage = makeSummaryMessage(summary);
      const remaining = maxTokens - tokenBudget(systems) - tokenBudget(kept);
      if (remaining <= 0) {
        summaryMessage = undefined;
      } else {
        summaryMessage = truncateMessageToTokens(summaryMessage, remaining);
      }
    }
  }

  // If the retained messages alone still exceed the budget, shrink the
  // current request. Dropping it is the last resort; when it is dropped,
  // regenerate the summary so the request is not lost.
  if (tokenBudget(systems) + tokenBudget(kept) > maxTokens && kept.length > 0) {
    const current = kept[kept.length - 1]!;
    const remaining = maxTokens - tokenBudget(systems) - tokenBudget(kept.slice(0, -1));
    if (remaining > 0) {
      kept[kept.length - 1] = truncateMessageToTokens(current, remaining);
    } else {
      kept.pop();
      dropped.push(current);
      const room = maxTokens - tokenBudget(systems) - tokenBudget(kept);
      if (room > 0) {
        const summary = await summarizeDropped();
        if (summary !== undefined) {
          summaryMessage = truncateMessageToTokens(makeSummaryMessage(summary), room);
        }
      }
    }
  }

  // Pathological: the original system prompt alone exceeds the budget.
  // Truncate system messages (never drop the prompt entirely unless even an
  // empty message cannot fit).
  while (tokenBudget(systems) > maxTokens && systems.length > 0) {
    const last = systems[systems.length - 1]!;
    const remaining = maxTokens - tokenBudget(systems.slice(0, -1));
    if (remaining > 0) {
      systems[systems.length - 1] = truncateMessageToTokens(last, remaining);
      break;
    }
    systems.pop();
  }

  return {
    messages: [...systems, ...(summaryMessage ? [summaryMessage] : []), ...kept],
    compacted: true,
    removed: dropped.length,
  };
}

function makeSummaryMessage(summary: string): Message {
  return {
    id: uuid(),
    role: 'system',
    content: `${SUMMARY_PREFIX}${summary}`,
    timestamp: Date.now(),
  };
}

/**
 * Return a copy of `message` whose content fits in `maxTokens`, or the
 * original message when it already fits. `estimateTokens` uses ~4 chars per
 * token, so the character cap is `maxTokens * 4`.
 */
function truncateMessageToTokens(message: Message, maxTokens: number): Message {
  if (estimateTokens(message.content) <= maxTokens) return message;
  const maxChars = Math.max(0, maxTokens * 4);
  return { ...message, content: message.content.slice(0, maxChars) };
}
