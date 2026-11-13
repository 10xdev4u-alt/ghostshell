import type {
  AppConfig,
  ChatCompletionAssistantMessageParam,
  ChatCompletionChunk,
  ChatCompletionFinishReason,
  ChatCompletionMessageParam,
  InitProgressReport,
  MLCEngine,
  ModelIntegrity,
} from '@mlc-ai/web-llm';
import type {
  GenerateRequest,
  GenerateResult,
  LLMEngine,
  Message,
  ModelProgress,
  ModelSpec,
} from '@/types/index.js';
import { resolveWebLLMModelId } from './models.js';

/**
 * WebLLM engine (WebGPU fast path).
 *
 * Uses `@mlc-ai/web-llm`, which runs MLC-compiled models on WebGPU. Compared
 * with the Transformers.js WASM path this trades a WebGPU requirement for a
 * large throughput win, and adds native SRI verification plus OPFS caching.
 *
 * The module imports `@mlc-ai/web-llm` lazily inside `load()` so the WASM
 * default path (and every test that only touches the engine factory) never
 * loads the GPU runtime.
 */

/** Cache backends WebLLM understands (its own vocabulary, not Transformers.js'). */
type WebLLMCacheBackend = 'opfs' | 'cache' | 'indexeddb';

export interface WebLLMEngineOptions {
  /**
   * Persistent model cache. Defaults to `'opfs'`, which is larger and more
   * durable than the Cache API; WebLLM falls back internally when a backend
   * is unavailable.
   */
  cache?: WebLLMCacheBackend;
  /**
   * SRI hashes for the model artifacts. WebLLM verifies each downloaded
   * file against these; malformed hashes are rejected before any download.
   */
  integrity?: ModelIntegrity;
}

const DEFAULT_MAX_NEW_TOKENS = 512;
const DEFAULT_TEMPERATURE = 0.2;

/** Build the standard `AbortError` shape so callers can detect cancellation. */
function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

/**
 * Reject as soon as `signal` aborts, while still settling the wrapped
 * promise's own result. Adds cancellation to `MLCEngine.reload()`, which has
 * no signal of its own.
 */
function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/**
 * Map a WebLLM init report to GhostShell progress.
 *
 * WebLLM reports `progress` as a fraction (0–1) of bytes fetched; the final
 * report uses exactly 1 to mean "loaded". `loaded`/`total` borrow the
 * registry size as a byte estimate — the MLC artifact set is not byte-equal
 * to the GGUF it replaces, but the percentage is what the UI acts on.
 */
function toLoadProgress(
  report: InitProgressReport,
  spec: ModelSpec,
): ModelProgress {
  const ratio = Number.isFinite(report.progress)
    ? Math.min(1, Math.max(0, report.progress))
    : 0;
  return {
    phase: ratio >= 1 ? 'loading' : 'downloading',
    loaded: spec.sizeBytes > 0 ? Math.round(spec.sizeBytes * ratio) : 0,
    total: spec.sizeBytes,
    percent: spec.sizeBytes > 0 ? clampPercent(ratio * 100) : null,
    message: report.text,
  };
}

/**
 * Validate caller-supplied SRI hashes before a multi-hundred-MB download.
 * WebLLM verifies at fetch time, but a malformed hash string would otherwise
 * only surface after the whole model arrived.
 */
function validateIntegrityOptions(
  integrity: ModelIntegrity | undefined,
  isValidSRI: (sri: string) => boolean,
): void {
  if (!integrity) return;
  if (integrity.config !== undefined && !isValidSRI(integrity.config)) {
    throw new Error(
      `Invalid SRI hash for mlc-chat-config.json: ${JSON.stringify(integrity.config)}`,
    );
  }
  if (integrity.model_lib !== undefined && !isValidSRI(integrity.model_lib)) {
    throw new Error(
      `Invalid SRI hash for the model library: ${JSON.stringify(integrity.model_lib)}`,
    );
  }
  for (const [file, hash] of Object.entries(integrity.tokenizer ?? {})) {
    if (!isValidSRI(hash)) {
      throw new Error(
        `Invalid SRI hash for tokenizer file "${file}": ${JSON.stringify(hash)}`,
      );
    }
  }
}

/**
 * Verify one already-downloaded artifact against an SRI hash.
 *
 * Exported for callers that cache artifacts themselves; `load()` relies on
 * WebLLM's built-in per-artifact verification instead.
 */
export async function verifyArtifact(
  data: ArrayBuffer,
  sri: string,
  url: string,
): Promise<void> {
  const { isValidSRI, verifyIntegrity } = await import('@mlc-ai/web-llm');
  if (!isValidSRI(sri)) {
    throw new Error(`Invalid SRI hash for ${url}: ${JSON.stringify(sri)}`);
  }
  await verifyIntegrity(data, sri, url, 'error');
}

/**
 * Convert GhostShell messages to OpenAI chat messages.
 *
 * WebLLM implements the OpenAI protocol, including tool calling: assistant
 * `toolCalls` become `tool_calls` with JSON-stringified arguments, and the
 * tool results attached to an assistant turn become `tool` messages paired
 * with their call by position. Standalone `tool` messages have no id to pair
 * with, so they get a synthetic one — WebLLM only requires a non-empty
 * string.
 */
export function toChatMessages(
  messages: Message[],
): ChatCompletionMessageParam[] {
  const chat: ChatCompletionMessageParam[] = [];
  let syntheticId = 0;

  for (const message of messages) {
    if (message.role === 'system' || message.role === 'user') {
      chat.push({ role: message.role, content: message.content });
      continue;
    }

    if (message.role === 'tool') {
      syntheticId += 1;
      chat.push({
        role: 'tool',
        content: message.content,
        tool_call_id: `ghostshell-tool-${syntheticId}`,
      });
      continue;
    }

    const toolCalls = message.toolCalls ?? [];
    const assistant: ChatCompletionAssistantMessageParam = {
      role: 'assistant',
      content: message.content,
    };
    if (toolCalls.length > 0) {
      assistant.tool_calls = toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: {
          name: call.name,
          // A missing argument object still has to round-trip as valid JSON.
          arguments: JSON.stringify(call.arguments) ?? '{}',
        },
      }));
    }
    chat.push(assistant);

    const results = message.toolResults ?? [];
    for (let index = 0; index < results.length; index += 1) {
      const call = toolCalls[index];
      chat.push({
        role: 'tool',
        content: results[index]?.content ?? '',
        tool_call_id: call ? call.id : `ghostshell-tool-${(syntheticId += 1)}`,
      });
    }
  }

  return chat;
}

/**
 * Map WebLLM's finish reason onto the engine result vocabulary.
 *
 * `null` means the stream ended without a terminal reason; treat that as a
 * normal stop unless the token cap was reached.
 */
function toFinishReason(
  reason: ChatCompletionFinishReason | null | undefined,
  hitMaxTokens: boolean,
): GenerateResult['finishReason'] {
  switch (reason) {
    case 'length':
      return 'length';
    case 'abort':
      return 'aborted';
    case 'tool_calls':
      // GhostShell parses tool calls out of the text, so the turn itself
      // still ended normally.
      return 'stop';
    case 'stop':
    default:
      return hitMaxTokens ? 'length' : 'stop';
  }
}

interface ActiveEngine {
  engine: MLCEngine;
  modelId: string;
}

export class WebLLMEngine implements LLMEngine {
  readonly id = 'webllm';
  readonly kind = 'webgpu';

  private readonly cache: WebLLMCacheBackend;
  private readonly integrity: ModelIntegrity | undefined;
  private active: ActiveEngine | null = null;
  private loaded = false;

  constructor(options: WebLLMEngineOptions = {}) {
    this.cache = options.cache ?? 'opfs';
    this.integrity = options.integrity;
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  async load(
    spec: ModelSpec,
    onProgress: (p: ModelProgress) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const abortSignal = signal ?? new AbortController().signal;
    throwIfAborted(abortSignal);

    // Resolve before importing the GPU runtime: an unmapped model should fail
    // with a clear registry error rather than a WebLLM lookup error.
    const modelId = resolveWebLLMModelId(spec);

    const { MLCEngine, isValidSRI, prebuiltAppConfig } =
      await import('@mlc-ai/web-llm');

    // Fail on a malformed hash before the first byte is fetched.
    validateIntegrityOptions(this.integrity, isValidSRI);

    // Keep model URLs and the model library owned by the pinned package: copy
    // the catalog record instead of reconstructing one by hand.
    const record = prebuiltAppConfig.model_list.find(
      (entry) => entry.model_id === modelId,
    );
    if (!record) {
      throw new Error(
        `Model "${modelId}" is not in the installed @mlc-ai/web-llm prebuiltAppConfig. ` +
          'Update WEBLLM_TARGETS in src/core/llm/models.ts to a version-supported id.',
      );
    }
    const appConfig: AppConfig = {
      model_list: [
        this.integrity ? { ...record, integrity: this.integrity } : record,
      ],
      cacheBackend: this.cache,
    };

    // Progress after a cancel is meaningless; drop it so the UI does not flash
    // a stale percentage after the user cancels.
    const emit = (progress: ModelProgress): void => {
      if (!abortSignal.aborted) onProgress(progress);
    };
    emit({
      phase: 'downloading',
      loaded: 0,
      total: spec.sizeBytes,
      percent: spec.sizeBytes > 0 ? 0 : null,
      message: `Loading ${spec.name}`,
    });

    const engine = new MLCEngine({
      appConfig,
      initProgressCallback: (report) => {
        if (!abortSignal.aborted) emit(toLoadProgress(report, spec));
      },
    });

    try {
      await raceWithAbort(engine.reload(modelId), abortSignal);
    } catch (err) {
      // A canceled or failed load leaves a half-initialized engine behind;
      // release it before surfacing the error.
      try {
        await engine.unload();
      } catch {
        // Unloading a partially-loaded engine is best-effort.
      }
      if (abortSignal.aborted) throw abortError();
      throw err;
    }

    // Dispose the engine being replaced before swapping it out, so a failed
    // reload leaves the old model loaded instead of leaking it.
    const previous = this.active?.engine;
    if (previous) {
      try {
        await previous.unload();
      } catch {
        // Disposing the old engine is best-effort; the new one is ready.
      }
    }
    this.active = { engine, modelId };
    this.loaded = true;

    emit({
      phase: 'loading',
      loaded: spec.sizeBytes,
      total: spec.sizeBytes,
      percent: spec.sizeBytes > 0 ? 100 : null,
      message: `${spec.name} ready`,
    });
  }

  async unload(): Promise<void> {
    const active = this.active;
    this.active = null;
    this.loaded = false;
    if (!active) return;
    try {
      await active.engine.unload();
    } catch {
      // Disposing a partially-loaded engine is best-effort.
    }
  }

  async generate(
    req: GenerateRequest,
    onToken: (token: string) => void,
    signal: AbortSignal,
    onProgress?: (p: ModelProgress) => void,
  ): Promise<GenerateResult> {
    const active = this.active;
    if (!active || !this.loaded) {
      throw new Error('WebLLMEngine: model is not loaded');
    }
    if (signal.aborted) {
      return { text: '', tokens: 0, finishReason: 'aborted' };
    }

    const maxTokens = req.maxTokens ?? DEFAULT_MAX_NEW_TOKENS;
    const temperature = req.temperature ?? DEFAULT_TEMPERATURE;
    const stop = req.stop ?? [];

    // Generation has no byte stream to measure; tokens against the turn cap
    // are the honest analogue. `total` is the cap, not a predicted length.
    const report = (tokens: number): void => {
      onProgress?.({
        phase: 'generating',
        loaded: tokens,
        total: maxTokens,
        percent:
          maxTokens > 0 ? clampPercent((tokens / maxTokens) * 100) : null,
        message: 'Generating…',
      });
    };
    report(0);

    // `req.grammar` carries a GBNF string. WebLLM's constrained decoding
    // takes `response_format` with a JSON Schema, not a GBNF grammar, and
    // translating between the two would silently change the constraint. The
    // option is accepted so callers can treat engines uniformly, but it is
    // not forwarded.

    const onAbort = (): void => {
      // Cancelling the underlying stream lets `for await` settle promptly.
      active.engine.interruptGenerate().catch(() => {});
    };
    // Register before awaiting the request so an abort during the call is
    // not missed.
    signal.addEventListener('abort', onAbort, { once: true });

    const chunks: string[] = [];
    let tokens = 0;
    let rawFinishReason: ChatCompletionFinishReason | null = null;

    try {
      // `include_usage` makes WebLLM report exact completion token counts in
      // a trailing chunk; the content-delta count is only the fallback.
      const stream = await active.engine.chat.completions.create({
        model: active.modelId,
        messages: toChatMessages(req.messages),
        stream: true,
        temperature,
        max_tokens: maxTokens,
        ...(stop.length > 0 ? { stop } : {}),
        stream_options: { include_usage: true },
      });

      for await (const chunk of stream) {
        if (signal.aborted) break;
        // Read usage before the choice guard: the terminal usage chunk
        // carries an empty `choices` array.
        const usageTokens = chunk.usage?.completion_tokens;
        if (typeof usageTokens === 'number') {
          tokens = usageTokens;
        }
        const choice = chunk.choices[0];
        if (choice) {
          const delta = choice.delta.content;
          if (typeof delta === 'string' && delta.length > 0) {
            chunks.push(delta);
            onToken(delta);
            // Approximation: one delta is usually one token, but a delta can
            // carry several. Exact counts come from `usage` when present.
            tokens += 1;
          }
          if (choice.finish_reason != null)
            rawFinishReason = choice.finish_reason;
        }
        report(tokens);
      }
    } catch (err) {
      if (!signal.aborted) {
        // Generation errors propagate; `finishReason` describes a run that
        // produced a result.
        throw err;
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
    }

    if (signal.aborted) rawFinishReason = 'abort';

    let text = chunks.join('');
    if (stop.length > 0) {
      const hit = stop.find((candidate) => text.includes(candidate));
      if (hit !== undefined) {
        const index = text.indexOf(hit);
        text = index === -1 ? text : text.slice(0, index);
      }
    }

    return {
      text,
      tokens,
      finishReason: toFinishReason(rawFinishReason, tokens >= maxTokens),
    };
  }
}
