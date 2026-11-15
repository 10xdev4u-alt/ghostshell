import type {
  AppConfig,
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
  ToolCall,
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
   * durable than the Cache API. When OPFS is unavailable (older browsers,
   * non-secure contexts) the engine falls back to the Cache API itself —
   * WebLLM only does that for its `cross-origin` backend.
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

/**
 * True when the Origin Private File System is usable in this context.
 *
 * WebLLM's OPFS store throws on construction when `navigator.storage` is
 * missing, and it does not fall back to the Cache API on its own, so the
 * engine performs the same feature check Transformers.js uses.
 */
function hasOPFS(): boolean {
  if (typeof navigator === 'undefined' || !('storage' in navigator))
    return false;
  const storage = navigator.storage as unknown as { getDirectory?: unknown };
  return typeof storage.getDirectory === 'function';
}

/** Pick a usable cache backend, downgrading OPFS when the platform lacks it. */
function resolveCacheBackend(cache: WebLLMCacheBackend): WebLLMCacheBackend {
  return cache === 'opfs' && !hasOPFS() ? 'cache' : cache;
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
 * Translate GhostShell's llama.cpp-style GBNF into the EBNF dialect XGrammar
 * (WebLLM's grammar backend) accepts.
 *
 * XGrammar rejects a leading empty alternative (`rule ::= | a | b`), which
 * `buildToolCallGrammar` emits for its whitespace rule. Rewriting it as an
 * optional group keeps the same language: `rule ::= (a | b)?`.
 */
function toXGrammar(grammar: string): string {
  return grammar.replace(
    /^(\s*[A-Za-z0-9_-]+\s*::=)\s*\|\s*(.+?)\s*$/gm,
    '$1($2)?',
  );
}

/** Render one tool call in the Hermes syntax Qwen's template emits. */
function formatToolCall(call: ToolCall): string {
  return `<tool_call>\n${JSON.stringify({
    name: call.name,
    arguments: call.arguments ?? {},
  })}\n</tool_call>`;
}

/**
 * Convert GhostShell messages to OpenAI chat messages.
 *
 * The shipped MLC models use the `qwen2` conversation template, whose role
 * table defines only `user` and `assistant`: a literal `{role:'tool'}` message
 * makes WebLLM throw "Role is not supported: tool". Qwen's own chat template
 * renders tool turns itself, so this mirrors that:
 *   - an assistant tool call is the assistant content plus
 *     `<tool_call>{…}</tool_call>` blocks — the same syntax the parser strips
 *     back out of generated text (`src/core/agent/parser.ts`);
 *   - a tool result becomes a `user` turn wrapping the output in
 *     `<tool_response>…</tool_response>`, and consecutive results share one
 *     turn exactly as the Jinja template groups them.
 * WebLLM ignores `tool_calls` on its own, so the blocks must ride in content.
 */
export function toChatMessages(
  messages: Message[],
): ChatCompletionMessageParam[] {
  const chat: ChatCompletionMessageParam[] = [];
  let lastWasToolResult = false;

  const appendToolResults = (contents: string[]): void => {
    if (contents.length === 0) {
      lastWasToolResult = false;
      return;
    }
    const block = contents.map(
      (content) => `<tool_response>\n${content}\n</tool_response>`,
    );
    const previous = chat.at(-1);
    if (previous?.role === 'user' && lastWasToolResult) {
      // A run of tool results shares one user turn, matching Qwen's Jinja
      // template.
      chat[chat.length - 1] = {
        ...previous,
        content: `${String(previous.content)}\n${block.join('\n')}`,
      };
    } else {
      chat.push({ role: 'user', content: block.join('\n') });
    }
    lastWasToolResult = true;
  };

  for (const message of messages) {
    switch (message.role) {
      case 'system':
      case 'user': {
        chat.push({ role: message.role, content: message.content });
        lastWasToolResult = false;
        break;
      }
      case 'assistant': {
        const blocks = (message.toolCalls ?? []).map(formatToolCall);
        const content = [message.content, ...blocks]
          .filter((part) => part.length > 0)
          .join('\n');
        chat.push({ role: 'assistant', content });
        lastWasToolResult = false;
        appendToolResults(
          (message.toolResults ?? []).map((result) => result.content),
        );
        break;
      }
      case 'tool': {
        appendToolResults([message.content]);
        break;
      }
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

/**
 * Cut `text` at whichever stop sequence occurs first.
 *
 * WebLLM honors `stop` itself, so this only cleans up output that ignored it.
 * Picking the earliest match matters when several stops are configured:
 * array order alone would leave an earlier stop word visible in the text.
 */
function stripAtEarliestStop(text: string, stop: string[]): string {
  let cut = -1;
  for (const candidate of stop) {
    const index = text.indexOf(candidate);
    if (index !== -1 && (cut === -1 || index < cut)) cut = index;
  }
  return cut === -1 ? text : text.slice(0, cut);
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
  /**
   * Incremented by every `load`/`unload` so an in-flight load that has been
   * superseded releases its engine instead of swapping it in afterwards.
   */
  private loadGeneration = 0;
  /** Aborts the in-flight download when a newer load or `unload` starts. */
  private loadController: AbortController | null = null;

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
    if (signal?.aborted) throw abortError();
    // Supersede any in-flight load: downloading a model nobody is waiting for
    // wastes bandwidth and leaves a half-initialized engine behind.
    this.loadController?.abort();
    const controller = new AbortController();
    this.loadController = controller;
    const generation = ++this.loadGeneration;
    const abortSignal = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;

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
      cacheBackend: resolveCacheBackend(this.cache),
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
      if (signal?.aborted) throw abortError();
      // Superseded by a newer load or by `unload()`: the caller's request was
      // replaced, not failed, so return without surfacing an error.
      if (generation !== this.loadGeneration) return;
      throw err;
    }

    // A newer load (or an unload) started while this one was downloading:
    // release the engine this call built and leave the current state alone.
    if (generation !== this.loadGeneration) {
      try {
        await engine.unload();
      } catch {
        // Disposing a superseded engine is best-effort.
      }
      return;
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
    this.loadController = null;

    emit({
      phase: 'loading',
      loaded: spec.sizeBytes,
      total: spec.sizeBytes,
      percent: spec.sizeBytes > 0 ? 100 : null,
      message: `${spec.name} ready`,
    });
  }

  async unload(): Promise<void> {
    this.loadGeneration += 1;
    this.loadController?.abort();
    this.loadController = null;
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

    // WebLLM reads `messages.at(-1).role` and then requires that role to be
    // `user` or `tool`; fail here instead of leaking its TypeError or
    // MessageOrderError. `tool` results are rendered as user turns above, so
    // both are accepted.
    if (req.messages.length === 0) {
      throw new Error('WebLLMEngine: at least one message is required');
    }
    const lastRole = req.messages[req.messages.length - 1]?.role;
    if (lastRole !== 'user' && lastRole !== 'tool') {
      throw new Error(
        `WebLLMEngine: the last message must be a user or tool turn, got ${String(lastRole)}`,
      );
    }

    const maxTokens = req.maxTokens ?? DEFAULT_MAX_NEW_TOKENS;
    const temperature = req.temperature ?? DEFAULT_TEMPERATURE;
    // An empty string matches at index 0 and would truncate every response,
    // so drop it before the value reaches WebLLM.
    const stop = (req.stop ?? []).filter((candidate) => candidate.length > 0);

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

    // `req.grammar` carries the GBNF/EBNF string from the agent loop. WebLLM
    // supports grammar-constrained decoding natively through
    // `response_format: { type: 'grammar' }`, so forward it rather than drop
    // the constraint; an empty string is not a usable grammar.
    const responseFormat =
      req.grammar !== undefined && req.grammar.length > 0
        ? {
            type: 'grammar' as const,
            grammar: toXGrammar(req.grammar),
          }
        : undefined;

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
      //
      // Racing the request against the signal matters: if WebLLM queues the
      // call behind a lock and never settles, `interruptGenerate()` alone
      // would leave this promise pending forever.
      const stream = await raceWithAbort(
        active.engine.chat.completions.create({
          model: active.modelId,
          messages: toChatMessages(req.messages),
          stream: true,
          temperature,
          max_tokens: maxTokens,
          ...(stop.length > 0 ? { stop } : {}),
          ...(responseFormat ? { response_format: responseFormat } : {}),
          stream_options: { include_usage: true },
        }),
        signal,
      );

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

    const text = stripAtEarliestStop(chunks.join(''), stop);

    return {
      text,
      tokens,
      finishReason: toFinishReason(rawFinishReason, tokens >= maxTokens),
    };
  }
}
