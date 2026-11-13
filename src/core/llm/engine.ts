import type { ModelIntegrity } from '@mlc-ai/web-llm';
import type { BackendKind, LLMEngine, ModelSpec } from '@/types/index.js';
import { TransformersEngine, type TransformersEngineOptions } from './transformers.js';
import { supportsBackend } from './models.js';
import { WebLLMEngine } from './webllm.js';

/**
 * LLM engine factory.
 *
 * Two engines are planned:
 *  - `TransformersEngine` (default, pure WASM, no WebGPU dependency)
 *  - `WebLLMEngine` (fast path, WebGPU, v1.0)
 *
 * The factory picks WebGPU when available and the model supports it, else
 * falls back to WASM. See docs/ENGINEERING_PLAN.md §3.2.
 */

export type EngineKind = 'transformers' | 'webllm';

export interface CreateEngineOptions extends TransformersEngineOptions {
  /**
   * Runtime device. Defaults to `detectBackend()`. `transformers` maps this
   * straight to the ONNX runtime device; `webllm` always runs on WebGPU.
   */
  device?: BackendKind;
  /**
   * Model the engine will load. Used to pick a compatible default device;
   * `TransformersEngine.load` re-validates and downgrades to WASM if the model
   * does not support the requested backend.
   */
  spec?: ModelSpec;
  /**
   * SRI hashes for the WebLLM model artifacts. Ignored by
   * `TransformersEngine`, which verifies weights itself.
   */
  integrity?: ModelIntegrity;
}

export function createEngine(kind: EngineKind, options: CreateEngineOptions = {}): LLMEngine {
  switch (kind) {
    case 'transformers': {
      const { spec, ...engineOptions } = options;
      return new TransformersEngine({
        ...engineOptions,
        device: options.device ?? detectBackendFor(spec),
      });
    }
    case 'webllm': {
      // The engines share option names but not vocabulary: `browser` is
      // Transformers.js' name for the Cache API, which WebLLM calls `cache`.
      // `device`/`dtype`/`revision`/`spec` describe the WASM runtime and do
      // not apply to a WebGPU engine.
      const { cache, integrity } = options;
      return new WebLLMEngine({
        ...(cache === 'browser'
          ? { cache: 'cache' as const }
          : cache !== undefined
            ? { cache }
            : {}),
        ...(integrity !== undefined ? { integrity } : {}),
      });
    }
  }
}

/**
 * Detect the best available backend.
 *
 * WebGPU is preferred when the browser exposes `navigator.gpu`; otherwise the
 * engine runs on WASM (single-threaded unless the host sets COOP/COEP).
 */
export function detectBackend(): BackendKind {
  if (typeof globalThis.navigator !== 'undefined' && 'gpu' in globalThis.navigator) {
    return 'webgpu';
  }
  return 'wasm';
}

/** Pick the default device for a model, falling back to WASM when unsupported. */
function detectBackendFor(spec: ModelSpec | undefined): BackendKind {
  return spec && !supportsBackend(spec, 'webgpu') ? 'wasm' : detectBackend();
}

export { supportsBackend };
