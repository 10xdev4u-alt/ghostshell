import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

function toolCallBlock(name: string, args: unknown): string {
  return `<tool_call>\n${JSON.stringify({ name, arguments: args })}\n</tool_call>`;
}

function toolResponseTurn(...contents: string[]): string {
  return contents
    .map((content) => `<tool_response>\n${content}\n</tool_response>`)
    .join('\n');
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
  // OPFS is treated as present unless a test overrides this stub.
  vi.stubGlobal('navigator', { storage: { getDirectory: vi.fn() } });
});

afterEach(() => {
  vi.unstubAllGlobals();
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

  it('falls back to the Cache API when OPFS is unavailable', async () => {
    vi.stubGlobal('navigator', {});
    const engine = new WebLLMEngine();
    await engine.load(getModel('qwen2.5-1.5b'), () => {});

    expect(appConfig().cacheBackend).toBe('cache');
  });

  it('keeps an explicitly requested backend even without OPFS', async () => {
    vi.stubGlobal('navigator', {});
    const engine = new WebLLMEngine({ cache: 'indexeddb' });
    await engine.load(getModel('qwen2.5-1.5b'), () => {});

    expect(appConfig().cacheBackend).toBe('indexeddb');
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

  it('stops reporting progress once the load is cancelled', async () => {
    let captured: MockEngineInstance | null = null;
    MLCEngineMock.reloadHook = (instance) => {
      captured = instance;
      return new Promise<void>(() => {});
    };

    const engine = new WebLLMEngine();
    const controller = new AbortController();
    const progress: ModelProgress[] = [];
    const load = engine.load(
      getModel('qwen2.5-1.5b'),
      (p) => progress.push(p),
      controller.signal,
    );
    await vi.waitFor(() => expect(captured).not.toBeNull());
    expect(progress.length).toBeGreaterThan(0);
    const countAfterStart = progress.length;

    controller.abort();
    await expect(load).rejects.toMatchObject({ name: 'AbortError' });

    // A late progress callback from WebLLM must not reach the caller.
    reportProgress(captured!, {
      progress: 0.5,
      timeElapsed: 1,
      text: 'late',
    });
    expect(progress).toHaveLength(countAfterStart);
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

    // Once immediately, once more when the reload promise settles.
    await vi.waitFor(() =>
      expect(lastEngine().unload).toHaveBeenCalledTimes(2),
    );
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

    // The first release fails; the deferred settle-time release still runs.
    await vi.waitFor(() => expect(captured!.unload).toHaveBeenCalledTimes(2));
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

  it('releases a superseded load instead of swapping it in', async () => {
    let releaseFirst: (() => void) | undefined;
    MLCEngineMock.reloadHook = (instance) => {
      if (MLCEngineMock.instances.length === 1) {
        return new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return Promise.resolve();
    };

    const engine = new WebLLMEngine();
    const first = engine.load(getModel('qwen2.5-1.5b'), () => {});
    await vi.waitFor(() => expect(MLCEngineMock.instances).toHaveLength(1));
    const second = engine.load(getModel('qwen2.5-3b'), () => {});
    await second;

    // The newer load owns the engine now.
    expect(engine.isLoaded()).toBe(true);
    expect(lastEngine().reload).toHaveBeenCalledWith(
      'Qwen2.5-3B-Instruct-q4f16_1-MLC',
    );

    // Let the stale load finish: it must dispose itself and leave state alone.
    releaseFirst?.();
    await expect(first).resolves.toBeUndefined();
    // Once on cancellation, once when the reload promise settles.
    await vi.waitFor(() =>
      expect(MLCEngineMock.instances[0]!.unload).toHaveBeenCalledTimes(2),
    );
    expect(lastEngine().unload).not.toHaveBeenCalled();
    expect(engine.isLoaded()).toBe(true);
  });

  it('disposes again when the reload settles after cancellation', async () => {
    let releaseReload: (() => void) | undefined;
    MLCEngineMock.reloadHook = () =>
      new Promise<void>((resolve) => {
        releaseReload = resolve;
      });

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
    await vi.waitFor(() => expect(releaseReload).toBeDefined());
    controller.abort();
    await assertion;

    // Cancellation unloads immediately...
    expect(lastEngine().unload).toHaveBeenCalledTimes(1);

    // ...and a reload that settles late must not leave resources behind.
    releaseReload?.();
    await vi.waitFor(() =>
      expect(lastEngine().unload).toHaveBeenCalledTimes(2),
    );
    expect(engine.isLoaded()).toBe(false);
  });

  it('does not clobber a newer load while disposing the previous engine', async () => {
    const engine = new WebLLMEngine();
    await engine.load(getModel('qwen2.5-1.5b'), () => {});
    const initial = lastEngine();

    let releaseUnload: (() => void) | undefined;
    const unloadGate = new Promise<void>((resolve) => {
      releaseUnload = resolve;
    });
    initial.unload.mockImplementation(() => unloadGate);

    const stale = engine.load(getModel('qwen2.5-3b'), () => {});
    await vi.waitFor(() => expect(initial.unload).toHaveBeenCalled());

    // Both loads now wait on the same blocked disposal of `initial`.
    const winner = engine.load(getModel('qwen2.5-3b'), () => {});
    await vi.waitFor(() => expect(initial.unload).toHaveBeenCalledTimes(2));
    releaseUnload?.();
    await Promise.all([stale, winner]);

    // The stale candidate is disposed rather than swapped in.
    const staleCandidate = MLCEngineMock.instances[1]!;
    expect(staleCandidate.unload).toHaveBeenCalledTimes(1);

    // The winner owns the active engine.
    expect(engine.isLoaded()).toBe(true);
    const active = lastEngine();
    expect(active).toBe(MLCEngineMock.instances[2]);
    active.chat.completions.create.mockResolvedValue(
      streamOf([
        completionChunk(null),
        completionChunk('ok'),
        completionChunk(''),
        usageChunk(1),
      ]),
    );
    const result = await engine.generate(
      { messages: [userMessage()], maxTokens: 4 },
      () => {},
      new AbortController().signal,
    );
    expect(result.text).toBe('ok');
    expect(staleCandidate.chat.completions.create).not.toHaveBeenCalled();
  });

  it('rejects with AbortError when cancelled during teardown of the previous engine', async () => {
    const engine = new WebLLMEngine();
    await engine.load(getModel('qwen2.5-1.5b'), () => {});
    const initial = lastEngine();

    let releaseUnload: (() => void) | undefined;
    const unloadGate = new Promise<void>((resolve) => {
      releaseUnload = resolve;
    });
    initial.unload.mockImplementation(() => unloadGate);

    const controller = new AbortController();
    const pending = engine.load(
      getModel('qwen2.5-3b'),
      () => {},
      controller.signal,
    );
    await vi.waitFor(() => expect(initial.unload).toHaveBeenCalled());

    controller.abort();
    releaseUnload?.();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });

    // The cancelled candidate is disposed and never swapped in.
    expect(lastEngine().unload).toHaveBeenCalledTimes(1);
    expect(engine.isLoaded()).toBe(false);
  });

  it('stays unloaded when unload runs while disposing the previous engine', async () => {
    const engine = new WebLLMEngine();
    await engine.load(getModel('qwen2.5-1.5b'), () => {});
    const initial = lastEngine();

    let releaseUnload: (() => void) | undefined;
    const unloadGate = new Promise<void>((resolve) => {
      releaseUnload = resolve;
    });
    initial.unload.mockImplementation(() => unloadGate);

    const pending = engine.load(getModel('qwen2.5-3b'), () => {});
    await vi.waitFor(() => expect(initial.unload).toHaveBeenCalledTimes(1));

    // Teardown is in progress; unload() joins the same disposal.
    const unloading = engine.unload();
    await vi.waitFor(() => expect(initial.unload).toHaveBeenCalledTimes(2));
    releaseUnload?.();
    await Promise.all([pending, unloading]);

    // The superseded candidate is released, not installed.
    expect(engine.isLoaded()).toBe(false);
    expect(lastEngine().unload).toHaveBeenCalledTimes(1);
  });

  it('aborts an in-flight load when unload runs', async () => {
    MLCEngineMock.reloadHook = () => new Promise<void>(() => {});

    const engine = new WebLLMEngine();
    const pending = engine.load(getModel('qwen2.5-1.5b'), () => {});
    await vi.waitFor(() => expect(MLCEngineMock.instances).toHaveLength(1));
    const instance = lastEngine();

    await engine.unload();

    await expect(pending).resolves.toBeUndefined();
    expect(instance.unload).toHaveBeenCalledTimes(1);
    expect(engine.isLoaded()).toBe(false);
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

  it('strips at the earliest stop sequence and drops empty ones', async () => {
    const engine = await loadedEngine();
    const instance = lastEngine();
    instance.chat.completions.create.mockResolvedValue(
      streamOf([
        completionChunk('Hi'),
        completionChunk('\nThere END'),
        completionChunk(null, 'stop'),
      ]),
    );

    const result = await engine.generate(
      { messages: [userMessage()], stop: ['END', '\n', ''] },
      () => {},
      new AbortController().signal,
    );

    // '\n' occurs before 'END'; array order must not decide the cut.
    expect(result.text).toBe('Hi');
    expect(result.finishReason).toBe('stop');
    const request = instance.chat.completions.create.mock
      .calls[0]![0] as Record<string, unknown>;
    expect(request['stop']).toEqual(['END', '\n']);
  });

  it('keeps text intact when only an empty stop string is supplied', async () => {
    const engine = await loadedEngine();
    const instance = lastEngine();
    instance.chat.completions.create.mockResolvedValue(
      streamOf([completionChunk('Hello'), usageChunk(1)]),
    );

    const result = await engine.generate(
      { messages: [userMessage()], stop: [''] },
      () => {},
      new AbortController().signal,
    );

    expect(result.text).toBe('Hello');
    const request = instance.chat.completions.create.mock
      .calls[0]![0] as Record<string, unknown>;
    expect(request['stop']).toBeUndefined();
  });

  it('forwards a grammar as a grammar response-format constraint', async () => {
    const engine = await loadedEngine();
    const instance = lastEngine();
    instance.chat.completions.create.mockResolvedValue(
      streamOf([completionChunk('{"a":1}'), usageChunk(1)]),
    );

    const gbnf = 'space ::= | " "\nroot ::= "x"';
    await engine.generate(
      { messages: [userMessage()], grammar: gbnf },
      () => {},
      new AbortController().signal,
    );

    const request = instance.chat.completions.create.mock
      .calls[0]![0] as Record<string, unknown>;
    expect(request['response_format']).toEqual({
      type: 'grammar',
      // A leading empty alternative is llama.cpp syntax that XGrammar (the
      // library WebLLM compiles grammars with) rejects; rewrite it as an
      // optional group so the constraint survives the round trip.
      grammar: 'space ::=(" ")?\nroot ::= "x"',
    });
  });

  it('omits the response format when no usable grammar is supplied', async () => {
    const engine = await loadedEngine();
    const instance = lastEngine();

    for (const generateRequest of [
      { messages: [userMessage()] },
      { messages: [userMessage()], grammar: '' },
    ]) {
      instance.chat.completions.create.mockClear();
      instance.chat.completions.create.mockResolvedValue(
        streamOf([completionChunk('x'), usageChunk(1)]),
      );
      await engine.generate(
        generateRequest,
        () => {},
        new AbortController().signal,
      );
      const request = instance.chat.completions.create.mock
        .calls[0]![0] as Record<string, unknown>;
      expect(request['response_format']).toBeUndefined();
    }
  });

  it('interrupts the engine and reports aborted when the signal fires mid-stream', async () => {
    const engine = await loadedEngine();
    const instance = lastEngine();
    const controller = new AbortController();

    let endStream: (() => void) | undefined;
    instance.interruptGenerate.mockImplementation(async () => {
      endStream?.();
    });
    instance.chat.completions.create.mockImplementation(() =>
      Promise.resolve(
        (async function* paused(): AsyncIterable<ChatCompletionChunk> {
          yield completionChunk('Hello');
          await new Promise<void>((resolve) => {
            endStream = resolve;
          });
          yield completionChunk(' world');
        })(),
      ),
    );

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
    instance.chat.completions.create.mockImplementation(() =>
      Promise.resolve(
        (async function* failing(): AsyncIterable<ChatCompletionChunk> {
          yield completionChunk('Hello');
          throw new Error('shader exploded');
        })(),
      ),
    );

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

  it('settles promptly when aborted while the request is pending', async () => {
    const engine = await loadedEngine();
    const instance = lastEngine();
    // A request that never settles: only the abort race can resolve generate.
    instance.chat.completions.create.mockReturnValue(new Promise(() => {}));
    const controller = new AbortController();

    const pending = engine.generate(
      { messages: [userMessage()] },
      () => {},
      controller.signal,
    );
    controller.abort();

    const result = await pending;
    expect(result).toEqual({ text: '', tokens: 0, finishReason: 'aborted' });
    expect(instance.interruptGenerate).toHaveBeenCalledTimes(1);
  });

  it('rejects an empty conversation before touching WebLLM', async () => {
    const engine = await loadedEngine();
    const instance = lastEngine();

    await expect(
      engine.generate({ messages: [] }, () => {}, new AbortController().signal),
    ).rejects.toThrow(/at least one message/);
    expect(instance.chat.completions.create).not.toHaveBeenCalled();
  });

  it('rejects a trailing assistant turn before touching WebLLM', async () => {
    const engine = await loadedEngine();
    const instance = lastEngine();

    await expect(
      engine.generate(
        {
          messages: [
            { id: '1', role: 'assistant', content: 'hi', timestamp: 0 },
          ],
        },
        () => {},
        new AbortController().signal,
      ),
    ).rejects.toThrow(/last message must be a user or tool turn/);
    expect(instance.chat.completions.create).not.toHaveBeenCalled();
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

  it('renders assistant tool calls as content blocks Qwen parses back', () => {
    const messages: Message[] = [
      {
        id: '1',
        role: 'assistant',
        content: 'Checking.',
        timestamp: 0,
        toolCalls: [
          { id: 'call-1', name: 'list_dir', arguments: { path: '/' }, raw: '' },
        ],
      },
    ];
    expect(toChatMessages(messages)).toEqual([
      {
        role: 'assistant',
        content: `Checking.\n${toolCallBlock('list_dir', { path: '/' })}`,
      },
    ]);
  });

  it('merges consecutive tool results into one user turn', () => {
    const messages: Message[] = [
      userMessage('hi'),
      {
        id: '2',
        role: 'assistant',
        content: '',
        timestamp: 0,
        toolCalls: [{ id: 'call-1', name: 'list_dir', arguments: {}, raw: '' }],
      },
      { id: '3', role: 'tool', content: 'a.txt', timestamp: 0 },
      { id: '4', role: 'tool', content: 'b.txt', timestamp: 0 },
    ];
    expect(toChatMessages(messages)).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: toolCallBlock('list_dir', {}) },
      { role: 'user', content: toolResponseTurn('a.txt', 'b.txt') },
    ]);
  });

  it('starts a fresh user turn for tool results after another turn', () => {
    const messages: Message[] = [
      { id: '1', role: 'tool', content: 'first', timestamp: 0 },
      { id: '2', role: 'user', content: 'next question', timestamp: 0 },
      { id: '3', role: 'tool', content: 'second', timestamp: 0 },
    ];
    expect(toChatMessages(messages)).toEqual([
      { role: 'user', content: toolResponseTurn('first') },
      { role: 'user', content: 'next question' },
      { role: 'user', content: toolResponseTurn('second') },
    ]);
  });

  it('never emits a tool-role message, which qwen2 templates reject', () => {
    const rendered = toChatMessages([
      userMessage('hi'),
      {
        id: '2',
        role: 'assistant',
        content: '',
        timestamp: 0,
        toolCalls: [{ id: 'c', name: 'ping', arguments: {}, raw: '' }],
      },
      { id: '3', role: 'tool', content: 'pong', timestamp: 0 },
    ]);

    expect(rendered.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
    ]);
    // WebLLM's conversation builder supports exactly these roles.
    expect(
      rendered.every((message) =>
        ['system', 'user', 'assistant'].includes(message.role),
      ),
    ).toBe(true);
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
        content: toolCallBlock('ping', {}),
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
