import type { Message, ToolCall } from '@/types/index.js';
import { uuid } from '@/lib/utils.js';
import { CORRECTIVE_RETRY_PROMPT, CONTINUE_PROMPT } from './prompts.js';

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

/** The minimal shape the parser needs from one LLM turn. */
export interface GenerateOutcome {
  text: string;
  toolCalls?: ToolCall[] | undefined;
  aborted?: boolean | undefined;
}

export interface CorrectionResult {
  /** The conversation after the final attempt, including any correction messages. */
  messages: Message[];
  parse: ParseResult;
  /** Number of LLM calls made (1 = no retries were needed). */
  attempts: number;
  /** Set when the model produced a plain final answer instead of a tool call. */
  finalAnswer?: string | undefined;
  /** True when the retry budget ran out with no parseable call or final answer. */
  exhausted: boolean;
  /** True when generation was aborted. */
  aborted: boolean;
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

/**
 * True when the text looks like a broken tool-call attempt rather than a
 * final answer. Used to decide between a corrective retry and stopping.
 */
export function looksLikeToolCallAttempt(text: string): boolean {
  return /<tool_call|"tool_calls"|\{\s*"name"\s*:/i.test(text);
}

/**
 * Extract a final answer from plain model text.
 * Returns undefined when the text is empty or is a malformed tool call.
 */
export function extractFinalAnswer(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  const answerMatch = /<answer>([\s\S]*?)<\/answer>/i.exec(trimmed);
  if (answerMatch) {
    const inner = (answerMatch[1] ?? '').trim();
    return inner || undefined;
  }

  if (looksLikeToolCallAttempt(trimmed)) return undefined;
  return trimmed;
}

/**
 * Drive one LLM turn with corrective retries.
 *
 * The model is given `maxRetries + 1` attempts to produce either a parseable
 * tool call or a final answer. Malformed calls and empty responses append a
 * corrective user message and try again; a plain final answer stops the loop.
 * Native tool calls from the engine (`outcome.toolCalls`) bypass parsing.
 */
export async function retryWithCorrection(
  generate: (messages: Message[]) => Promise<GenerateOutcome>,
  messages: Message[],
  maxRetries: number,
): Promise<CorrectionResult> {
  const history = [...messages];
  let lastParse: ParseResult = { toolCalls: [], text: '', strategy: 'none' };

  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    const outcome = await generate(history);

    if (outcome.aborted) {
      return {
        messages: history,
        parse: lastParse,
        attempts: attempt,
        exhausted: false,
        aborted: true,
      };
    }

    const native = outcome.toolCalls ?? [];
    if (native.length > 0) {
      const parse: ParseResult = { toolCalls: native, text: outcome.text, strategy: 'grammar' };
      return { messages: history, parse, attempts: attempt, exhausted: false, aborted: false };
    }

    const parse = parseToolCalls(outcome.text);
    lastParse = parse;
    if (parse.toolCalls.length > 0) {
      return { messages: history, parse, attempts: attempt, exhausted: false, aborted: false };
    }

    const finalAnswer = extractFinalAnswer(parse.text);
    if (finalAnswer !== undefined) {
      return {
        messages: history,
        parse,
        attempts: attempt,
        finalAnswer,
        exhausted: false,
        aborted: false,
      };
    }

    if (attempt > maxRetries) {
      return { messages: history, parse, attempts: attempt, exhausted: true, aborted: false };
    }

    history.push(makeCorrectionMessage(parse.text));
  }

  return {
    messages: history,
    parse: lastParse,
    attempts: maxRetries + 1,
    exhausted: true,
    aborted: false,
  };
}

function makeCorrectionMessage(previousText: string): Message {
  return {
    id: uuid(),
    role: 'user',
    content: previousText.trim() ? CORRECTIVE_RETRY_PROMPT : CONTINUE_PROMPT,
    timestamp: Date.now(),
  };
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
