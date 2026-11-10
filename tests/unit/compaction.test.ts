import { describe, expect, it } from 'vitest';
import type { Message, MessageRole } from '@/types/index.js';
import { uuid } from '@/lib/utils.js';
import { compactMessages, estimateTokens, tokenBudget } from '@/core/agent/compaction.js';

function message(role: MessageRole, content: string, extra?: Partial<Message>): Message {
  return { id: uuid(), role, content, timestamp: 1, ...extra };
}

describe('compaction', () => {
  it('estimates tokens heuristically', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });

  it('counts tool calls and tool results in the budget', () => {
    const bare = message('assistant', '');
    const withResults = message('assistant', '', {
      toolCalls: [{ id: '1', name: 'bash', arguments: { command: 'ls' }, raw: '{"name":"bash"}' }],
      toolResults: [{ ok: true, content: 'x'.repeat(400) }],
    });

    expect(tokenBudget([withResults])).toBeGreaterThan(tokenBudget([bare]));
    expect(tokenBudget([withResults])).toBeGreaterThanOrEqual(100);
  });

  it('leaves conversations under budget untouched', async () => {
    const messages = [message('system', 'system prompt'), message('user', 'hi')];
    const result = await compactMessages(messages, 1000, async () => 'summary');

    expect(result.compacted).toBe(false);
    expect(result.removed).toBe(0);
    expect(result.messages).toBe(messages);
  });

  it('drops oldest tool results first and inserts a summary system message', async () => {
    const toolMessage = message('assistant', 'running tests', {
      toolCalls: [
        { id: '1', name: 'bash', arguments: { command: 'pytest' }, raw: '{"name":"bash"}' },
      ],
      toolResults: [{ ok: true, content: 'x'.repeat(2000) }],
    });
    const messages = [
      message('system', 'system prompt'),
      message('user', 'old question'),
      toolMessage,
      message('user', 'newer question'),
      message('assistant', 'final answer'),
    ];

    const result = await compactMessages(messages, 400, async () => 'summary text');

    expect(result.compacted).toBe(true);
    expect(result.removed).toBe(1);
    expect(result.messages).toHaveLength(5);
    expect(result.messages[0]!.role).toBe('system');
    expect(result.messages[0]!.content).toBe('system prompt');
    expect(result.messages[1]!.role).toBe('system');
    expect(result.messages[1]!.content).toContain('Summary of earlier conversation');
    expect(result.messages[1]!.content).toContain('summary text');
    // The old user message survives because tool results are dropped first.
    expect(result.messages.some((m) => m.content === 'old question')).toBe(true);
    expect(result.messages.some((m) => m === toolMessage)).toBe(false);
    expect(tokenBudget(result.messages)).toBeLessThanOrEqual(400);
  });

  it('never exceeds the budget when the summary is large', async () => {
    const messages = [
      message('system', 'sys'),
      message('user', 'a'.repeat(400)),
      message('assistant', 'b'.repeat(400)),
      message('user', 'c'.repeat(400)),
      message('user', 'd'.repeat(40)),
    ];

    const result = await compactMessages(messages, 250, async () => 's'.repeat(800));

    expect(result.compacted).toBe(true);
    expect(tokenBudget(result.messages)).toBeLessThanOrEqual(250);
  });

  it('keeps the current request when it is the only droppable-adjacent message', async () => {
    const messages = [message('system', 'x'.repeat(400)), message('user', 'y'.repeat(400))];
    const result = await compactMessages(messages, 100, async () => 'summary');

    expect(result.compacted).toBe(false);
    expect(result.removed).toBe(0);
  });

  it('summarizes every dropped message exactly once', async () => {
    const dropped: Message[][] = [];
    const messages = [
      message('system', 'sys'),
      message('user', 'first'),
      message('assistant', 'second'),
      message('user', 'third'),
      message('assistant', 'fourth'),
    ];

    await compactMessages(messages, 8, async (batch) => {
      dropped.push(batch);
      return 'compressed';
    });

    expect(dropped).toHaveLength(1);
    const summarized = dropped[0]!.map((m) => m.content);
    expect(summarized).toContain('first');
    expect(summarized).toContain('second');
    // The most recent message is never dropped.
    expect(summarized).not.toContain('fourth');
  });
});
