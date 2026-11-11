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

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const DEFAULT_RESULT: CommandResult = {
  stdout: '',
  stderr: '',
  exitCode: 0,
  durationMs: 1,
  timedOut: false,
};

/**
 * A VM that never touches real hardware. `exec` returns canned output per
 * command; commands can also be made to hang or to wait for Ctrl-C.
 */
class FakeVM implements VMHandle {
  readonly id = 'fake-vm';
  running = true;
  commands: Array<{ cmd: string; timeoutMs?: number | undefined }> = [];
  serial: string[] = [];
  files = new Map<string, string>();
  dirs = new Map<string, DirEntry[]>();
  private readonly canned = new Map<string, CommandResult>();
  private readonly interruptible = new Set<string>();
  private readonly hanging = new Set<string>();
  private readonly interruptWaiters = new Set<() => void>();

  constructor() {
    this.canned.set('ls', {
      stdout: 'a.txt\nb.txt\n',
      stderr: '',
      exitCode: 0,
      durationMs: 2,
      timedOut: false,
    });
    this.canned.set('pwd', {
      stdout: '/root/workspace\n',
      stderr: '',
      exitCode: 0,
      durationMs: 1,
      timedOut: false,
    });
  }

  /** Override the canned result for an exact command. */
  seed(cmd: string, result: Partial<CommandResult>): void {
    this.canned.set(cmd, { ...DEFAULT_RESULT, ...result });
  }

  /** A command that blocks until the guest receives Ctrl-C. */
  makeInterruptible(cmd: string): void {
    this.interruptible.add(cmd);
  }

  /** A command whose exec never resolves (a hung guest command). */
  makeHang(cmd: string): void {
    this.hanging.add(cmd);
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async pause(): Promise<void> {}
  async resume(): Promise<void> {}

  async exec(cmd: string, timeoutMs?: number): Promise<CommandResult> {
    this.commands.push({ cmd, timeoutMs });
    if (this.hanging.has(cmd)) await new Promise<void>(() => {});
    if (this.interruptible.has(cmd)) {
      await new Promise<void>((resolve) => this.interruptWaiters.add(resolve));
      return {
        stdout: '',
        stderr: '',
        exitCode: 130,
        durationMs: 5,
        timedOut: false,
      };
    }
    return this.canned.get(cmd) ?? { ...DEFAULT_RESULT };
  }

  sendSerial(data: string): void {
    this.serial.push(data);
    if (data.includes('\x03')) {
      for (const resolve of this.interruptWaiters) resolve();
      this.interruptWaiters.clear();
    }
  }

  async write(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  async read(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`ENOENT: no such file '${path}'`);
    return value;
  }

  async list(path: string): Promise<DirEntry[]> {
    const value = this.dirs.get(path);
    if (value === undefined) throw new Error(`ENOENT: no such directory '${path}'`);
    return value;
  }

  onSerial(): void {}
}

/** An LLM that replays a scripted sequence of generations. */
class FakeLLM implements LLMEngine {
  readonly id = 'fake-llm';
  readonly kind = 'wasm' as const;
  requests: GenerateRequest[] = [];
  onGenerate: ((request: GenerateRequest, index: number) => void) | null = null;
  private script: GenerateResult[] = [];
  private fallback: GenerateResult = {
    text: 'All done.',
    tokens: 1,
    finishReason: 'stop',
  };
  private cursor = 0;

  setScript(script: GenerateResult[]): void {
    this.script = script;
    this.cursor = 0;
  }

  setFallback(result: GenerateResult): void {
    this.fallback = result;
  }

  async load(): Promise<void> {}
  async unload(): Promise<void> {}
  isLoaded(): boolean {
    return true;
  }

  async generate(
    req: GenerateRequest,
    _onToken: (token: string) => void,
    signal: AbortSignal,
  ): Promise<GenerateResult> {
    this.requests.push(req);
    this.onGenerate?.(req, this.cursor);
    if (signal.aborted) {
      return { text: '', tokens: 0, finishReason: 'aborted' };
    }
    const next = this.cursor < this.script.length ? this.script[this.cursor]! : this.fallback;
    this.cursor += 1;
    return next;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  return {
    id: 'c1',
    title: 'Integration',
    messages,
    createdAt: 0,
    updatedAt: 0,
    modelId: 'fake-model',
  };
}

function makeContext(vm: VMHandle, llm: LLMEngine): ToolContext {
  const db = {} as Database;
  const egress: EgressLog = {
    record: () => undefined,
    list: () => [],
    clear: () => undefined,
  };
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentLoop integration', () => {
  it('runs observe -> think -> act -> observe and stops on a final answer', async () => {
    const vm = new FakeVM();
    const llm = new FakeLLM();
    llm.setScript([
      {
        text: toolCall('bash', { command: 'ls' }),
        tokens: 10,
        finishReason: 'stop',
      },
      {
        text: '<answer>Found a.txt and b.txt.</answer>',
        tokens: 5,
        finishReason: 'stop',
      },
    ]);
    const loop = new AgentLoop(makeTools(), makeConfig());
    const steps: AgentStep[] = [];

    const result = await run(
      loop,
      makeConversation([makeMessage('user', 'list the files')]),
      makeContext(vm, llm),
      steps,
    );

    expect(result.finishReason).toBe('stop');
    expect(result.iterations).toBe(2);
    expect(steps).toHaveLength(2);

    // Observe: the first request carries the system prompt and the user's
    // request, with no tool traffic yet.
    expect(llm.requests).toHaveLength(2);
    expect(llm.requests[0]!.messages.map((m) => m.role)).toEqual(['system', 'user']);

    // Act: the tool ran exactly once, against the canned `ls` command.
    expect(vm.commands).toHaveLength(1);
    expect(vm.commands[0]!.cmd).toBe('ls');

    // The step records both the call and its result.
    expect(steps[0]!.toolCalls).toHaveLength(1);
    expect(steps[0]!.toolCalls[0]!.name).toBe('bash');
    expect(steps[0]!.toolCalls[0]!.arguments).toEqual({ command: 'ls' });
    expect(steps[0]!.results).toHaveLength(1);
    expect(steps[0]!.results[0]!.ok).toBe(true);

    // Observe again: the assistant's call and the tool result both reach the
    // model in the next request.
    const second = llm.requests[1]!;
    const toolMessages = second.messages.filter((m) => m.role === 'tool');
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0]!.content).toContain('a.txt');
    expect(toolMessages[0]!.content).toContain('b.txt');
    const assistant = second.messages.find((m) => m.role === 'assistant');
    expect(assistant?.toolCalls?.[0]?.name).toBe('bash');
    expect(assistant?.toolCalls?.[0]?.arguments).toEqual({ command: 'ls' });

    // Think: the final answer is produced and recorded.
    expect(steps[1]!.toolCalls).toHaveLength(0);
    expect(result.messages.at(-1)!.role).toBe('assistant');
    expect(result.messages.at(-1)!.content).toBe('Found a.txt and b.txt.');
  });

  it('stops at maxIterations and reports the limit', async () => {
    const vm = new FakeVM();
    const llm = new FakeLLM();
    llm.setFallback({
      text: toolCall('bash', { command: 'ls' }),
      tokens: 1,
      finishReason: 'stop',
    });
    const loop = new AgentLoop(makeTools(), makeConfig({ maxIterations: 3 }));
    const steps: AgentStep[] = [];

    const result = await run(
      loop,
      makeConversation([makeMessage('user', 'keep listing')]),
      makeContext(vm, llm),
      steps,
    );

    expect(result.finishReason).toBe('max-iterations');
    expect(result.iterations).toBe(3);
    expect(steps).toHaveLength(4);
    expect(steps.slice(0, 3).every((step) => step.toolCalls.length === 1)).toBe(true);
    expect(steps[3]!.toolCalls).toHaveLength(0);
    expect(vm.commands).toHaveLength(3);
    expect(result.messages.at(-1)!.content).toContain('iteration limit');
    expect(result.messages.at(-1)!.content).toContain('3');
  });

  it('reports aborted and issues no further tool calls when the signal fires mid-run', async () => {
    const controller = new AbortController();
    const vm = new FakeVM();
    const llm = new FakeLLM();
    llm.setScript([
      {
        text: toolCall('bash', { command: 'ls' }),
        tokens: 1,
        finishReason: 'stop',
      },
      {
        text: '<answer>Unreachable.</answer>',
        tokens: 1,
        finishReason: 'stop',
      },
    ]);
    llm.onGenerate = (_request, index) => {
      if (index === 1) controller.abort();
    };
    const loop = new AgentLoop(makeTools(), makeConfig());
    const steps: AgentStep[] = [];

    const result = await run(
      loop,
      makeConversation([makeMessage('user', 'list files')]),
      makeContext(vm, llm),
      steps,
      controller.signal,
    );

    expect(result.finishReason).toBe('aborted');
    expect(result.iterations).toBe(1);
    expect(steps).toHaveLength(1);
    expect(vm.commands).toHaveLength(1);
    expect(vm.commands[0]!.cmd).toBe('ls');
    expect(result.messages.some((m) => m.content.includes('Unreachable'))).toBe(false);
  });

  it('interrupts an in-flight tool call and issues no further commands', async () => {
    const controller = new AbortController();
    const vm = new FakeVM();
    vm.makeInterruptible('sleep 100');
    const llm = new FakeLLM();
    llm.setFallback({
      text: toolCall('bash', { command: 'sleep 100' }),
      tokens: 1,
      finishReason: 'stop',
    });
    const loop = new AgentLoop(makeTools(), makeConfig({ maxIterations: 5 }));
    const steps: AgentStep[] = [];
    setTimeout(() => controller.abort(), 20);

    const result = await run(
      loop,
      makeConversation([makeMessage('user', 'sleep')]),
      makeContext(vm, llm),
      steps,
      controller.signal,
    );

    expect(result.finishReason).toBe('aborted');
    expect(vm.serial).toContain('\x03');
    expect(vm.commands).toHaveLength(1);
    expect(vm.commands[0]!.cmd).toBe('sleep 100');
    expect(steps).toHaveLength(0);
  });

  it('records a failed result when a tool times out and lets the loop continue', async () => {
    const vm = new FakeVM();
    vm.makeHang('sleep 100');
    const llm = new FakeLLM();
    llm.setScript([
      {
        text: toolCall('bash', { command: 'sleep 100' }),
        tokens: 1,
        finishReason: 'stop',
      },
      {
        text: '<answer>It timed out.</answer>',
        tokens: 1,
        finishReason: 'stop',
      },
    ]);
    const loop = new AgentLoop(makeTools(), makeConfig({ toolTimeoutMs: 20, maxIterations: 3 }));
    const steps: AgentStep[] = [];

    const result = await run(loop, makeConversation([makeMessage('user', 'sleep')]), makeContext(vm, llm), steps);

    expect(result.finishReason).toBe('stop');
    expect(result.iterations).toBe(2);
    expect(steps[0]!.results).toHaveLength(1);
    expect(steps[0]!.results[0]!.ok).toBe(false);
    expect(steps[0]!.results[0]!.content).toContain('timed out');
    // The failure travels back to the model as a tool message.
    expect(llm.requests[1]!.messages.some((m) => m.role === 'tool' && m.content.includes('timed out'))).toBe(true);
    expect(result.messages.at(-1)!.content).toBe('It timed out.');
  });

  it('compacts the context when it exceeds the token budget', async () => {
    const vm = new FakeVM();
    const llm = new FakeLLM();
    llm.setScript([
      { text: 'Earlier work summarized.', tokens: 3, finishReason: 'stop' },
      { text: '<answer>Done.</answer>', tokens: 1, finishReason: 'stop' },
    ]);
    const loop = new AgentLoop(makeTools(), makeConfig({ contextWindow: 100 }));
    const conversation = makeConversation([makeMessage('user', 'a'.repeat(400)), makeMessage('user', 'b'.repeat(40))]);

    const result = await run(loop, conversation, makeContext(vm, llm));

    expect(result.finishReason).toBe('stop');
    expect(llm.requests).toHaveLength(2);

    // The first request is the summarization call.
    expect(llm.requests[0]!.messages[0]!.content).toContain('summarizer');

    // The follow-up carries the summary, not the dropped message.
    const followUp = llm.requests[1]!;
    expect(followUp.messages.some((m) => m.content.includes('Summary of earlier conversation'))).toBe(true);
    expect(followUp.messages.some((m) => m.content === 'a'.repeat(400))).toBe(false);
    expect(followUp.messages.some((m) => m.content === 'b'.repeat(40))).toBe(true);
    expect(result.messages.at(-1)!.content).toBe('Done.');
  });
});
