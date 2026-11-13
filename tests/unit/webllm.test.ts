import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The real `@mlc-ai/web-llm` package is never loaded: WebGPU initialization
 * would fail in Node and pull in the WASM runtime. The dynamic import inside
 * `WebLLMEngine` is intercepted with an in-memory engine whose streaming API
 * is driven by each test.
 */
const {
  MLCEngineMock,
  prebuiltAppConfigMock,
  isValidSRIMock,
  verifyIntegrityMock,
} = vi.hoisted(() => {
  class MLCEngineMock {
    static readonly instances: MLCEngineMock[] = [];
    static reloadHook:
      ((engine: MLCEngineMock) => void | Promise<void>) | null = null;
    config: Record<string, unknown>;
    chat = { completions: { create: vi.fn() } };
    reload = vi.fn(async (_modelId: string): Promise<void> => {
      const hook = MLCEngineMock.reloadHook;
      if (hook) await hook(this);
    });
    unload = vi.fn(() => Promise.resolve());
    interruptGenerate = vi.fn(() => Promise.resolve());

    constructor(config: Record<string, unknown> = {}) {
      this.config = config;
      MLCEngineMock.instances.push(this);
    }
  }

  const prebuiltAppConfigMock = {
    model_list: [
      {
        model:
          'https://huggingface.co/mlc-ai/Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
        model_id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
        model_lib:
          'https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/Qwen2.5-1.5B-Instruct-q4f16_1-webgpu.wasm',
      },
      {
        model: 'https://huggingface.co/mlc-ai/Qwen2.5-3B-Instruct-q4f16_1-MLC',
        model_id: 'Qwen2.5-3B-Instruct-q4f16_1-MLC',
        model_lib:
          'https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/Qwen2.5-3B-Instruct-q4f16_1-webgpu.wasm',
      },
    ],
  };

  return {
    MLCEngineMock,
    prebuiltAppConfigMock,
    isValidSRIMock: vi.fn((sri: string) =>
      /^sha(256|384|512)-[A-Za-z0-9+/=_-]+$/.test(sri),
    ),
    verifyIntegrityMock: vi.fn(() => Promise.resolve()),
  };
});

vi.mock('@mlc-ai/web-llm', () => ({
  MLCEngine: MLCEngineMock,
  isValidSRI: isValidSRIMock,
  verifyIntegrity: verifyIntegrityMock,
  prebuiltAppConfig: prebuiltAppConfigMock,
}));

import type { ChatCompletionChunk, InitProgressReport } from '@mlc-ai/web-llm';
import type {
  GenerateRequest,
  Message,
  ModelProgress,
  ToolCall,
} from '@/types/index.js';
import { getModel } from '@/core/llm/models.js';
import {
  WebLLMEngine,
  toChatMessages,
  verifyArtifact,
} from '@/core/llm/webllm.js';

const MODEL_ID = 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC';

interface MockAppConfig {
  model_list: Array<{
    model_id: string;
    model?: string;
    model_lib?: string;
    integrity?: unknown;
  }>;
  cacheBackend?: string;
}

type MockEngineInstance = InstanceType<typeof MLCEngineMock>;

function reportProgress(
  instance: MockEngineInstance,
  report: { progress: number; timeElapsed: number; text: string },
): void {
  const callback = instance.config.initProgressCallback as
    ((value: typeof report) => void) | undefined;
  callback?.(report);
}

function lastEngine(): MockEngineInstance {
  const instance = MLCEngineMock.instances.at(-1);
  if (!instance) throw new Error('expected an MLCEngine instance');
  return instance;
}

function appConfig(): MockAppConfig {
  const config = lastEngine().config as { appConfig?: MockAppConfig };
  if (!config.appConfig) throw new Error('expected appConfig');
  return config.appConfig;
}

function initProgressCallback(): (report: InitProgressReport) => void {
  const config = lastEngine().config as {
    initProgressCallback?: (report: InitProgressReport) => void;
  };
  if (!config.initProgressCallback)
    throw new Error('expected initProgressCallback');
  return config.initProgressCallback;
}

function completionChunk(
  content: string | null,
  finishReason?: string | null,
): ChatCompletionChunk {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: 0,
    model: MODEL_ID,
    choices: [
      {
        index: 0,
        delta: { role: 'assistant', content },
        finish_reason: (finishReason ??
          null) as ChatCompletionChunk.Choice['finish_reason'],
      },
    ],
  };
}

function usageChunk(completionTokens: number): ChatCompletionChunk {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: 0,
    model: MODEL_ID,
    choices: [],
    usage: {
      completion_tokens: completionTokens,
      prompt_tokens: 1,
      total_tokens: completionTokens + 1,
      extra: {
        e2e_latency_s: 0,
        prefill_tokens_per_s: 0,
        decode_tokens_per_s: 0,
        time_to_first_token_s: 0,
        time_per_output_token_s: 0,
      },
    },
  };
}

async function* streamOf(
  chunks: ChatCompletionChunk[],
): AsyncIterable<ChatCompletionChunk> {
  for (const chunk of chunks) yield chunk;
}

function userMessage(content = 'hi'): Message {
  return { id: 'm1', role: 'user', content, timestamp: 0 };
}

async function loadedEngine(
  options?: ConstructorParameters<typeof WebLLMEngine>[0],
) {
  const engine = new WebLLMEngine(options);
  await engine.load(getModel('qwen2.5-1.5b'), () => {});
  return engine;
}

beforeEach(() => {
  MLCEngineMock.instances.length = 0;
  MLCEngineMock.reloadHook = null;
  isValidSRIMock.mockClear();
  verifyIntegrityMock.mockClear();
});

describe('WebLLMEngine', () => {
  it('starts unloaded and unload keeps it unloaded', async () => {
    const engine = new WebLLMEngine();
    expect(engine.id).toBe('webllm');
    expect(engine.kind).toBe('webgpu');
    expect(engine.isLoaded()).toBe(false);
    await engine.unload();
    expect(engine.isLoaded()).toBe(false);
  });

  it('maps a registry spec to its MLC id, builds the app config, and reloads', async () => {
    const spec = getModel('qwen2.5-1.5b');
    const integrity = { config: 'sha256-abc123', model_lib: 'sha256-def456' };
    const engine = new WebLLMEngine({ cache: 'opfs', integrity });
    const progress: ModelProgress[] = [];

    MLCEngineMock.reloadHook = (instance) => {
      reportProgress(instance, {
        progress: 0.5,
        timeElapsed: 2,
        text: 'Fetching param cache[1/2]',
      });
    };

    await engine.load(spec, (p) => progress.push(p));

    const instance = lastEngine();
    expect(instance.reload).toHaveBeenCalledWith(MODEL_ID);

    const config = appConfig();
    expect(config.cacheBackend).toBe('opfs');
    expect(config.model_list).toHaveLength(1);
    expect(config.model_list[0]!.model_id).toBe(MODEL_ID);
    // The record is copied from the pinned catalog, not reconstructed.
    expect(config.model_list[0]!.model_lib).toContain(
      'Qwen2.5-1.5B-Instruct-q4f16_1',
    );
    expect(config.model_list[0]!.integrity).toEqual(integrity);

    expect(progress[0]).toMatchObject({
      phase: 'downloading',
      loaded: 0,
      total: spec.sizeBytes,
      percent: 0,
    });
    expect(
      progress.some((p) => p.phase === 'downloading' && p.percent === 50),
    ).toBe(true);
    const last = progress.at(-1)!;
    expect(last).toMatchObject({
      phase: 'loading',
      loaded: spec.sizeBytes,
      total: spec.sizeBytes,
      percent: 100,
    });
    expect(last.message).toBe(`${spec.name} ready`);
    expect(engine.isLoaded()).toBe(true);
  });

  it('defaults to the OPFS cache and maps the 3B model', async () => {
    const engine = new WebLLMEngine();
    await engine.load(getModel('qwen2.5-3b'), () => {});

    expect(appConfig().cacheBackend).toBe('opfs');
    expect(lastEngine().reload).toHaveBeenCalledWith(
      'Qwen2.5-3B-Instruct-q4f16_1-MLC',
    );
    expect(appConfig().model_list[0]!.integrity).toBeUndefined();
  });

  it('reports an indeterminate percent when the spec has no size', async () => {
    const engine = new WebLLMEngine();
    const progress: ModelProgress[] = [];
    await engine.load({ ...getModel('qwen2.5-1.5b'), sizeBytes: 0 }, (p) =>
      progress.push(p),
    );

    expect(progress[0]).toMatchObject({
      phase: 'downloading',
      total: 0,
      percent: null,
    });
    expect(progress.at(-1)).toMatchObject({
      phase: 'loading',
      total: 0,
      percent: null,
    });
  });

  it('ignores non-finite progress reports', async () => {
    const engine = new WebLLMEngine();
    const progress: ModelProgress[] = [];
    MLCEngineMock.reloadHook = (instance) => {
      reportProgress(instance, {
        progress: Number.NaN,
        timeElapsed: 0,
        text: 'weird report',
      });
    };

    await engine.load(getModel('qwen2.5-1.5b'), (p) => progress.push(p));

    expect(
      progress.some((p) => p.message === 'weird report' && p.percent === 0),
    ).toBe(true);
  });

  it('rejects with AbortError and unloads the partial engine on abort', async () => {
    let captured: MockEngineInstance | null = null;
    MLCEngineMock.reloadHook = (instance) => {
      captured = instance;
      return new Promise<void>(() => {});
    };

    const engine = new WebLLMEngine();
    const controller = new AbortController();
    const load = engine.load(
      getModel('qwen2.5-1.5b'),
      () => {},
      controller.signal,
    );
    const assertion = expect(load).rejects.toMatchObject({
      name: 'AbortError',
    });

    await vi.waitFor(() => expect(captured).not.toBeNull());
    controller.abort();
    await assertion;

    expect(captured!.unload).toHaveBeenCalledTimes(1);
    expect(engine.isLoaded()).toBe(false);
  });

  it('rejects an already-aborted load before touching WebLLM', async () => {
    const controller = new AbortController();
    controller.abort();
    const engine = new WebLLMEngine();

    await expect(
      engine.load(getModel('qwen2.5-1.5b'), () => {}, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(MLCEngineMock.instances).toHaveLength(0);
  });

  it('releases the partial engine when reload fails and keeps the previous model', async () => {
    const engine = new WebLLMEngine();
    await engine.load(getModel('qwen2.5-1.5b'), () => {});
    const first = lastEngine();

    MLCEngineMock.reloadHook = () => Promise.reject(new Error('device lost'));
    await expect(engine.load(getModel('qwen2.5-3b'), () => {})).rejects.toThrow(
      'device lost',
    );

    expect(lastEngine().unload).toHaveBeenCalledTimes(1);
    expect(first.unload).not.toHaveBeenCalled();
    expect(engine.isLoaded()).toBe(true);
  });

  it('still reports the reload error when releasing the partial engine fails', async () => {
    let captured: MockEngineInstance | null = null;
    MLCEngineMock.reloadHook = (instance) => {
      captured = instance;
      instance.unload.mockRejectedValueOnce(new Error('unload failed'));
      return Promise.reject(new Error('device lost'));
    };

    const engine = new WebLLMEngine();
    await expect(
      engine.load(getModel('qwen2.5-1.5b'), () => {}),
    ).rejects.toThrow('device lost');

    expect(captured!.unload).toHaveBeenCalledTimes(1);
    expect(engine.isLoaded()).toBe(false);
  });

  it('disposes the previous engine when load replaces it', async () => {
    const engine = new WebLLMEngine();
    await engine.load(getModel('qwen2.5-1.5b'), () => {});
    const first = lastEngine();

    await engine.load(getModel('qwen2.5-3b'), () => {});

    expect(first.unload).toHaveBeenCalledTimes(1);
    expect(engine.isLoaded()).toBe(true);
  });

  it('keeps the swap working when disposing the previous engine fails', async () => {
    const engine = new WebLLMEngine();
    await engine.load(getModel('qwen2.5-1.5b'), () => {});
    const first = lastEngine();
    first.unload.mockRejectedValueOnce(new Error('gpu busy'));

    await expect(
      engine.load(getModel('qwen2.5-3b'), () => {}),
    ).resolves.toBeUndefined();
    expect(engine.isLoaded()).toBe(true);
  });

  it('fails clearly when the pinned catalog lacks the resolved id', async () => {
    const saved = prebuiltAppConfigMock.model_list;
    prebuiltAppConfigMock.model_list = [];
    try {
      const engine = new WebLLMEngine();
      await expect(
        engine.load(getModel('qwen2.5-1.5b'), () => {}),
      ).rejects.toThrow(
        /not in the installed @mlc-ai\/web-llm prebuiltAppConfig/,
      );
      expect(MLCEngineMock.instances).toHaveLength(0);
    } finally {
      prebuiltAppConfigMock.model_list = saved;
    }
  });

  it('rejects a malformed config hash before constructing the engine', async () => {
    const engine = new WebLLMEngine({ integrity: { config: 'not-a-hash' } });
    await expect(
      engine.load(getModel('qwen2.5-1.5b'), () => {}),
    ).rejects.toThrow(/Invalid SRI hash for mlc-chat-config\.json/);
    expect(isValidSRIMock).toHaveBeenCalledWith('not-a-hash');
    expect(MLCEngineMock.instances).toHaveLength(0);
  });

  it('rejects a malformed model library hash', async () => {
    const engine = new WebLLMEngine({ integrity: { model_lib: 'nope' } });
    await expect(
      engine.load(getModel('qwen2.5-1.5b'), () => {}),
    ).rejects.toThrow(/Invalid SRI hash for the model library/);
    expect(MLCEngineMock.instances).toHaveLength(0);
  });

  it('rejects a malformed tokenizer hash', async () => {
    const engine = new WebLLMEngine({
      integrity: { tokenizer: { 'tokenizer.json': 'md5-x' } },
    });
    await expect(
      engine.load(getModel('qwen2.5-1.5b'), () => {}),
    ).rejects.toThrow(/Invalid SRI hash for tokenizer file "tokenizer\.json"/);
    expect(MLCEngineMock.instances).toHaveLength(0);
  });

  it('accepts well-formed hashes across every artifact kind', async () => {
    const engine = new WebLLMEngine({
      integrity: {
        config: 'sha256-abc',
        model_lib: 'sha384-def',
        tokenizer: { 'tokenizer.json': 'sha512-ghi' },
      },
    });
    await engine.load(getModel('qwen2.5-1.5b'), () => {});
    expect(MLCEngineMock.instances).toHaveLength(1);
  });

  it('unloads the engine and drops the loaded state', async () => {
    const engine = await loadedEngine();
    const instance = lastEngine();

    await engine.unload();

    expect(instance.unload).toHaveBeenCalledTimes(1);
    expect(engine.isLoaded()).toBe(false);
  });

  it('keeps unload working when disposing fails', async () => {
    const engine = await loadedEngine();
    const instance = lastEngine();
    instance.unload.mockRejectedValueOnce(new Error('gpu busy'));

    await expect(engine.unload()).resolves.toBeUndefined();
    expect(engine.isLoaded()).toBe(false);
  });

  it('rejects generate before load', async () => {
    const engine = new WebLLMEngine();
    await expect(
      engine.generate({ messages: [] }, () => {}, new AbortController().signal),
    ).rejects.toThrow(/not loaded/);
  });

  it('returns an aborted result without streaming when the signal is already aborted', async () => {
    const engine = await loadedEngine();
    const instance = lastEngine();
    const controller = new AbortController();
    controller.abort();

    const result = await engine.generate(
      { messages: [userMessage()] },
      () => {},
      controller.signal,
    );

    expect(result).toEqual({ text: '', tokens: 0, finishReason: 'aborted' });
    expect(instance.chat.completions.create).not.toHaveBeenCalled();
  });

  it('streams deltas to onToken and reports the result, request, and progress', async () => {
    const engine = await loadedEngine();
    const instance = lastEngine();
    instance.chat.completions.create.mockResolvedValue(
      streamOf([
        completionChunk(null),
        completionChunk('Hello'),
        completionChunk(''),
        completionChunk(' world'),
        usageChunk(2),
      ]),
    );

    const tokens: string[] = [];
    const progress: ModelProgress[] = [];
    const result = await engine.generate(
      { messages: [userMessage()], maxTokens: 8, temperature: 0.4 },
      (token) => tokens.push(token),
      new AbortController().signal,
      (p) => progress.push(p),
    );

    expect(tokens).toEqual(['Hello', ' world']);
    expect(result).toEqual({
      text: 'Hello world',
      tokens: 2,
      finishReason: 'stop',
    });

    const request = instance.chat.completions.create.mock
      .calls[0]![0] as Record<string, unknown>;
    expect(request['model']).toBe(MODEL_ID);
    expect(request['stream']).toBe(true);
    expect(request['temperature']).toBe(0.4);
    expect(request['max_tokens']).toBe(8);
    expect(request['stream_options']).toEqual({ include_usage: true });
    expect(request['stop']).toBeUndefined();
    expect(request['messages']).toEqual([{ role: 'user', content: 'hi' }]);

    expect(progress[0]).toMatchObject({
      phase: 'generating',
      loaded: 0,
      total: 8,
      percent: 0,
    });
    expect(progress.at(-1)).toMatchObject({
      phase: 'generating',
      loaded: 2,
      total: 8,
      percent: 25,
    });
  });

  it('prefers usage completion tokens over the delta count', async () => {
    const engine = await loadedEngine();
    const instance = lastEngine();
    instance.chat.completions.create.mockResolvedValue(
      streamOf([completionChunk('Hello world'), usageChunk(5)]),
    );

    const result = await engine.generate(
      { messages: [userMessage()] },
      () => {},
      new AbortController().signal,
    );

    expect(result.tokens).toBe(5);
  });

  it.each([
    ['length', 'length'],
    ['abort', 'aborted'],
    ['tool_calls', 'stop'],
    ['stop', 'stop'],
  ])('maps finish_reason %s to %s', async (reason, expected) => {
    const engine = await loadedEngine();
    const instance = lastEngine();
    instance.chat.completions.create.mockResolvedValue(
      streamOf([completionChunk('ok'), completionChunk(null, reason)]),
    );

    const result = await engine.generate(
      { messages: [userMessage()], maxTokens: 8 },
      () => {},
      new AbortController().signal,
    );

    expect(result.finishReason).toBe(expected);
  });

  it('reports length when a missing finish reason reaches the token cap', async () => {
    const engine = await loadedEngine();
    const instance = lastEngine();
    instance.chat.completions.create.mockResolvedValue(
      streamOf([completionChunk('a'), completionChunk('b')]),
    );

    const result = await engine.generate(
      { messages: [userMessage()], maxTokens: 2 },
      () => {},
      new AbortController().signal,
    );

    expect(result.finishReason).toBe('length');
  });

  it('passes stop sequences to WebLLM and strips them from the result', async () => {
    const engine = await loadedEngine();
    const instance = lastEngine();
    instance.chat.completions.create.mockResolvedValue(
      streamOf([
        completionChunk('Hello'),
        completionChunk(' world'),
        completionChunk(null, 'stop'),
      ]),
    );

    const result = await engine.generate(
      { messages: [userMessage()], stop: [' world'] },
      () => {},
      new AbortController().signal,
    );

    expect(result.text).toBe('Hello');
    expect(result.finishReason).toBe('stop');
    const request = instance.chat.completions.create.mock
      .calls[0]![0] as Record<string, unknown>;
    expect(request['stop']).toEqual([' world']);
  });

  it('accepts a grammar without forwarding it as a constraint', async () => {
    const engine = await loadedEngine();
    const instance = lastEngine();
    instance.chat.completions.create.mockResolvedValue(
      streamOf([completionChunk('x'), usageChunk(1)]),
    );

    await engine.generate(
      { messages: [userMessage()], grammar: 'root ::= "x"' },
      () => {},
      new AbortController().signal,
    );

    const request = instance.chat.completions.create.mock
      .calls[0]![0] as Record<string, unknown>;
    expect(request['response_format']).toBeUndefined();
  });

  it('interrupts the engine and reports aborted when the signal fires mid-stream', async () => {
    const engine = await loadedEngine();
    const instance = lastEngine();
    const controller = new AbortController();

    let endStream: (() => void) | undefined;
    instance.interruptGenerate.mockImplementation(async () => {
      endStream?.();
    });
    instance.chat.completions.create.mockImplementation(async function* () {
      yield completionChunk('Hello');
      await new Promise<void>((resolve) => {
        endStream = resolve;
      });
      yield completionChunk(' world');
    });

    const tokens: string[] = [];
    const pending = engine.generate(
      { messages: [userMessage()] },
      (token) => tokens.push(token),
      controller.signal,
    );

    await vi.waitFor(() => expect(endStream).toBeDefined());
    controller.abort();
    const result = await pending;

    expect(instance.interruptGenerate).toHaveBeenCalledTimes(1);
    expect(tokens).toEqual(['Hello']);
    expect(result.text).toBe('Hello');
    expect(result.finishReason).toBe('aborted');
  });

  it('propagates stream errors instead of reporting an error finish reason', async () => {
    const engine = await loadedEngine();
    const instance = lastEngine();
    instance.chat.completions.create.mockImplementation(async function* () {
      yield completionChunk('Hello');
      throw new Error('shader exploded');
    });

    await expect(
      engine.generate(
        { messages: [userMessage()] },
        () => {},
        new AbortController().signal,
      ),
    ).rejects.toThrow('shader exploded');
  });

  it('propagates request creation failures', async () => {
    const engine = await loadedEngine();
    const instance = lastEngine();
    instance.chat.completions.create.mockRejectedValue(
      new Error('webgpu unavailable'),
    );

    await expect(
      engine.generate(
        { messages: [userMessage()] },
        () => {},
        new AbortController().signal,
      ),
    ).rejects.toThrow('webgpu unavailable');
  });
});

describe('toChatMessages', () => {
  it('converts system and user turns', () => {
    const messages: Message[] = [
      { id: '1', role: 'system', content: 'be terse', timestamp: 0 },
      { id: '2', role: 'user', content: 'hi', timestamp: 0 },
    ];
    expect(toChatMessages(messages)).toEqual([
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hi' },
    ]);
  });

  it('converts assistant tool calls with JSON-stringified arguments', () => {
    const messages: Message[] = [
      {
        id: '1',
        role: 'assistant',
        content: '',
        timestamp: 0,
        toolCalls: [
          { id: 'call-1', name: 'list_dir', arguments: { path: '/' }, raw: '' },
        ],
      },
    ];
    expect(toChatMessages(messages)).toEqual([
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'list_dir', arguments: '{"path":"/"}' },
          },
        ],
      },
    ]);
  });

  it('pairs assistant tool results with their call ids by position', () => {
    const messages: Message[] = [
      {
        id: '1',
        role: 'assistant',
        content: '',
        timestamp: 0,
        toolCalls: [{ id: 'call-1', name: 'list_dir', arguments: {}, raw: '' }],
        toolResults: [
          { ok: true, content: 'a.txt' },
          { ok: true, content: 'b.txt' },
        ],
      },
    ];
    expect(toChatMessages(messages)).toEqual([
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'list_dir', arguments: '{}' },
          },
        ],
      },
      { role: 'tool', content: 'a.txt', tool_call_id: 'call-1' },
      { role: 'tool', content: 'b.txt', tool_call_id: 'ghostshell-tool-1' },
    ]);
  });

  it('gives standalone tool messages a synthetic id', () => {
    const messages: Message[] = [
      { id: '1', role: 'tool', content: 'output', timestamp: 0 },
    ];
    expect(toChatMessages(messages)).toEqual([
      { role: 'tool', content: 'output', tool_call_id: 'ghostshell-tool-1' },
    ]);
  });

  it('serializes missing arguments as an empty object', () => {
    const call = {
      id: 'c',
      name: 'ping',
      arguments: undefined,
      raw: '',
    } as unknown as ToolCall;
    const messages: Message[] = [
      {
        id: '1',
        role: 'assistant',
        content: '',
        timestamp: 0,
        toolCalls: [call],
      },
    ];
    expect(toChatMessages(messages)).toEqual([
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'c',
            type: 'function',
            function: { name: 'ping', arguments: '{}' },
          },
        ],
      },
    ]);
  });
});

describe('verifyArtifact', () => {
  it('delegates to WebLLM verification for a valid SRI', async () => {
    const data = new ArrayBuffer(8);
    await verifyArtifact(data, 'sha256-abc', 'https://example.test/model.bin');
    expect(verifyIntegrityMock).toHaveBeenCalledWith(
      data,
      'sha256-abc',
      'https://example.test/model.bin',
      'error',
    );
  });

  it('rejects a malformed SRI before verifying', async () => {
    await expect(
      verifyArtifact(new ArrayBuffer(0), 'md5-nope', 'u'),
    ).rejects.toThrow(/Invalid SRI hash/);
    expect(verifyIntegrityMock).not.toHaveBeenCalled();
  });
});
