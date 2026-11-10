import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The real `@huggingface/transformers` module is never loaded in tests: no
 * model is downloaded and no ONNX runtime is instantiated. `pipeline` is
 * replaced with a mock that resolves to a callable fake pipeline whose
 * tokenizer is a stub.
 */
const { pipelineMock, envMock, TextStreamerMock } = vi.hoisted(() => {
  const pipelineMock = vi.fn();

  const envMock = {
    useBrowserCache: false,
    useFSCache: false,
    useCustomCache: false,
    customCache: null as unknown,
    cacheDir: '.cache',
  };

  class TextStreamerMock {
    tokenizer: unknown;
    callback_function: ((text: string) => void) | null = null;
    token_callback_function: ((ids: bigint[]) => void) | null = null;
    skip_prompt = false;

    constructor(tokenizer: unknown, options: Record<string, unknown> = {}) {
      this.tokenizer = tokenizer;
      this.callback_function =
        (options['callback_function'] as ((text: string) => void) | undefined) ?? null;
      this.token_callback_function =
        (options['token_callback_function'] as ((ids: bigint[]) => void) | undefined) ?? null;
      this.skip_prompt = Boolean(options['skip_prompt']);
    }

    put(value: bigint[][]): void {
      const tokens = value[0] ?? [];
      this.token_callback_function?.(tokens);
      const text = tokens.map(tokenText).join('');
      if (text.length > 0) this.callback_function?.(text);
    }

    end(): void {
      // The real streamer flushes its cache here; the mock has none.
    }
  }

  const tokenText = (token: bigint): string => {
    switch (token) {
      case 1n:
        return 'Hello';
      case 2n:
        return ' world';
      default:
        return '';
    }
  };

  return { pipelineMock, envMock, TextStreamerMock };
});

vi.mock('@huggingface/transformers', () => ({
  pipeline: pipelineMock,
  env: envMock,
  TextStreamer: TextStreamerMock,
}));

import type { LoadProgress } from '@/types/index.js';
import { TransformersEngine } from '@/core/llm/transformers.js';
import { createEngine, detectBackend, supportsBackend } from '@/core/llm/engine.js';
import { getModel, listModels, recommendModel, resolveModelRepo } from '@/core/llm/models.js';

interface StreamerLike {
  put(value: bigint[][]): void;
  end(): void;
}

interface GeneratorOptions {
  streamer?: StreamerLike;
  max_new_tokens?: number;
  temperature?: number;
  [key: string]: unknown;
}

function makeTokenizer() {
  return {
    apply_chat_template: vi.fn(() => '<|im_start|>assistant\n'),
    encode: vi.fn(() => [1, 2, 3]),
  };
}

function makeGenerator(onGenerate?: (options: GeneratorOptions) => void | Promise<void>) {
  const tokenizer = makeTokenizer();
  const fn = vi.fn(async (_prompt: string, options: GeneratorOptions = {}) => {
    if (onGenerate) await onGenerate(options);
    return [{ generated_text: 'Hello world' }];
  });
  return Object.assign(fn, { tokenizer, dispose: vi.fn(async () => {}) });
}

describe('TransformersEngine', () => {
  beforeEach(() => {
    pipelineMock.mockReset();
    envMock.useBrowserCache = false;
    envMock.useFSCache = false;
    envMock.useCustomCache = false;
    envMock.customCache = null;
  });

  it('loads through the text-generation pipeline and reports progress', async () => {
    pipelineMock.mockResolvedValue(makeGenerator());
    const engine = new TransformersEngine({ device: 'wasm', cache: 'browser' });
    const progress: LoadProgress[] = [];

    await engine.load(getModel('qwen2.5-1.5b'), (p) => progress.push(p));

    expect(pipelineMock).toHaveBeenCalledTimes(1);
    const [task, repo, options] = pipelineMock.mock.calls[0]!;
    expect(task).toBe('text-generation');
    expect(repo).toBe('onnx-community/Qwen2.5-1.5B-Instruct');
    expect(options['device']).toBe('wasm');
    expect(options['progress_callback']).toBeTypeOf('function');
    expect(engine.isLoaded()).toBe(true);
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[0]!.phase).toBe('downloading');
  });

  it('streams tokens and returns the generated text', async () => {
    pipelineMock.mockResolvedValue(
      makeGenerator((options) => {
        options.streamer?.put([[1n, 2n]]);
        options.streamer?.end();
      }),
    );
    const engine = new TransformersEngine({ device: 'wasm', cache: 'browser' });
    await engine.load(getModel('qwen2.5-1.5b'), () => {});

    const tokens: string[] = [];
    const controller = new AbortController();
    const result = await engine.generate(
      { messages: [{ id: 'm1', role: 'user', content: 'hi', timestamp: 0 }] },
      (token) => tokens.push(token),
      controller.signal,
    );

    expect(tokens.join('')).toBe('Hello world');
    expect(result.text).toBe('Hello world');
    expect(result.tokens).toBe(2);
    expect(result.finishReason).toBe('stop');
  });

  it('stops on a stop string and truncates the output', async () => {
    pipelineMock.mockResolvedValue(
      makeGenerator((options) => {
        options.streamer?.put([[1n]]);
        options.streamer?.put([[2n]]);
        options.streamer?.end();
      }),
    );
    const engine = new TransformersEngine({ device: 'wasm', cache: 'browser' });
    await engine.load(getModel('qwen2.5-1.5b'), () => {});

    const result = await engine.generate(
      { messages: [], stop: [' world'] },
      () => {},
      new AbortController().signal,
    );

    expect(result.text).toBe('Hello');
    expect(result.finishReason).toBe('stop');
  });

  it('honors an already-aborted signal without calling the pipeline', async () => {
    const generator = makeGenerator();
    pipelineMock.mockResolvedValue(generator);
    const engine = new TransformersEngine({ device: 'wasm', cache: 'browser' });
    await engine.load(getModel('qwen2.5-1.5b'), () => {});

    const controller = new AbortController();
    controller.abort();
    const result = await engine.generate({ messages: [] }, () => {}, controller.signal);

    expect(result.finishReason).toBe('aborted');
    expect(generator).not.toHaveBeenCalled();
  });

  it('stops when aborted mid-stream', async () => {
    const controller = new AbortController();
    const generator = makeGenerator((options) => {
      controller.abort();
      options.streamer?.put([[1n]]);
    });
    pipelineMock.mockResolvedValue(generator);
    const engine = new TransformersEngine({ device: 'wasm', cache: 'browser' });
    await engine.load(getModel('qwen2.5-1.5b'), () => {});

    const result = await engine.generate({ messages: [] }, () => {}, controller.signal);

    expect(result.finishReason).toBe('aborted');
  });

  it('unloads the pipeline', async () => {
    const generator = makeGenerator();
    pipelineMock.mockResolvedValue(generator);
    const engine = new TransformersEngine({ device: 'wasm', cache: 'browser' });
    await engine.load(getModel('qwen2.5-1.5b'), () => {});

    await engine.unload();

    expect(engine.isLoaded()).toBe(false);
    expect(generator.dispose).toHaveBeenCalled();
  });

  it('counts tokens with the loaded tokenizer', async () => {
    pipelineMock.mockResolvedValue(makeGenerator());
    const engine = new TransformersEngine({ device: 'wasm', cache: 'browser' });
    await engine.load(getModel('qwen2.5-1.5b'), () => {});

    await expect(engine.countTokens('abc')).resolves.toBe(3);
  });

  it('rejects generate before load', async () => {
    const engine = new TransformersEngine({ device: 'wasm', cache: 'browser' });
    const controller = new AbortController();
    await expect(engine.generate({ messages: [] }, () => {}, controller.signal)).rejects.toThrow(
      /not loaded/,
    );
  });
});

describe('createEngine', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('creates a transformers engine on the detected backend', () => {
    vi.stubGlobal('navigator', {});
    const engine = createEngine('transformers');
    expect(engine.id).toBe('transformers');
    expect(engine.kind).toBe('wasm');
  });

  it('creates a webllm engine', () => {
    const engine = createEngine('webllm');
    expect(engine.id).toBe('webllm');
    expect(engine.kind).toBe('webgpu');
  });
});

describe('detectBackend', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('detects webgpu when navigator.gpu exists', () => {
    vi.stubGlobal('navigator', { gpu: {} });
    expect(detectBackend()).toBe('webgpu');
  });

  it('falls back to wasm without webgpu', () => {
    vi.stubGlobal('navigator', {});
    expect(detectBackend()).toBe('wasm');
  });
});

describe('models', () => {
  it('resolves GGUF repos to ONNX for transformers only', () => {
    const spec = getModel('qwen2.5-1.5b');
    expect(resolveModelRepo(spec, 'transformers')).toBe('onnx-community/Qwen2.5-1.5B-Instruct');
    expect(resolveModelRepo(spec, 'webllm')).toBe(spec.repo);
  });

  it('recommends 3B only with a GPU and enough memory', () => {
    expect(recommendModel(true, 24).id).toBe('qwen2.5-3b');
    expect(recommendModel(true, 8).id).toBe('qwen2.5-1.5b');
    expect(recommendModel(false, 24).id).toBe('qwen2.5-1.5b');
  });

  it('returns copies from the registry', () => {
    const models = listModels();
    expect(models.length).toBeGreaterThan(0);
    const firstName = models[0]!.name;
    models[0]!.name = 'mutated';
    expect(getModel(models[0]!.id).name).toBe(firstName);
  });

  it('treats wasm as the universal fallback', () => {
    const spec = getModel('qwen2.5-1.5b');
    expect(supportsBackend(spec, 'wasm')).toBe(true);
    expect(supportsBackend(spec, 'webgpu')).toBe(false);
  });
});
