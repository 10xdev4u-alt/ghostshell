import type { BackendKind, LLMEngine, ModelSpec } from '@/types/index.js';
import { TransformersEngine, type TransformersEngineOptions } from './transformers.js';
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
}

export function createEngine(kind: EngineKind, options: CreateEngineOptions = {}): LLMEngine {
  switch (kind) {
    case 'transformers':
      return new TransformersEngine({ ...options, device: options.device ?? detectBackend() });
    case 'webllm':
      // WebLLM is a v1.0 fast path; the class exists but is not implemented yet.
      return new WebLLMEngine();
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

/**
 * True when the model can run on the given backend.
 *
 * WASM is the universal fallback (every ONNX model loads there). WebGPU is
 * only selected for models whose registry entry declares it, so a model that
 * was only validated on WASM is not silently pushed onto a GPU.
 */
export function supportsBackend(spec: ModelSpec, backend: BackendKind): boolean {
  return backend === 'wasm' || spec.backend === backend;
}
