import { describe, expect, it } from 'vitest';
import type {
  AgentConfig,
  CommandResult,
  Conversation,
  Database,
  DirEntry,
  EgressLog,
  GenerateRequest,
  GenerateResult,
  LLMEngine,
  Message,
  MessageRole,
  ToolContext,
  ToolDefinition,
  VMHandle,
} from '@/types/index.js';
import { uuid } from '@/lib/utils.js';
import { AgentLoop, createToolRegistry, type AgentStep } from '@/core/agent/loop.js';
import { builtinTools } from '@/core/agent/tools.js';
import { CORRECTIVE_RETRY_PROMPT, CONTINUE_PROMPT } from '@/core/agent/prompts.js';

class FakeLLM implements LLMEngine {
  readonly id = 'fake-llm';
  readonly kind = 'wasm' as const;
  queue: GenerateResult[] = [];
  requests: GenerateRequest[] = [];
  fallback: GenerateResult = { text: 'All done.', tokens: 1, finishReason: 'stop' };
  onGenerate: ((req: GenerateRequest) => void) | null = null;

  async load(): Promise<void> {}
  async unload(): Promise<void> {}
  isLoaded(): boolean {
    return true;
  }

  async generate(
    req: GenerateRequest,
    onToken: (token: string) => void,
    signal: AbortSignal,
  ): Promise<GenerateResult> {
    this.requests.push(req);
    this.onGenerate?.(req);
    if (signal.aborted) throw new Error('aborted');
    const next = this.queue.length > 0 ? this.queue.shift()! : this.fallback;
    for (const token of next.text) onToken(token);
    return next;
  }
}

class FakeVM implements VMHandle {
  readonly id = 'fake-vm';
  running = true;
  commands: Array<{ cmd: string; timeoutMs?: number | undefined }> = [];
  files = new Map<string, string>();
  execResult: CommandResult = { stdout: 'ok\n', stderr: '', exitCode: 0, durationMs: 1, timedOut: false };

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async pause(): Promise<void> {}
  async resume(): Promise<void> {}

  async exec(cmd: string, timeoutMs?: number): Promise<CommandResult> {
    this.commands.push({ cmd, timeoutMs });
    return this.execResult;
  }

  async write(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  async read(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`ENOENT: '${path}'`);
    return value;
  }

  async list(): Promise<DirEntry[]> {
    return [];
  }

  onSerial(): void {}
}

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    maxIterations: 5,
    toolTimeoutMs: 60_000,
    maxRetries: 2,
    contextWindow: 4096,
    temperature: 0.2,
    modelId: 'fake-model',
    networkMode: 'off',
    systemPrompt: 'You are GhostShell.',
    ...overrides,
  };
}

function makeMessage(role: MessageRole, content: string, extra?: Partial<Message>): Message {
  return { id: uuid(), role, content, timestamp: 1, ...extra };
}

function makeConversation(messages: Message[] = []): Conversation {
  return { id: 'c1', title: 'Test', messages, createdAt: 0, updatedAt: 0, modelId: 'fake-model' };
}

function makeContext(vm: VMHandle, llm: LLMEngine): ToolContext {
  const db = {} as Database;
  const egress: EgressLog = { record: () => undefined, list: () => [], clear: () => undefined };
  return { vm, llm, db, egress };
}

function makeTools(): Map<string, ToolDefinition> {
  return createToolRegistry(builtinTools());
}

function toolCall(name: string, args: Record<string, unknown>): string {
  return `<tool_call>${JSON.stringify({ name, arguments: args })}</tool_call>`;
}

function run(
  loop: AgentLoop,
  conversation: Conversation,
  ctx: ToolContext,
  steps: AgentStep[] = [],
  signal = new AbortController().signal,
): Promise<Awaited<ReturnType<AgentLoop['run']>>> {
  return loop.run(conversation, ctx, (step) => steps.push(step), signal);
}

describe('AgentLoop', () => {
  it('runs observe -> think -> act -> observe and stops on a final answer', async () => {
    const llm = new FakeLLM();
    llm.queue = [
      { text: toolCall('bash', { command: 'ls' }), tokens: 10, finishReason: 'stop' },
      { text: 'All done.', tokens: 2, finishReason: 'stop' },
    ];
    const vm = new FakeVM();
    const loop = new AgentLoop(makeTools(), makeConfig());
    const steps: AgentStep[] = [];

    const result = await run(loop, makeConversation([makeMessage('user', 'list files')]), makeContext(vm, llm), steps);

    expect(result.finishReason).toBe('stop');
    expect(result.iterations).toBe(2);
    expect(steps).toHaveLength(2);
    expect(steps[0]!.toolCalls[0]!.name).toBe('bash');
    expect(steps[0]!.results[0]!.ok).toBe(true);
    expect(result.messages.at(-1)!.content).toBe('All done.');
    expect(vm.commands[0]!.cmd).toBe('ls');
    expect(result.messages[0]!.role).toBe('system');
  });

  it('sends tool results to the model as tool messages', async () => {
    const llm = new FakeLLM();
    llm.queue = [
      { text: toolCall('bash', { command: 'ls' }), tokens: 10, finishReason: 'stop' },
      { text: 'All done.', tokens: 2, finishReason: 'stop' },
    ];
    const vm = new FakeVM();
    const loop = new AgentLoop(makeTools(), makeConfig());

    await run(loop, makeConversation([makeMessage('user', 'list files')]), makeContext(vm, llm));

    const nextRequest = llm.requests[1]!;
    const toolMessages = nextRequest.messages.filter((m) => m.role === 'tool');
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0]!.content).toContain('ok');
    const assistant = nextRequest.messages.find((m) => m.role === 'assistant');
    expect(assistant?.toolCalls?.[0]?.name).toBe('bash');
    expect(assistant?.toolResults).toBeUndefined();
  });

  it('stops at maxIterations and reports the limit', async () => {
    const llm = new FakeLLM();
    llm.fallback = { text: toolCall('bash', { command: 'ls' }), tokens: 1, finishReason: 'stop' };
    const vm = new FakeVM();
    const loop = new AgentLoop(makeTools(), makeConfig({ maxIterations: 3 }));
    const steps: AgentStep[] = [];

    const result = await run(loop, makeConversation([makeMessage('user', 'loop')]), makeContext(vm, llm), steps);

    expect(result.finishReason).toBe('max-iterations');
    expect(result.iterations).toBe(3);
    expect(steps).toHaveLength(4);
    expect(steps.slice(0, 3).every((step) => step.toolCalls.length === 1)).toBe(true);
    expect(result.messages.at(-1)!.content).toContain('iteration limit');
  });

  it('retries malformed tool calls with a corrective message', async () => {
    const llm = new FakeLLM();
    llm.queue = [
      {
        text: '<tool_call>{"name": "bash", arguments: {command: "ls"}}</tool_call>',
        tokens: 1,
        finishReason: 'stop',
      },
      { text: toolCall('bash', { command: 'ls' }), tokens: 1, finishReason: 'stop' },
      { text: 'Done.', tokens: 1, finishReason: 'stop' },
    ];
    const vm = new FakeVM();
    const loop = new AgentLoop(makeTools(), makeConfig({ maxRetries: 2 }));

    const result = await run(loop, makeConversation([makeMessage('user', 'list files')]), makeContext(vm, llm));

    expect(result.finishReason).toBe('stop');
    expect(llm.requests).toHaveLength(3);
    expect(result.messages.some((m) => m.content === CORRECTIVE_RETRY_PROMPT)).toBe(true);
    expect(vm.commands[0]!.cmd).toBe('ls');
  });

  it('asks the model to continue on an empty response', async () => {
    const llm = new FakeLLM();
    llm.queue = [
      { text: '', tokens: 0, finishReason: 'stop' },
      { text: 'Done.', tokens: 1, finishReason: 'stop' },
    ];
    const vm = new FakeVM();
    const loop = new AgentLoop(makeTools(), makeConfig());

    const result = await run(loop, makeConversation([makeMessage('user', 'hi')]), makeContext(vm, llm));

    expect(result.finishReason).toBe('stop');
    expect(llm.requests).toHaveLength(2);
    expect(result.messages.some((m) => m.content === CONTINUE_PROMPT)).toBe(true);
  });

  it('returns an error when retries are exhausted', async () => {
    const llm = new FakeLLM();
    llm.fallback = { text: '<tool_call>not json</tool_call>', tokens: 1, finishReason: 'stop' };
    const vm = new FakeVM();
    const loop = new AgentLoop(makeTools(), makeConfig({ maxRetries: 1 }));

    const result = await run(loop, makeConversation([makeMessage('user', 'hi')]), makeContext(vm, llm));

    expect(result.finishReason).toBe('error');
    expect(result.error).toContain('valid tool call');
    expect(llm.requests).toHaveLength(2);
  });

  it('returns aborted when the signal fires during generation', async () => {
    const controller = new AbortController();
    const llm = new FakeLLM();
    llm.onGenerate = () => controller.abort();
    const vm = new FakeVM();
    const loop = new AgentLoop(makeTools(), makeConfig());

    const result = await run(loop, makeConversation([makeMessage('user', 'hi')]), makeContext(vm, llm), [], controller.signal);

    expect(result.finishReason).toBe('aborted');
  });

  it('returns aborted when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const llm = new FakeLLM();
    const vm = new FakeVM();
    const loop = new AgentLoop(makeTools(), makeConfig());

    const result = await run(loop, makeConversation([makeMessage('user', 'hi')]), makeContext(vm, llm), [], controller.signal);

    expect(result.finishReason).toBe('aborted');
    expect(llm.requests).toHaveLength(0);
  });

  it('enforces toolTimeoutMs and records a failed result', async () => {
    const llm = new FakeLLM();
    llm.fallback = { text: toolCall('hang', {}), tokens: 1, finishReason: 'stop' };
    const hanging: ToolDefinition = {
      name: 'hang',
      description: 'hangs',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return { ok: true, content: 'never' };
      },
    };
    const loop = new AgentLoop(new Map([['hang', hanging]]), makeConfig({ toolTimeoutMs: 20, maxIterations: 1 }));
    const steps: AgentStep[] = [];

    const result = await run(loop, makeConversation([makeMessage('user', 'hi')]), makeContext(new FakeVM(), llm), steps);

    expect(result.finishReason).toBe('max-iterations');
    expect(steps[0]!.results[0]!.ok).toBe(false);
    expect(steps[0]!.results[0]!.content).toContain('timed out');
  });

  it('honors abort during tool execution without reporting a tool failure', async () => {
    const controller = new AbortController();
    const slow: ToolDefinition = {
      name: 'slow',
      description: 'hangs',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return { ok: true, content: 'never' };
      },
    };
    const llm = new FakeLLM();
    llm.fallback = { text: toolCall('slow', {}), tokens: 1, finishReason: 'stop' };
    const loop = new AgentLoop(new Map([['slow', slow]]), makeConfig({ maxIterations: 1 }));
    const steps: AgentStep[] = [];
    const start = Date.now();
    setTimeout(() => controller.abort(), 20);

    const result = await run(
      loop,
      makeConversation([makeMessage('user', 'hi')]),
      makeContext(new FakeVM(), llm),
      steps,
      controller.signal,
    );

    expect(result.finishReason).toBe('aborted');
    expect(steps).toHaveLength(0);
    expect(Date.now() - start).toBeLessThan(300);
  });

  it('reports unknown tools without throwing', async () => {
    const llm = new FakeLLM();
    llm.fallback = { text: toolCall('nope', {}), tokens: 1, finishReason: 'stop' };
    const vm = new FakeVM();
    const loop = new AgentLoop(makeTools(), makeConfig({ maxIterations: 1 }));
    const steps: AgentStep[] = [];

    const result = await run(loop, makeConversation([makeMessage('user', 'hi')]), makeContext(vm, llm), steps);

    expect(steps[0]!.results[0]!.ok).toBe(false);
    expect(steps[0]!.results[0]!.content).toContain('Unknown tool');
  });

  it('executes multiple tool calls serially', async () => {
    const order: string[] = [];
    const slow: ToolDefinition = {
      name: 'slow',
      description: 'records execution order',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        order.push('start');
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push('end');
        return { ok: true, content: 'ok' };
      },
    };
    const llm = new FakeLLM();
    llm.queue = [
      { text: `${toolCall('slow', {})}${toolCall('slow', {})}`, tokens: 1, finishReason: 'stop' },
      { text: 'Done.', tokens: 1, finishReason: 'stop' },
    ];
    const loop = new AgentLoop(new Map([['slow', slow]]), makeConfig());

    const result = await run(loop, makeConversation([makeMessage('user', 'hi')]), makeContext(new FakeVM(), llm));

    expect(result.finishReason).toBe('stop');
    expect(order).toEqual(['start', 'end', 'start', 'end']);
    expect(result.steps[0]!.toolCalls).toHaveLength(2);
  });

  it('uses native tool calls from the engine', async () => {
    const llm = new FakeLLM();
    llm.queue = [
      {
        text: '',
        tokens: 0,
        finishReason: 'stop',
        toolCalls: [{ id: '1', name: 'bash', arguments: { command: 'ls' }, raw: '{"name":"bash"}' }],
      },
      { text: 'Done.', tokens: 1, finishReason: 'stop' },
    ];
    const vm = new FakeVM();
    const loop = new AgentLoop(makeTools(), makeConfig());
    const steps: AgentStep[] = [];

    const result = await run(loop, makeConversation([makeMessage('user', 'list files')]), makeContext(vm, llm), steps);

    expect(result.finishReason).toBe('stop');
    expect(steps[0]!.toolCalls[0]!.name).toBe('bash');
    expect(vm.commands[0]!.cmd).toBe('ls');
  });

  it('compacts the context before generating when over budget', async () => {
    const llm = new FakeLLM();
    llm.queue = [
      { text: 'Earlier work summarized.', tokens: 3, finishReason: 'stop' },
      { text: 'Done.', tokens: 1, finishReason: 'stop' },
    ];
    const vm = new FakeVM();
    const loop = new AgentLoop(makeTools(), makeConfig({ contextWindow: 40 }));
    const messages = [
      makeMessage('user', 'x'.repeat(200)),
      makeMessage('assistant', 'y'.repeat(200)),
      makeMessage('user', 'z'.repeat(200)),
    ];

    const result = await run(loop, makeConversation(messages), makeContext(vm, llm));

    expect(result.finishReason).toBe('stop');
    expect(llm.requests).toHaveLength(2);
    expect(llm.requests[0]!.messages[0]!.content).toContain('summarizer');
    expect(llm.requests[1]!.messages.some((m) => m.content.includes('Summary of earlier conversation'))).toBe(true);
    expect(llm.requests[1]!.messages.some((m) => m.content.includes('x'.repeat(200)))).toBe(false);
  });

  it('keeps an existing system message instead of duplicating it', async () => {
    const llm = new FakeLLM();
    llm.queue = [{ text: 'Done.', tokens: 1, finishReason: 'stop' }];
    const vm = new FakeVM();
    const loop = new AgentLoop(makeTools(), makeConfig());
    const conversation = makeConversation([makeMessage('system', 'Custom system prompt.')]);

    const result = await run(loop, conversation, makeContext(vm, llm));

    expect(result.messages.filter((m) => m.role === 'system')).toHaveLength(1);
    expect(result.messages[0]!.content).toBe('Custom system prompt.');
  });
});
