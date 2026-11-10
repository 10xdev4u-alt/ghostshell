import type {
  AgentConfig,
  Conversation,
  Message,
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '@/types/index.js';
import { uuid } from '@/lib/utils.js';

export interface AgentStep {
  iteration: number;
  message: Message;
  toolCalls: ToolCall[];
  results: ToolResult[];
}

export interface AgentRunResult {
  messages: Message[];
  steps: AgentStep[];
  iterations: number;
  finishReason: 'stop' | 'max-iterations' | 'error' | 'aborted';
  error?: string | undefined;
}

/**
 * The agent reasoning loop.
 *
 * Contract:
 *  - Call the LLM with the conversation + tool schemas.
 *  - If the model emits tool calls, execute them (serialized) and append the
 *    results, then loop.
 *  - If the model emits a final answer (no tool calls), stop.
 *  - Enforce `maxIterations`, `toolTimeoutMs`, and `maxRetries`.
 *  - Every step is emitted via `onStep` so the UI can stream progress.
 */
export class AgentLoop {
  constructor(
    private readonly tools: Map<string, ToolDefinition>,
    private readonly config: AgentConfig,
  ) {}

  async run(
    conversation: Conversation,
    ctx: ToolContext,
    onStep: (step: AgentStep) => void,
    signal: AbortSignal,
  ): Promise<AgentRunResult> {
    const messages: Message[] = [...conversation.messages];
    const steps: AgentStep[] = [];

    for (let iteration = 0; iteration < this.config.maxIterations; iteration += 1) {
      if (signal.aborted) {
        return this.finish(messages, steps, iteration, 'aborted');
      }

      // TODO: build the request (system prompt + compacted messages + grammar)
      // TODO: call ctx.llm.generate(...)
      // TODO: parse tool calls from the result (grammar-constrained first)
      // TODO: if no tool calls -> emit assistant message, stop
      // TODO: else execute each tool via the serial queue, append results, loop

      throw new Error(
        `AgentLoop.run not implemented (iteration ${iteration}). ` +
          'See issue #12 for the implementation contract.',
      );
    }

    return this.finish(messages, steps, this.config.maxIterations, 'max-iterations');
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
