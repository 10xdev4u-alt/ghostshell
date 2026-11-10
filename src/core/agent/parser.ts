import type { ToolCall } from '@/types/index.js';
import { uuid } from '@/lib/utils.js';

/**
 * Tool-call parser.
 *
 * Strategy order (see creative-innovation report §6.1):
 *   1. Grammar-constrained JSON  (guaranteed valid; preferred)
 *   2. Hermes-style <tool_call> XML
 *   3. Fenced ```json blocks
 *   4. Corrective retry prompt
 *
 * The parser is tolerant because 1.5B–3B models are unreliable at strict
 * schemas. Every strategy is attempted before giving up.
 */

export interface ParseResult {
  toolCalls: ToolCall[];
  text: string;
  strategy: 'grammar' | 'hermes' | 'fenced' | 'none';
}

export function parseToolCalls(raw: string): ParseResult {
  const trimmed = raw.trim();

  // 1. Grammar-constrained: the model was forced to emit a JSON object.
  const grammar = tryJson(trimmed);
  if (grammar) return grammar;

  // 2. Hermes-style XML: <tool_call>{"name": "...", "arguments": {...}}</tool_call>
  const hermes = tryHermes(trimmed);
  if (hermes) return hermes;

  // 3. Fenced json block.
  const fenced = tryFenced(trimmed);
  if (fenced) return fenced;

  return { toolCalls: [], text: raw, strategy: 'none' };
}

function tryJson(input: string): ParseResult | undefined {
  try {
    const parsed = JSON.parse(input) as unknown;
    const calls = extractCalls(parsed);
    if (calls.length > 0) {
      return { toolCalls: calls, text: '', strategy: 'grammar' };
    }
  } catch {
    /* not JSON */
  }
  return undefined;
}

function tryHermes(input: string): ParseResult | undefined {
  const re = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  const calls: ToolCall[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(input)) !== null) {
    try {
      const parsed = JSON.parse(match[1]!) as unknown;
      calls.push(...extractCalls(parsed));
    } catch {
      /* skip malformed */
    }
  }
  if (calls.length === 0) return undefined;
  const text = input.replace(re, '').trim();
  return { toolCalls: calls, text, strategy: 'hermes' };
}

function tryFenced(input: string): ParseResult | undefined {
  const re = /```(?:json)?\s*([\s\S]*?)```/g;
  const calls: ToolCall[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(input)) !== null) {
    try {
      const parsed = JSON.parse(match[1]!) as unknown;
      calls.push(...extractCalls(parsed));
    } catch {
      /* skip malformed */
    }
  }
  if (calls.length === 0) return undefined;
  const text = input.replace(re, '').trim();
  return { toolCalls: calls, text, strategy: 'fenced' };
}

function extractCalls(parsed: unknown): ToolCall[] {
  if (!parsed || typeof parsed !== 'object') return [];
  const obj = parsed as Record<string, unknown>;
  const list = Array.isArray(obj['tool_calls'])
    ? (obj['tool_calls'] as unknown[])
    : Array.isArray(obj['calls'])
      ? (obj['calls'] as unknown[])
      : [parsed];

  const calls: ToolCall[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const name = String(rec['name'] ?? rec['tool'] ?? '');
    if (!name) continue;
    const argsRaw = (rec['arguments'] ?? rec['args'] ?? rec['parameters'] ?? {}) as unknown;
    const args =
      typeof argsRaw === 'string' ? safeJson(argsRaw) : (argsRaw as Record<string, unknown>);
    calls.push({ id: uuid(), name, arguments: args ?? {}, raw: JSON.stringify(rec) });
  }
  return calls;
}

function safeJson(input: string): Record<string, unknown> {
  try {
    const v = JSON.parse(input) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
