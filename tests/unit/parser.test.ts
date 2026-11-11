import { describe, expect, it, vi } from 'vitest';
import { parseToolCalls, retryWithCorrection } from '@/core/agent/parser.js';

describe('parseToolCalls', () => {
  it('parses a grammar-constrained JSON object', () => {
    const result = parseToolCalls('{"tool_calls":[{"name":"bash","arguments":{"command":"ls"}}]}');
    expect(result.strategy).toBe('grammar');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.name).toBe('bash');
    expect(result.toolCalls[0]!.arguments).toEqual({ command: 'ls' });
  });

  it('parses Hermes-style XML', () => {
    const result = parseToolCalls('<tool_call>{"name":"read_file","arguments":{"path":"/etc"}}</tool_call>');
    expect(result.strategy).toBe('hermes');
    expect(result.toolCalls[0]!.name).toBe('read_file');
    expect(result.text).toBe('');
  });

  it('parses fenced json blocks', () => {
    const result = parseToolCalls('```json\n{"name":"search","arguments":{"pattern":"foo"}}\n```');
    expect(result.strategy).toBe('fenced');
    expect(result.toolCalls[0]!.name).toBe('search');
  });

  it('parses multiple Hermes calls', () => {
    const input =
      '<tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>' +
      '<tool_call>{"name":"bash","arguments":{"command":"pwd"}}</tool_call>';
    const result = parseToolCalls(input);
    expect(result.toolCalls).toHaveLength(2);
  });

  it('returns no calls for plain text', () => {
    const result = parseToolCalls('The task is done.');
    expect(result.strategy).toBe('none');
    expect(result.toolCalls).toHaveLength(0);
    expect(result.text).toBe('The task is done.');
  });

  it('handles string arguments', () => {
    const result = parseToolCalls('{"name":"bash","arguments":"{\\"command\\":\\"ls\\"}"}');
    expect(result.toolCalls[0]!.arguments).toEqual({ command: 'ls' });
  });
});

describe('retryWithCorrection', () => {
  it('makes no calls when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const generate = vi.fn(async () => ({ text: 'hello' }));

    const result = await retryWithCorrection(generate, [], 3, controller.signal);

    expect(result.aborted).toBe(true);
    expect(result.attempts).toBe(0);
    expect(generate).not.toHaveBeenCalled();
  });

  it('stops retrying when the signal aborts between attempts', async () => {
    const controller = new AbortController();
    const generate = vi.fn(async () => {
      controller.abort();
      return { text: 'not a tool call' };
    });

    const result = await retryWithCorrection(generate, [], 3, controller.signal);

    expect(result.aborted).toBe(true);
    expect(result.attempts).toBe(1);
    expect(generate).toHaveBeenCalledTimes(1);
  });
});
