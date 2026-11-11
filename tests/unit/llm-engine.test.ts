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
import { Template } from '@huggingface/jinja';
import { parseToolCalls } from '@/core/agent/parser.js';
import { TransformersEngine, clearTransformersCache } from '@/core/llm/transformers.js';
import { createEngine, detectBackend, supportsBackend } from '@/core/llm/engine.js';
import {
  getModel,
  listModels,
  ONNX_TARGETS,
  recommendModel,
  resolveModelDtype,
  resolveModelRepo,
} from '@/core/llm/models.js';

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

interface ChatMessageLike {
  role: string;
  content: string;
  tool_calls?: unknown;
}

interface ChatTemplateOptions {
  tools?: unknown[];
  add_generation_prompt?: boolean;
  [key: string]: unknown;
}

function makeTokenizer() {
  return {
    apply_chat_template: vi.fn(
      (_chat: ChatMessageLike[], _options?: ChatTemplateOptions) => '<|im_start|>assistant\n',
    ),
    encode: vi.fn(() => [1, 2, 3]),
  };
}

/**
 * The real Qwen2.5-1.5B-Instruct chat template, copied from its
 * `tokenizer_config.json`. The tools branch is what issue #73 is about.
 */
const QWEN25_CHAT_TEMPLATE = String.raw`{%- if tools %}
    {{- '<|im_start|>system\n' }}
    {%- if messages[0]['role'] == 'system' %}
        {{- messages[0]['content'] }}
    {%- else %}
        {{- 'You are Qwen, created by Alibaba Cloud. You are a helpful assistant.' }}
    {%- endif %}
    {{- "\n\n# Tools\n\nYou may call one or more functions to assist with the user query.\n\nYou are provided with function signatures within <tools></tools> XML tags:\n<tools>" }}
    {%- for tool in tools %}
        {{- "\n" }}
        {{- tool | tojson }}
    {%- endfor %}
    {{- "\n</tools>\n\nFor each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:\n<tool_call>\n{\"name\": <function-name>, \"arguments\": <args-json-object>}\n</tool_call><|im_end|>\n" }}
{%- else %}
    {%- if messages[0]['role'] == 'system' %}
        {{- '<|im_start|>system\n' + messages[0]['content'] + '<|im_end|>\n' }}
    {%- else %}
        {{- '<|im_start|>system\nYou are Qwen, created by Alibaba Cloud. You are a helpful assistant.<|im_end|>\n' }}
    {%- endif %}
{%- endif %}
{%- for message in messages %}
    {%- if (message.role == "user") or (message.role == "system" and not loop.first) or (message.role == "assistant" and not message.tool_calls) %}
        {{- '<|im_start|>' + message.role + '\n' + message.content + '<|im_end|>' + '\n' }}
    {%- elif message.role == "assistant" %}
        {{- '<|im_start|>' + message.role }}
        {%- if message.content %}
            {{- '\n' + message.content }}
        {%- endif %}
        {%- for tool_call in message.tool_calls %}
            {%- if tool_call.function is defined %}
                {%- set tool_call = tool_call.function %}
            {%- endif %}
            {{- '\n<tool_call>\n{"name": "' }}
            {{- tool_call.name }}
            {{- '", "arguments": ' }}
            {{- tool_call.arguments | tojson }}
            {{- '}\n</tool_call>' }}
        {%- endfor %}
        {{- '<|im_end|>\n' }}
    {%- elif message.role == "tool" %}
        {%- if (loop.index0 == 0) or (messages[loop.index0 - 1].role != "tool") %}
            {{- '<|im_start|>user' }}
        {%- endif %}
        {{- '\n<tool_response>\n' }}
        {{- message.content }}
        {{- '\n</tool_response>' }}
        {%- if loop.last or (messages[loop.index0 + 1].role != "tool") %}
            {{- '<|im_end|>\n' }}
        {%- endif %}
    {%- endif %}
{%- endfor %}
{%- if add_generation_prompt %}
    {{- '<|im_start|>assistant\n' }}
{%- endif %}`;

/** A tokenizer stub that renders with the real Qwen2.5 chat template. */
function makeQwenTokenizer() {
  const template = new Template(QWEN25_CHAT_TEMPLATE);
  return {
    apply_chat_template: vi.fn(
      (chat: ChatMessageLike[], options?: ChatTemplateOptions) =>
        template.render({
          messages: chat,
          tools: options?.tools ?? null,
          add_generation_prompt: options?.add_generation_prompt ?? false,
        }),
    ),
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

/** Minimal in-memory OPFS stand-in for the cache tests. */
function makeOPFSRoot() {
  const files = new Map<string, File>();
  return {
    getDirectoryHandle: vi.fn(async (_name: string, options?: { create?: boolean }) => {
      if (!options?.create) throw new DOMException('Not found', 'NotFoundError');
      return {
        getFileHandle: vi.fn(async (name: string, fileOptions?: { create?: boolean }) => {
          if (!files.has(name) && !fileOptions?.create) {
            throw new DOMException('Not found', 'NotFoundError');
          }
          return {
            getFile: async () => {
              const file = files.get(name);
              if (!file) throw new DOMException('Not found', 'NotFoundError');
              return file;
            },
            createWritable: async () => ({
              write: async (data: BlobPart) => {
                files.set(name, new File([data], name));
              },
              close: async () => {},
            }),
          };
        }),
      };
    }),
    removeEntry: vi.fn(async (name: string, options?: { recursive?: boolean }) => {
      if (name !== 'ghostshell-transformers-cache' || !options?.recursive) {
        throw new DOMException('Not found', 'NotFoundError');
      }
      files.clear();
    }),
  };
}

describe('TransformersEngine', () => {
  beforeEach(() => {
    pipelineMock.mockReset();
    envMock.useBrowserCache = false;
    envMock.useFSCache = false;
    envMock.useCustomCache = false;
    envMock.customCache = null;
  });

  afterEach(() => vi.unstubAllGlobals());

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
    expect(options['dtype']).toBe('q8');
    expect(options['progress_callback']).toBeTypeOf('function');
    expect(engine.isLoaded()).toBe(true);
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[0]!.phase).toBe('downloading');
  });

  it('requests the dtype declared by the model ONNX conversion', async () => {
    pipelineMock.mockResolvedValue(makeGenerator());
    const engine = new TransformersEngine({ device: 'wasm', cache: 'browser' });
    await engine.load(getModel('qwen2.5-3b'), () => {});

    const [, repo, options] = pipelineMock.mock.calls[0]!;
    expect(repo).toBe('opalitestudios/Qwen2.5-3B-Instruct-ONNX');
    expect(options['dtype']).toBe('q4f16');
  });

  it('downgrades a WASM-only model to wasm instead of building a webgpu pipeline', async () => {
    pipelineMock.mockResolvedValue(makeGenerator());
    const engine = new TransformersEngine({ device: 'webgpu', cache: 'browser' });
    await engine.load(getModel('qwen2.5-1.5b'), () => {});

    expect(engine.kind).toBe('wasm');
    expect(pipelineMock.mock.calls[0]![2]['device']).toBe('wasm');
  });

  it('keeps webgpu when the model declares it', async () => {
    pipelineMock.mockResolvedValue(makeGenerator());
    const engine = new TransformersEngine({ device: 'webgpu', cache: 'browser' });
    await engine.load({ ...getModel('qwen2.5-1.5b'), backend: 'webgpu' }, () => {});

    expect(engine.kind).toBe('webgpu');
    expect(pipelineMock.mock.calls[0]![2]['device']).toBe('webgpu');
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

  it('uses an OPFS-backed custom cache when OPFS is available', async () => {
    vi.stubGlobal('navigator', { storage: { getDirectory: vi.fn(async () => makeOPFSRoot()) } });
    pipelineMock.mockResolvedValue(makeGenerator());
    const engine = new TransformersEngine({ device: 'wasm', cache: 'opfs' });
    await engine.load(getModel('qwen2.5-1.5b'), () => {});

    expect(envMock.useCustomCache).toBe(true);
    expect(envMock.useFSCache).toBe(false);
    expect(envMock.useBrowserCache).toBe(false);
    expect(envMock.customCache).toHaveProperty('match');
    expect(envMock.customCache).toHaveProperty('put');
  });

  it('stores and retrieves weight responses through the OPFS cache', async () => {
    vi.stubGlobal('navigator', { storage: { getDirectory: vi.fn(async () => makeOPFSRoot()) } });
    pipelineMock.mockResolvedValue(makeGenerator());
    const engine = new TransformersEngine({ device: 'wasm', cache: 'opfs' });
    await engine.load(getModel('qwen2.5-1.5b'), () => {});

    const cache = envMock.customCache as unknown as {
      match(url: string): Promise<Response | undefined>;
      put(url: string, response: Response): Promise<void>;
    };
    await cache.put('https://huggingface.co/weight.bin', new Response('weight-bytes'));

    const matched = await cache.match('https://huggingface.co/weight.bin');
    expect(matched).toBeDefined();
    expect(await matched!.text()).toBe('weight-bytes');
    await expect(cache.match('https://huggingface.co/missing.bin')).resolves.toBeUndefined();
  });

  it('clears the OPFS cache directory (#71)', async () => {
    const root = makeOPFSRoot();
    vi.stubGlobal('navigator', { storage: { getDirectory: vi.fn(async () => root) } });
    pipelineMock.mockResolvedValue(makeGenerator());
    const engine = new TransformersEngine({ device: 'wasm', cache: 'opfs' });
    await engine.load(getModel('qwen2.5-1.5b'), () => {});

    const cache = envMock.customCache as unknown as {
      match(url: string): Promise<Response | undefined>;
      put(url: string, response: Response): Promise<void>;
    };
    await cache.put('https://huggingface.co/weight.bin', new Response('weight-bytes'));
    await expect(cache.match('https://huggingface.co/weight.bin')).resolves.toBeDefined();

    await clearTransformersCache();

    await expect(cache.match('https://huggingface.co/weight.bin')).resolves.toBeUndefined();
    expect(root.removeEntry).toHaveBeenCalledWith('ghostshell-transformers-cache', {
      recursive: true,
    });
  });

  it('uses the filesystem cache for opfs in Node', async () => {
    vi.stubGlobal('navigator', {});
    pipelineMock.mockResolvedValue(makeGenerator());
    const engine = new TransformersEngine({ device: 'wasm', cache: 'opfs' });
    await engine.load(getModel('qwen2.5-1.5b'), () => {});

    expect(envMock.useFSCache).toBe(true);
    expect(envMock.useCustomCache).toBe(false);
    expect(envMock.useBrowserCache).toBe(false);
  });

  it('falls back to the browser cache when OPFS is unavailable', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('caches', {});
    pipelineMock.mockResolvedValue(makeGenerator());
    const engine = new TransformersEngine({ device: 'wasm', cache: 'opfs' });
    await engine.load(getModel('qwen2.5-1.5b'), () => {});

    expect(envMock.useFSCache).toBe(false);
    expect(envMock.useCustomCache).toBe(false);
    expect(envMock.useBrowserCache).toBe(true);
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

  it('passes tool calls and tool messages through to the chat template', async () => {
    const generator = makeGenerator();
    pipelineMock.mockResolvedValue(generator);
    const engine = new TransformersEngine({ device: 'wasm', cache: 'browser' });
    await engine.load(getModel('qwen2.5-1.5b'), () => {});

    await engine.generate(
      {
        messages: [
          { id: 'm1', role: 'user', content: 'list files', timestamp: 0 },
          {
            id: 'm2',
            role: 'assistant',
            content: '',
            timestamp: 0,
            toolCalls: [{ id: 'c1', name: 'list_dir', arguments: { path: '/' }, raw: '' }],
          },
          { id: 'm3', role: 'tool', content: 'a.txt\nb.txt', timestamp: 0 },
        ],
      },
      () => {},
      new AbortController().signal,
    );

    const chat = generator.tokenizer.apply_chat_template.mock.calls[0]![0] as ChatMessageLike[];
    expect(chat[1]).toEqual({
      role: 'assistant',
      content: '',
      tool_calls: [{ function: { name: 'list_dir', arguments: { path: '/' } } }],
    });
    expect(chat[2]).toEqual({ role: 'tool', content: 'a.txt\nb.txt' });
  });

  it('splits legacy toolResults into tool turns', async () => {
    const generator = makeGenerator();
    pipelineMock.mockResolvedValue(generator);
    const engine = new TransformersEngine({ device: 'wasm', cache: 'browser' });
    await engine.load(getModel('qwen2.5-1.5b'), () => {});

    await engine.generate(
      {
        messages: [
          { id: 'm1', role: 'user', content: 'list files', timestamp: 0 },
          {
            id: 'm2',
            role: 'assistant',
            content: '',
            timestamp: 0,
            toolCalls: [{ id: 'c1', name: 'list_dir', arguments: { path: '/' }, raw: '' }],
            toolResults: [{ ok: true, content: 'a.txt\nb.txt' }],
          },
        ],
      },
      () => {},
      new AbortController().signal,
    );

    const chat = generator.tokenizer.apply_chat_template.mock.calls[0]![0] as ChatMessageLike[];
    expect(chat[2]).toEqual({ role: 'tool', content: 'a.txt\nb.txt' });
  });

  it('includes tool calls in the ChatML fallback (#72)', async () => {
    const generator = makeGenerator();
    generator.tokenizer.apply_chat_template = vi.fn(() => {
      throw new Error('no chat template');
    });
    pipelineMock.mockResolvedValue(generator);
    const engine = new TransformersEngine({ device: 'wasm', cache: 'browser' });
    await engine.load(getModel('qwen2.5-1.5b'), () => {});

    await engine.generate(
      {
        messages: [
          { id: 'm1', role: 'user', content: 'list files', timestamp: 0 },
          {
            id: 'm2',
            role: 'assistant',
            content: '',
            timestamp: 0,
            toolCalls: [{ id: 'c1', name: 'list_dir', arguments: { path: '/' }, raw: '' }],
          },
          { id: 'm3', role: 'tool', content: 'a.txt\nb.txt', timestamp: 0 },
        ],
      },
      () => {},
      new AbortController().signal,
    );

    const prompt = generator.mock.calls[0]![0] as string;
    expect(prompt).toContain('<tool_call>');
    expect(prompt).toContain(JSON.stringify({ name: 'list_dir', arguments: { path: '/' } }));
    expect(prompt).toContain('a.txt\nb.txt');

    // The fallback uses the parser's Hermes syntax, so the call round-trips.
    const parsed = parseToolCalls(prompt);
    expect(parsed.strategy).toBe('hermes');
    expect(parsed.toolCalls[0]?.name).toBe('list_dir');
    expect(parsed.toolCalls[0]?.arguments).toEqual({ path: '/' });
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

  it('defaults to wasm for a WASM-only model on a webgpu host', () => {
    vi.stubGlobal('navigator', { gpu: {} });
    const engine = createEngine('transformers', { spec: getModel('qwen2.5-1.5b') });
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

  it('maps every registry model to a verified ONNX target', () => {
    // Verified against the live HF API (HTTP 200) on 2026-11-10. The 3B entry
    // is the community ONNX conversion of Qwen2.5-3B-Instruct; onnx-community
    // has no plain 3B-Instruct conversion.
    expect(ONNX_TARGETS['qwen2.5-1.5b']).toEqual({
      repo: 'onnx-community/Qwen2.5-1.5B-Instruct',
      dtype: 'q8',
    });
    expect(ONNX_TARGETS['qwen2.5-3b']).toEqual({
      repo: 'opalitestudios/Qwen2.5-3B-Instruct-ONNX',
      dtype: 'q4f16',
    });

    for (const spec of listModels()) {
      const target = ONNX_TARGETS[spec.id];
      expect(target, `missing ONNX target for ${spec.id}`).toBeDefined();
      expect(resolveModelRepo(spec, 'transformers')).toBe(target!.repo);
      expect(resolveModelDtype(spec)).toBe(target!.dtype);
    }
  });

  it('resolves the recommended 3B model to a loadable ONNX repo', () => {
    const spec = recommendModel(true, 24);
    expect(spec.id).toBe('qwen2.5-3b');
    expect(resolveModelRepo(spec, 'transformers')).toBe('opalitestudios/Qwen2.5-3B-Instruct-ONNX');
    expect(resolveModelDtype(spec)).toBe('q4f16');
  });

  it('throws a clear error for a model with no ONNX conversion', () => {
    const spec = { ...getModel('qwen2.5-1.5b'), id: 'not-in-registry' };
    expect(() => resolveModelRepo(spec, 'transformers')).toThrow(/No ONNX conversion/);
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

describe('chat template tool schemas', () => {
  beforeEach(() => {
    pipelineMock.mockReset();
    envMock.useBrowserCache = false;
    envMock.useFSCache = false;
    envMock.useCustomCache = false;
    envMock.customCache = null;
  });

  afterEach(() => vi.unstubAllGlobals());

  it('passes tool schemas to a Qwen-style chat template (#73)', async () => {
    const generator = makeGenerator();
    generator.tokenizer.apply_chat_template = makeQwenTokenizer().apply_chat_template;
    pipelineMock.mockResolvedValue(generator);
    const engine = new TransformersEngine({ device: 'wasm', cache: 'browser' });
    await engine.load(getModel('qwen2.5-1.5b'), () => {});

    const tools = [
      {
        name: 'list_dir',
        description: 'List the contents of a directory',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      },
    ];

    await engine.generate(
      {
        messages: [{ id: 'm1', role: 'user', content: 'list files', timestamp: 0 }],
        tools,
      },
      () => {},
      new AbortController().signal,
    );

    const [chat, options] = generator.tokenizer.apply_chat_template.mock.calls[0]!;
    expect(chat).toEqual([{ role: 'user', content: 'list files' }]);
    expect(options?.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'list_dir',
          description: 'List the contents of a directory',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
      },
    ]);
    expect(options?.add_generation_prompt).toBe(true);
    expect(options?.tool_choice).toBe('auto');

    const prompt = generator.mock.calls[0]![0] as string;
    expect(prompt).toContain('<tools>');
    expect(prompt).toContain('"name": "list_dir"');
    expect(prompt).toContain('List the contents of a directory');
  });
});
