import type { LLMEngine, ModelSpec } from '@/types/index.js';

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

export function createEngine(kind: EngineKind): LLMEngine {
  // TODO: import and instantiate the concrete engine (issue #14).
  void kind;
  throw new Error(`LLM engine "${kind}" not implemented (issue #14)`);
}

/** Detect the best available backend. */
export function detectBackend(): 'webgpu' | 'wasm' {
  if (typeof globalThis.navigator !== 'undefined' && 'gpu' in globalThis.navigator) {
    return 'webgpu';
  }
  return 'wasm';
}

/** True when the model can run on the detected backend. */
export function supportsBackend(spec: ModelSpec, backend: 'webgpu' | 'wasm'): boolean {
  return spec.backend === backend || backend === 'wasm';
}
