import type {
  AgentConfig,
  Conversation,
  GenerateRequest,
  Message,
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '@/types/index.js';
import { uuid } from '@/lib/utils.js';
import { SerialQueue } from '@/lib/queue.js';
import { buildToolCallGrammar } from '@/core/llm/grammar.js';
import { retryWithCorrection } from './parser.js';
import type { GenerateOutcome } from './parser.js';
import { compactMessages, tokenBudget, SUMMARY_MAX_TOKENS } from './compaction.js';

export interface AgentStep {
  iteration: number;
  message: Message;
  toolCalls: ToolCall[];
  results: ToolResult[];
}

export interface AgentRunResult {
  messages: Message[];
  steps: AgentStep[];
  /**
   * Number of loop iterations that ran to completion. An iteration aborted or
   * thrown mid-flight is not counted; one that exhausts its retries is.
   */
  iterations: number;
  finishReason: 'stop' | 'max-iterations' | 'error' | 'aborted';
  error?: string | undefined;
}

/** Per-turn generation cap (see ENGINEERING_PLAN §3.3). */
const MAX_TOKENS_PER_TURN = 2048;
/** Leave room for the next response (CONTEXT_BUDGET = 0.8 × ctx_len). */
const CONTEXT_BUDGET_RATIO = 0.8;

const SUMMARY_SYSTEM_PROMPT = `You are a conversation summarizer. Compress the excerpt below into a concise summary of at most 200 words. Preserve file paths, shell commands, error messages, and conclusions. Do not answer the user's request; only summarize what has happened so far.`;

class ToolTimeoutError extends Error {
  constructor(toolName: string, timeoutMs: number) {
    super(`Tool "${toolName}" timed out after ${timeoutMs}ms`);
    this.name = 'ToolTimeoutError';
  }
}

class ToolAbortedError extends Error {
  constructor(toolName: string) {
    super(`Tool "${toolName}" was aborted.`);
    this.name = 'ToolAbortedError';
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The agent reasoning loop.
 *
 * Contract:
 *  - Call the LLM with the conversation + tool schemas.
 *  - If the model emits tool calls, execute them (serialized), append an
 *    assistant message carrying the calls and one `tool` message per result,
 *    then loop.
 *  - If the model emits a final answer (no tool calls), stop.
 *  - Enforce `maxIterations`, `toolTimeoutMs`, and `maxRetries`.
 *  - `toolTimeoutMs` bounds the wait for a tool and cancels it: the per-tool
 *    signal is aborted on timeout, so tools that honor it stop, and the serial
 *    queue slot is held until the tool settles.
 *  - Every step is emitted via `onStep` so the UI can stream progress.
 */
export class AgentLoop {
  private readonly queue: SerialQueue;
  private grammar: string | undefined;
  private grammarKey: string | undefined;

  constructor(
    private readonly tools: Map<string, ToolDefinition>,
    private readonly config: AgentConfig,
    queue?: SerialQueue,
  ) {
    this.queue = queue ?? new SerialQueue();
  }

  async run(
    conversation: Conversation,
    ctx: ToolContext,
    onStep: (step: AgentStep) => void,
    signal: AbortSignal,
  ): Promise<AgentRunResult> {
    const messages: Message[] = [...conversation.messages];
    const steps: AgentStep[] = [];
    this.ensureSystemMessage(messages);

    let completed = 0;
    try {
      for (let iteration = 0; iteration < this.config.maxIterations; iteration += 1) {
        if (signal.aborted) {
          return this.finish(messages, steps, completed, 'aborted');
        }

        await this.compactIfNeeded(messages, ctx, signal);

        const outcome = await retryWithCorrection(
          (requestMessages) => this.generate(requestMessages, ctx, signal),
          messages,
          this.config.maxRetries,
          signal,
        );

        if (outcome.aborted || signal.aborted) {
          return this.finish(messages, steps, completed, 'aborted');
        }

        // Keep any corrective messages the retry helper appended.
        messages.splice(0, messages.length, ...outcome.messages);

        if (outcome.finalAnswer !== undefined) {
          const message = this.assistantMessage(outcome.finalAnswer, []);
          messages.push(message);
          const step: AgentStep = { iteration, message, toolCalls: [], results: [] };
          steps.push(step);
          onStep(step);
          completed += 1;
          return this.finish(messages, steps, completed, 'stop');
        }

        if (outcome.parse.toolCalls.length === 0) {
          const error =
            'The model did not produce a valid tool call or final answer after several attempts.';
          const message = this.assistantMessage(
            'I could not continue: my last response was not a valid tool call. Please try again.',
            [],
          );
          messages.push(message);
          const step: AgentStep = { iteration, message, toolCalls: [], results: [] };
          steps.push(step);
          onStep(step);
          completed += 1;
          return this.finish(messages, steps, completed, 'error', error);
        }

        const calls = outcome.parse.toolCalls;
        const results: ToolResult[] = [];
        for (const call of calls) {
          if (signal.aborted) {
            return this.finish(messages, steps, completed, 'aborted');
          }
          results.push(await this.executeTool(call, ctx, signal));
        }

        const message = this.assistantMessage(outcome.parse.text, calls);
        messages.push(message);
        for (const result of results) {
          messages.push(this.toolMessage(result));
        }
        const step: AgentStep = { iteration, message, toolCalls: calls, results };
        steps.push(step);
        onStep(step);
        completed += 1;
      }

      const note =
        `I reached the iteration limit (${this.config.maxIterations}) before finishing. ` +
        'Here is where things stand; send another message to continue.';
      const message = this.assistantMessage(note, []);
      messages.push(message);
      const step: AgentStep = { iteration: completed, message, toolCalls: [], results: [] };
      steps.push(step);
      onStep(step);
      return this.finish(messages, steps, completed, 'max-iterations');
    } catch (err) {
      if (signal.aborted) {
        return this.finish(messages, steps, completed, 'aborted');
      }
      return this.finish(messages, steps, completed, 'error', errorMessage(err));
    }
  }

  /** Prepend the configured system prompt when the conversation lacks one. */
  private ensureSystemMessage(messages: Message[]): void {
    if (!this.config.systemPrompt.trim()) return;
    const first = messages[0];
    if (first?.role === 'system') return;
    messages.unshift(makeSystemMessage(this.config.systemPrompt));
  }

  private buildRequest(messages: Message[]): GenerateRequest {
    const grammar = this.buildGrammar();
    return {
      messages,
      temperature: this.config.temperature,
      maxTokens: MAX_TOKENS_PER_TURN,
      ...(grammar ? { grammar } : {}),
    };
  }

  /**
   * Grammar-constrained decoding is provided by the LLM module (issue #18).
   * Until that lands, the loop runs unconstrained and relies on the parser's
   * fallback chain plus corrective retries.
   *
   * The grammar depends only on the tool set, so it is cached and rebuilt only
   * when a tool's name or parameters change.
   */
  private buildGrammar(): string | undefined {
    const key = this.grammarKeyForTools();
    if (this.grammarKey === key) return this.grammar;
    this.grammarKey = key;
    try {
      this.grammar = buildToolCallGrammar(
        [...this.tools.values()].map((tool) => ({
          name: tool.name,
          parameters: tool.parameters,
        })),
      );
    } catch {
      this.grammar = undefined;
    }
    return this.grammar;
  }

  /** Stable identity for the tool set, used to invalidate the grammar cache. */
  private grammarKeyForTools(): string {
    return [...this.tools.values()]
      .map((tool) => `${tool.name}:${JSON.stringify(tool.parameters)}`)
      .sort()
      .join('\n');
  }

  private async generate(
    messages: Message[],
    ctx: ToolContext,
    signal: AbortSignal,
  ): Promise<GenerateOutcome> {
    try {
      const result = await ctx.llm.generate(this.buildRequest(messages), () => undefined, signal);
      const toolCalls = result.toolCalls ? { toolCalls: result.toolCalls } : {};
      if (result.finishReason === 'aborted') {
        return { text: result.text, ...toolCalls, aborted: true };
      }
      return { text: result.text, ...toolCalls };
    } catch (err) {
      if (signal.aborted) return { text: '', aborted: true };
      throw err;
    }
  }

  private async compactIfNeeded(
    messages: Message[],
    ctx: ToolContext,
    signal: AbortSignal,
  ): Promise<void> {
    const budget = Math.floor(this.config.contextWindow * CONTEXT_BUDGET_RATIO);
    if (tokenBudget(messages) <= budget) return;

    const result = await compactMessages(
      messages,
      budget,
      (dropped) => this.summarize(dropped, ctx, signal),
      signal,
    );
    if (result.compacted) {
      messages.splice(0, messages.length, ...result.messages);
    }
  }

  private async summarize(
    messages: Message[],
    ctx: ToolContext,
    signal: AbortSignal,
  ): Promise<string> {
    const excerpt = messages
      .map((message) => {
        const parts = [`[${message.role}] ${message.content}`];
        for (const result of message.toolResults ?? []) {
          parts.push(`[tool result] ${result.content}`);
        }
        return parts.join('\n');
      })
      .join('\n');

    const result = await ctx.llm.generate(
      {
        messages: [
          makeSystemMessage(SUMMARY_SYSTEM_PROMPT),
          {
            id: uuid(),
            role: 'user',
            content: `Summarize this conversation excerpt:\n\n${excerpt}`,
            timestamp: Date.now(),
          },
        ],
        temperature: 0.2,
        maxTokens: SUMMARY_MAX_TOKENS,
      },
      () => undefined,
      signal,
    );
    return result.text.trim() || 'Earlier conversation omitted.';
  }

  private async executeTool(
    call: ToolCall,
    ctx: ToolContext,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const definition = this.tools.get(call.name);
    if (!definition) {
      return {
        ok: false,
        content: `Unknown tool "${call.name}". Available tools: ${[...this.tools.keys()].join(', ')}.`,
      };
    }

    // Per-execution cancellation: aborted when the run aborts or the tool times
    // out. Tools that honor `ctx.signal` (bash, search) interrupt their guest
    // command instead of running to completion after a timeout.
    const cancellation = new AbortController();
    const onRunAbort = (): void => cancellation.abort();
    if (signal.aborted) cancellation.abort();
    else signal.addEventListener('abort', onRunAbort, { once: true });

    const toolCtx: ToolContext = { ...ctx, signal: cancellation.signal };
    try {
      return await this.queue.add(async () => {
        const toolPromise = definition.execute(toolCtx, call.arguments);
        try {
          return await this.withTimeout(
            toolPromise,
            this.config.toolTimeoutMs,
            call.name,
            cancellation,
          );
        } catch (err) {
          if (err instanceof ToolTimeoutError) {
            // Hold the queue slot until the cancelled tool settles, so the next
            // tool cannot start while the timed-out one is still running.
            await toolPromise.catch(() => undefined);
          }
          throw err;
        }
      });
    } catch (err) {
      // An abort is not a tool failure: rethrow so the loop reports `aborted`.
      if (signal.aborted) throw err;
      if (err instanceof ToolTimeoutError) {
        return { ok: false, content: err.message };
      }
      return { ok: false, content: `Tool "${call.name}" failed: ${errorMessage(err)}` };
    } finally {
      signal.removeEventListener('abort', onRunAbort);
    }
  }

  /**
   * Race a tool against its timeout and its cancellation signal. Whichever
   * fires first settles the promise; the other listener is removed so a late
   * tool result cannot leak into a settled run. On timeout the controller is
   * aborted, so tools that honor `ctx.signal` (see `execWithAbort` in tools.ts)
   * interrupt the underlying command instead of being orphaned.
   */
  private withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    toolName: string,
    cancellation: AbortController,
  ): Promise<T> {
    const signal = cancellation.signal;
    if (signal.aborted) {
      return Promise.reject(new ToolAbortedError(toolName));
    }

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      function cleanup(): void {
        if (timer !== undefined) clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
      }

      function onAbort(): void {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new ToolAbortedError(toolName));
      }

      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        cancellation.abort();
        reject(new ToolTimeoutError(toolName, timeoutMs));
      }, Math.max(1, timeoutMs));

      signal.addEventListener('abort', onAbort, { once: true });

      promise.then(
        (value) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(value);
        },
        (err: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(err);
        },
      );
    });
  }

  private assistantMessage(content: string, toolCalls: ToolCall[]): Message {
    return {
      id: uuid(),
      role: 'assistant',
      content,
      timestamp: Date.now(),
      model: this.config.modelId,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
  }

  /**
   * Tool output travels in a `tool` role message, which is what chat templates
   * expect. The engine passes the assistant's `toolCalls` and the tool
   * message's content through to the tokenizer (see PR #31).
   */
  private toolMessage(result: ToolResult): Message {
    return {
      id: uuid(),
      role: 'tool',
      content: result.content,
      timestamp: Date.now(),
      model: this.config.modelId,
    };
  }

  private finish(
    messages: Message[],
    steps: AgentStep[],
    iterations: number,
    reason: AgentRunResult['finishReason'],
    error?: string,
  ): AgentRunResult {
    return { messages, steps, iterations, finishReason: reason, error };
  }
}

/** Build the tool registry from the built-in tool definitions. */
export function createToolRegistry(defs: ToolDefinition[]): Map<string, ToolDefinition> {
  const registry = new Map<string, ToolDefinition>();
  for (const def of defs) {
    if (registry.has(def.name)) {
      throw new Error(`Duplicate tool name: ${def.name}`);
    }
    registry.set(def.name, def);
  }
  return registry;
}

export function makeSystemMessage(content: string): Message {
  return { id: uuid(), role: 'system', content, timestamp: Date.now() };
}
