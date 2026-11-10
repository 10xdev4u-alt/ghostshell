# ADR 0002: Dual LLM engine — Transformers.js default, WebLLM fast path

- **Status:** Accepted
- **Date:** 2026-11-10
- **Deciders:** GhostShell core team
- **Related:** `docs/ENGINEERING_PLAN.md` §3.2, `docs/CREATIVE_INNOVATION.md` §0.4 and §6.1, `src/types/index.ts` (`LLMEngine`), `src/core/llm/engine.ts`, `src/core/llm/transformers.ts`, `src/core/llm/webllm.ts`, `src/core/llm/grammar.ts`

## Context

GhostShell runs a local LLM in the browser: no API keys, no server, weights downloaded
once from a CDN and cached. The plan's biggest open question is **which runtime is faster
and more reliable in practice** (Open Question #1), and the biggest product risk is
**small models emitting invalid tool calls** (Risk #1).

Two browser LLM runtimes dominate the field, and they are not equivalent:

- **Transformers.js** (`@huggingface/transformers`) runs on ONNX Runtime Web. It works on
  WASM everywhere, has the full Hugging Face Hub, and ships tokenizers and chat
  templates. It is the safe baseline.
- **WebLLM** (`@mlc-ai/web-llm`) runs on MLC TVM. It is significantly faster on WebGPU
  and ships JSON-mode constrained decoding, SRI integrity, OPFS/IndexedDB caching, and
  worker engines. Its model set is limited to MLC conversions and it depends on a working
  GPU driver.

Neither can be chosen with confidence before the M0 spike, and betting the product on
one runtime's GPU quirks is unnecessary. The engine choice is therefore hidden behind an
interface and resolved by measurement.

## Decision

Define a single **`LLMEngine`** interface and ship two implementations.

### The interface

The implemented interface (in `src/types/index.ts`) is:

```ts
interface LLMEngine {
  readonly id: string;
  readonly kind: BackendKind; // 'wasm' | 'webgpu'
  load(spec: ModelSpec, onProgress: (p: LoadProgress) => void): Promise<void>;
  unload(): Promise<void>;
  isLoaded(): boolean;
  generate(
    req: GenerateRequest,
    onToken: (token: string) => void,
    signal: AbortSignal,
  ): Promise<GenerateResult>;
}
```

`GenerateRequest` carries `messages`, `temperature`, `maxTokens`, an optional `grammar`
for constrained decoding, and `stop` sequences. `GenerateResult` returns `text`,
`tokens`, `finishReason`, and parsed `toolCalls`.

### The two engines

| Engine | id | Backend | Role |
|---|---|---|---|
| `TransformersEngine` | `transformers` | WASM | **v0.1 default.** Works everywhere, no GPU dependency. |
| `WebLLMEngine` | `webllm` | WebGPU | **v1.0 fast path.** Auto-selected when `navigator.gpu` exists. |

`createEngine(kind)` constructs an engine. `detectBackend()` returns `'webgpu'` when
`navigator.gpu` is present and `'wasm'` otherwise. `supportsBackend(spec, backend)` gates
model selection so a WebGPU-only model is not offered on a WASM-only machine.

### Models

The registry (`src/config.ts`) is the single source of truth:

- **Qwen2.5-1.5B-Instruct (Q4_K_M)** — v0.1 default. Apache-2.0, 32k context, best
  quality/size/speed ratio.
- **Qwen2.5-3B-Instruct (Q4_K_M)** — v0.1 quality option and v1.0 default candidate.

Weights are never inlined into the HTML. They are downloaded from the Hugging Face CDN
on first run, cached in OPFS (preferred) or IndexedDB, and pinned by sha256 where the
runtime supports it.

### Tool calls

The default tool-call strategy is **grammar-constrained decoding**: build a grammar from
the tool schemas, pass it in `GenerateRequest.grammar`, and parse with the grammar
strategy first. Hermes-style XML and corrective retries (max 2) are the fallback. This
converts a probabilistic parse into a near-deterministic one and is the highest-leverage
fix for Risk #1. WebLLM's JSON mode is the first engine to support it; the Transformers.js
path uses XML until grammar support lands.

## Why Transformers.js is the v0.1 default

1. **Universality.** It runs on WASM with no GPU and no driver. v0.1's promise is "works
   on any machine with a browser"; WebGPU is not universal, and a GPU-driver failure on
   an otherwise capable machine is unacceptable for the baseline.
2. **Predictable go/no-go.** The M0 criteria are measured on the default runtime. A WASM
   baseline is reproducible across machines and CI, without GPU variance.
3. **Ecosystem.** The full Hugging Face Hub, built-in tokenizers, and `apply_chat_template`
   for ChatML/Llama formats reduce glue code and widen the model search for the eval suite.
4. **Maintenance.** ONNX Runtime Web and Transformers.js are actively maintained with a
   stable API, which matters for a solo team.

## Why WebLLM is the v1.0 fast path

1. **Performance.** WebGPU inference is 3–6× faster than WASM for 3B+ models, which is the
   difference between usable and unusable for larger models.
2. **Constrained decoding.** JSON mode forces valid tool-call objects, directly attacking
   Risk #1. This is the strongest reliability lever available.
3. **Operations.** SRI integrity verification, OPFS/IndexedDB cache backends, and worker /
   service-worker engines are built in.
4. **Honest selection.** It is auto-selected only when `navigator.gpu` exists and the model
   supports it; otherwise the user stays on the WASM path with a clear warning.

## Alternatives considered

| Alternative | Verdict |
|---|---|
| **Candle WASM** | Promising Rust/Hugging Face stack, but it is demos rather than a library; all glue would be ours. |
| **llama.cpp WASM** | Best quantization support, but no official browser chat API, all glue is ours, and threaded builds require COOP/COEP headers that static hosts may not set. |
| **ONNX Runtime Web direct** | Maximum flexibility, but every feature (tokenizer, chat template, generation loop) is ours to build and maintain. Transformers.js is the maintained wrapper over the same runtime. |
| **Single engine (WebLLM only)** | Betts the product on WebGPU availability and driver quality; no baseline for machines without a GPU. |
| **Single engine (Transformers.js only)** | Leaves the 3–6× WebGPU speedup and constrained decoding on the table; forfeits the strongest fix for Risk #1. |

## Migration path

1. **v0.1 — Transformers.js only.** `TransformersEngine` is the wired default;
   `createEngine('transformers')` returns it. `WebLLMEngine` exists in the tree but is
   not selected. Grammar-constrained decoding is scaffolding: the request carries a
   grammar, the parser supports the `grammar` strategy, and the XML fallback is live.
2. **v0.2 — measurement.** Run both engines on 1.5B and 3B, on WASM and WebGPU, and record
   tok/s, first-token latency, memory, and tool-call success. Publish the results.
3. **v1.0 — WebLLM fast path.** Switch the default selection to `detectBackend()`. WebLLM
   becomes the default on WebGPU machines; Transformers.js remains the WASM fallback and
   the universal path. The agent loop, prompt builder, parser, and UI are unchanged
   because both engines satisfy `LLMEngine`.
4. **Settings.** The model picker marks backend capability; `supportsBackend` prevents
   selecting a WebGPU-only model on a WASM-only machine. Model switching reuses the cache
   or re-downloads, never silently.

## Consequences

- **Two runtimes to maintain.** Both engines must be tested, and the bundle grows if both
  ship. Mitigation: lazy-load the non-selected engine (or code-split it in v1.0).
- **Grammar support is uneven.** WebLLM supports constrained decoding; the Transformers.js
  path falls back to Hermes XML plus corrective retries until grammar support lands.
- **Model breadth vs. speed.** The HF-hub breadth of Transformers.js is lost on the
  WebLLM fast path, whose model set is limited to MLC conversions.
- **GPU variance.** WebGPU performance and driver quirks differ by machine; feature
  detection, a clear fallback, and a published benchmark leaderboard keep the choice
  honest.
- **Eval-driven defaults.** The default engine and model are chosen from the M0/M3
  eval suite, not from preference. If the data says otherwise, the defaults change.

## Status

**Accepted.** The dual-engine design hedges the plan's biggest unknown behind one
interface, ships a universal WASM baseline in v0.1, and reserves the WebGPU fast path —
and its constrained-decoding reliability win — for v1.0.
