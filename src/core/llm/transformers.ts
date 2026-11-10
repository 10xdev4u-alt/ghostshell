import { env, pipeline, TextStreamer } from '@huggingface/transformers';
import type {
  DataType,
  PreTrainedTokenizer,
  ProgressInfo,
  TextGenerationPipelineType,
} from '@huggingface/transformers';
import type {
  BackendKind,
  GenerateRequest,
  GenerateResult,
  LLMEngine,
  LoadProgress,
  Message,
  ModelSpec,
} from '@/types/index.js';
import { resolveModelDtype, resolveModelRepo, supportsBackend } from './models.js';

/**
 * Transformers.js engine (default for v0.1).
 *
 * Uses `@huggingface/transformers` with the ONNX runtime. Weights are fetched
 * from the HF Hub, cached in IndexedDB (or the browser Cache API / OPFS as a
 * fallback), and generation streams through a `TextStreamer`.
 *
 * Browser-first: only Web APIs are used (`indexedDB`, `caches`,
 * `navigator.storage`, `Response`, `TextStreamer`). No Node APIs.
 *
 * See docs/ENGINEERING_PLAN.md §3.2 for the model table and perf budget.
 */

export type CacheBackend = 'indexeddb' | 'opfs' | 'browser';

export interface TransformersEngineOptions {
  /** ONNX runtime device. Defaults to `'wasm'`. */
  device?: BackendKind;
  /**
   * Weight quantization. Defaults to the dtype declared by the model's ONNX
   * conversion (see `resolveModelDtype`).
   */
  dtype?: DataType;
  /** Persistent weight cache. Defaults to `'indexeddb'`. */
  cache?: CacheBackend;
  /** HF revision (branch/tag/commit) to pin. */
  revision?: string;
}

const DEFAULT_MAX_NEW_TOKENS = 512;
const DEFAULT_TEMPERATURE = 0.2;

const CACHE_DB_NAME = 'ghostshell-transformers-cache';
const CACHE_STORE = 'files';
const CACHE_VERSION = 1;

interface CacheRecord {
  url: string;
  body: ArrayBuffer;
  status: number;
  headers: Record<string, string>;
}

/**
 * Transformers.js custom cache backed by IndexedDB.
 *
 * The library's `env.customCache` only asks for the Web Cache API surface
 * (`match` / `put`), so an IndexedDB implementation drops in without touching
 * the loader. IndexedDB is preferred over the Cache API because it is
 * available in workers, survives cache eviction, and gives us a one-call
 * `clearTransformersCache`.
 */
class IndexedDBCache {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(CACHE_DB_NAME, CACHE_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(CACHE_STORE)) {
            db.createObjectStore(CACHE_STORE);
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    return this.dbPromise;
  }

  async match(url: string): Promise<Response | undefined> {
    try {
      const db = await this.open();
      const record = await new Promise<CacheRecord | undefined>((resolve, reject) => {
        const tx = db.transaction(CACHE_STORE, 'readonly');
        const request = tx.objectStore(CACHE_STORE).get(url);
        request.onsuccess = () => resolve(request.result as CacheRecord | undefined);
        request.onerror = () => reject(request.error);
      });
      if (!record) return undefined;
      return new Response(record.body, { status: record.status, headers: record.headers });
    } catch {
      return undefined;
    }
  }

  async put(url: string, response: Response): Promise<void> {
    try {
      const db = await this.open();
      const body = await response.arrayBuffer();
      const headers: Record<string, string> = {};
      response.headers?.forEach?.((value, key) => {
        headers[key] = value;
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(CACHE_STORE, 'readwrite');
        tx.objectStore(CACHE_STORE).put({ url, body, status: response.status, headers }, url);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      // Cache writes are best-effort; a quota error must not break loading.
    }
  }
}

const OPFS_CACHE_DIR = 'ghostshell-transformers-cache';

/**
 * Transformers.js custom cache backed by the Origin Private File System.
 *
 * `env.useFSCache` is the Node `fs`-backed `FileCache` and throws in a browser
 * (`hub.js:458-464`), so the browser path needs its own `env.customCache`. The
 * library only asks for the Web Cache API surface (`match` / `put`), which maps
 * directly onto OPFS files. Writes are best-effort: a quota error must not
 * break loading.
 */
class OPFSCache {
  private dirPromise: Promise<FileSystemDirectoryHandle> | null = null;

  private directory(): Promise<FileSystemDirectoryHandle> {
    if (!this.dirPromise) {
      this.dirPromise = navigator.storage
        .getDirectory()
        .then((root) => root.getDirectoryHandle(OPFS_CACHE_DIR, { create: true }));
    }
    return this.dirPromise;
  }

  async match(url: string): Promise<Response | undefined> {
    try {
      const dir = await this.directory();
      const handle = await dir.getFileHandle(await cacheKey(url));
      const file = await handle.getFile();
      if (file.size === 0) return undefined;
      return new Response(await file.arrayBuffer(), {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      });
    } catch {
      return undefined;
    }
  }

  async put(url: string, response: Response): Promise<void> {
    try {
      const dir = await this.directory();
      const handle = await dir.getFileHandle(await cacheKey(url), { create: true });
      const writable = await handle.createWritable();
      await writable.write(await response.arrayBuffer());
      await writable.close();
    } catch {
      // Cache writes are best-effort; a quota error must not break loading.
    }
  }
}

/**
 * Map a cache key (an HF URL) to a stable OPFS file name. SHA-256 when WebCrypto
 * is available, with a non-secure-context fallback.
 */
async function cacheKey(url: string): Promise<string> {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url));
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  }
  let hash = 0x811c9dc5;
  for (let index = 0; index < url.length; index += 1) {
    hash ^= url.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${(hash >>> 0).toString(16).padStart(8, '0')}-${url.length.toString(16)}`;
}

/** True when running under Node rather than in a browser. */
function isNode(): boolean {
  return (
    typeof window === 'undefined' &&
    typeof process !== 'undefined' &&
    process.versions != null &&
    process.versions.node != null
  );
}

/** Delete the IndexedDB weight cache. Safe to call when it does not exist. */
export async function clearTransformersCache(): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(CACHE_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

/**
 * A `TextStreamer` that honors an `AbortSignal`.
 *
 * Transformers.js has no native abort support, but `model.generate` calls
 * `streamer.put(...)` on every decoded token. Throwing from `put` unwinds the
 * generation loop, so an aborted stream stops the model instead of merely
 * ignoring the rest of the output.
 */
class AbortableTextStreamer extends TextStreamer {
  private readonly signal: AbortSignal;

  constructor(
    tokenizer: PreTrainedTokenizer,
    options: {
      signal: AbortSignal;
      onToken: (text: string) => void;
      onTokenIds: (ids: bigint[]) => void;
    },
  ) {
    super(tokenizer, {
      skip_prompt: true,
      skip_special_tokens: true,
      callback_function: options.onToken,
      token_callback_function: options.onTokenIds,
    });
    this.signal = options.signal;
  }

  override put(value: bigint[][]): void {
    if (this.signal.aborted) throw new AbortGenerationError();
    super.put(value);
  }

  override end(): void {
    if (this.signal.aborted) throw new AbortGenerationError();
    super.end();
  }
}

class AbortGenerationError extends Error {
  constructor() {
    super('Generation aborted');
    this.name = 'AbortError';
  }
}

/** Raised from the token callback when a stop string is emitted. */
class StopGenerationError extends Error {
  readonly stopString: string;

  constructor(stopString: string) {
    super(`Generation stopped on ${JSON.stringify(stopString)}`);
    this.name = 'StopGenerationError';
    this.stopString = stopString;
  }
}

function hasOPFS(): boolean {
  if (typeof navigator === 'undefined' || !('storage' in navigator)) return false;
  const storage = navigator.storage as unknown as { getDirectory?: unknown };
  return typeof storage.getDirectory === 'function';
}

function toLoadProgress(info: ProgressInfo, spec: ModelSpec): LoadProgress {
  const fallbackTotal = spec.sizeBytes;
  switch (info.status) {
    case 'initiate':
    case 'download':
      return {
        phase: 'downloading',
        loaded: 0,
        total: fallbackTotal,
        message: `Downloading ${info.file}`,
      };
    case 'progress':
      return {
        phase: 'downloading',
        loaded: info.loaded,
        total: info.total,
        message: `Downloading ${info.file}`,
      };
    case 'done':
      return {
        phase: 'downloading',
        loaded: fallbackTotal,
        total: fallbackTotal,
        message: `Downloaded ${info.file}`,
      };
    case 'ready':
      return {
        phase: 'loading',
        loaded: fallbackTotal,
        total: fallbackTotal,
        message: `Ready: ${info.task}`,
      };
    default:
      return { phase: 'loading', loaded: 0, total: fallbackTotal, message: 'Loading model' };
  }
}

export class TransformersEngine implements LLMEngine {
  readonly id = 'transformers';
  private deviceKind: BackendKind;

  private readonly dtype: DataType | undefined;
  private readonly cache: CacheBackend;
  private readonly revision: string | undefined;
  private generator: TextGenerationPipelineType | null = null;
  private loaded = false;

  constructor(options: TransformersEngineOptions = {}) {
    this.deviceKind = options.device ?? 'wasm';
    this.dtype = options.dtype;
    this.cache = options.cache ?? 'indexeddb';
    this.revision = options.revision;
  }

  /** Device the loaded pipeline runs on. Downgraded to WASM for WASM-only models. */
  get kind(): BackendKind {
    return this.deviceKind;
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  async load(spec: ModelSpec, onProgress: (p: LoadProgress) => void): Promise<void> {
    this.configureCache();

    // A model validated only on WASM must never build a WebGPU pipeline, even
    // when the host (or `detectBackend`) asked for WebGPU.
    if (!supportsBackend(spec, this.deviceKind)) {
      this.deviceKind = 'wasm';
    }

    const repo = resolveModelRepo(spec, 'transformers');
    const dtype = this.dtype ?? resolveModelDtype(spec);
    onProgress({
      phase: 'downloading',
      loaded: 0,
      total: spec.sizeBytes,
      message: `Loading ${spec.name}`,
    });

    const generator = (await pipeline<'text-generation'>('text-generation', repo, {
      device: this.kind,
      dtype,
      ...(this.revision ? { revision: this.revision } : {}),
      progress_callback: (info: ProgressInfo) => onProgress(toLoadProgress(info, spec)),
    })) as unknown as TextGenerationPipelineType;
    this.generator = generator;

    this.loaded = true;
    onProgress({
      phase: 'loading',
      loaded: spec.sizeBytes,
      total: spec.sizeBytes,
      message: `${spec.name} ready`,
    });
  }

  async unload(): Promise<void> {
    const generator = this.generator;
    this.generator = null;
    this.loaded = false;
    if (generator) {
      try {
        await generator.dispose();
      } catch {
        // Disposing a partially-loaded pipeline is best-effort.
      }
    }
  }

  async generate(
    req: GenerateRequest,
    onToken: (token: string) => void,
    signal: AbortSignal,
  ): Promise<GenerateResult> {
    const generator = this.generator;
    if (!generator) {
      throw new Error('TransformersEngine: model is not loaded');
    }
    if (signal.aborted) {
      return { text: '', tokens: 0, finishReason: 'aborted' };
    }

    const tokenizer = generator.tokenizer;
    const prompt = this.applyChatTemplate(req.messages, tokenizer);
    const maxTokens = req.maxTokens ?? DEFAULT_MAX_NEW_TOKENS;
    const temperature = req.temperature ?? DEFAULT_TEMPERATURE;

    const chunks: string[] = [];
    const stopStrings = req.stop ?? [];
    let generatedTokens = 0;

    const streamer = new AbortableTextStreamer(tokenizer, {
      signal,
      onToken: (text) => {
        chunks.push(text);
        onToken(text);
        if (stopStrings.length === 0) return;
        const joined = chunks.join('');
        const hit = stopStrings.find((stop) => joined.includes(stop));
        if (hit !== undefined) throw new StopGenerationError(hit);
      },
      onTokenIds: (ids) => {
        generatedTokens += ids.length;
      },
    });

    // `req.grammar` is honored by engines with constrained decoding (WebLLM
    // JSON mode, llama.cpp). Transformers.js has no GBNF/logits-constraint
    // support, so tool-call turns fall back to the parser chain. The grammar
    // is still accepted here so callers can treat engines uniformly.
    const options = {
      max_new_tokens: maxTokens,
      temperature,
      do_sample: temperature > 0,
      return_full_text: false,
      streamer,
    };

    let finishReason: GenerateResult['finishReason'] = 'stop';
    let stoppedOn: string | undefined;
    try {
      await generator(prompt, options);
    } catch (err) {
      if (signal.aborted) {
        finishReason = 'aborted';
      } else if (err instanceof StopGenerationError) {
        finishReason = 'stop';
        stoppedOn = err.stopString;
      } else {
        finishReason = 'error';
        throw err;
      }
    }

    let text = chunks.join('');
    if (stoppedOn !== undefined) {
      const index = text.indexOf(stoppedOn);
      text = index === -1 ? text : text.slice(0, index);
    }
    const tokens =
      generatedTokens > 0 ? generatedTokens : this.countTokensSync(text, tokenizer);
    if (finishReason === 'stop' && stoppedOn === undefined && tokens >= maxTokens) {
      finishReason = 'length';
    }

    return { text, tokens, finishReason };
  }

  /** Token count for context management. Exact when the tokenizer is loaded. */
  async countTokens(text: string): Promise<number> {
    const tokenizer = this.generator?.tokenizer;
    if (!tokenizer) return Math.ceil(text.length / 4);
    return this.countTokensSync(text, tokenizer);
  }

  private countTokensSync(text: string, tokenizer: PreTrainedTokenizer): number {
    try {
      const ids = tokenizer.encode(text, { add_special_tokens: false });
      return Array.isArray(ids) ? ids.length : Math.ceil(text.length / 4);
    } catch {
      return Math.ceil(text.length / 4);
    }
  }

  private applyChatTemplate(messages: Message[], tokenizer: PreTrainedTokenizer): string {
    const chat = toChatMessages(messages);

    try {
      const templated = tokenizer.apply_chat_template(chat, {
        tokenize: false,
        add_generation_prompt: true,
      });
      if (typeof templated === 'string') return templated;
    } catch {
      // No chat template configured; fall through to the ChatML default.
    }

    return fallbackChatTemplate(chat);
  }

  private configureCache(): void {
    if (this.cache === 'indexeddb' && typeof indexedDB !== 'undefined') {
      env.useCustomCache = true;
      env.useBrowserCache = false;
      env.useFSCache = false;
      env.customCache = new IndexedDBCache();
      return;
    }

    if (this.cache === 'opfs') {
      if (hasOPFS()) {
        // `env.useFSCache` is Node-only; browsers get an OPFS custom cache.
        env.useCustomCache = true;
        env.useBrowserCache = false;
        env.useFSCache = false;
        env.customCache = new OPFSCache();
        return;
      }
      if (isNode()) {
        env.useCustomCache = false;
        env.useBrowserCache = false;
        env.useFSCache = true;
        return;
      }
      // Browser without OPFS: fall through to the Cache API.
    }

    env.useCustomCache = false;
    env.useFSCache = false;
    env.useBrowserCache = typeof caches !== 'undefined';
  }
}

/** One turn as a chat template expects it. */
interface ChatMessage {
  role: string;
  content: string;
  tool_calls?: ChatToolCall[];
}

interface ChatToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}

/**
 * Convert GhostShell messages into chat-template turns.
 *
 * Chat templates (Qwen2.5 included) expect tool output in a `tool` role turn
 * and the assistant's calls as `tool_calls`. The agent loop emits `tool`
 * messages; an assistant message that still carries `toolResults` (the legacy
 * shape) is split so the output reaches the model either way.
 */
function toChatMessages(messages: Message[]): ChatMessage[] {
  const chat: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      chat.push({ role: 'tool', content: message.content });
      continue;
    }

    const entry: ChatMessage = { role: message.role, content: message.content };
    if (message.role === 'assistant' && message.toolCalls?.length) {
      entry.tool_calls = message.toolCalls.map((call) => ({
        function: { name: call.name, arguments: call.arguments },
      }));
    }
    chat.push(entry);

    for (const result of message.toolResults ?? []) {
      chat.push({ role: 'tool', content: result.content });
    }
  }
  return chat;
}

/** ChatML fallback for tokenizers without a chat template. */
function fallbackChatTemplate(messages: ChatMessage[]): string {
  const parts = messages.map(
    (message) => `<|im_start|>${message.role}\n${message.content}\n<|im_end|>`,
  );
  parts.push('<|im_start|>assistant\n');
  return parts.join('\n');
}
