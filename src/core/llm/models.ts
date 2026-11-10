import type { DataType } from '@huggingface/transformers';
import type { BackendKind, ModelCard, ModelSpec } from '@/types/index.js';
import { MODELS } from '@/config.js';
import type { EngineKind } from './engine.js';

/**
 * Model registry.
 *
 * v0.1 ships two Qwen2.5 models. The registry is the single source of truth
 * for the model picker, the download URL, and the eval leaderboard.
 *
 * The registry stores GGUF repos because that is the format shared by the
 * llama.cpp / WebLLM ecosystem. Transformers.js needs ONNX weights, so
 * `resolveModelRepo` maps between the two.
 */

export function listModels(): ModelSpec[] {
  // Return copies so callers cannot mutate the registry.
  return MODELS.map((spec) => ({ ...spec }));
}

export function getModel(id: string): ModelSpec {
  const spec = MODELS.find((model) => model.id === id);
  if (!spec) throw new Error(`Unknown model: ${id}`);
  return { ...spec };
}

export function modelCards(): ModelCard[] {
  // TODO: merge with docs/research/eval-leaderboard.json when available.
  return MODELS.map((spec) => ({ spec: { ...spec }, description: spec.name }));
}

/** A verified ONNX conversion of a registry GGUF model. */
export interface ONNXModelTarget {
  /** HF repo holding the `onnx/` weights transformers.js expects. */
  repo: string;
  /**
   * Quantization the repo ships. transformers.js derives the weight filename
   * from it (`onnx/model< suffix >.onnx`), so it must match the repo.
   */
  dtype: DataType;
}

/**
 * Verified ONNX targets for the Transformers.js engine.
 *
 * Every entry was checked against the live HF API (HTTP 200) and contains the
 * exact `onnx/` file transformers.js requests for `dtype`. The registry stores
 * GGUF repos, which transformers.js cannot load, so the mapping is explicit
 * rather than derived from the repo name.
 *
 * NOTE: `onnx-community` has no plain Qwen2.5-3B-Instruct conversion — its 3B
 * class is `Qwen2.5-Coder-3B-Instruct`, a different model. The 3B entry points
 * at the community ONNX conversion of the same base model, which ships only a
 * q4f16 build (declared in its `transformers.js_config`).
 */
export const ONNX_TARGETS: Readonly<Record<string, ONNXModelTarget>> = {
  'qwen2.5-1.5b': { repo: 'onnx-community/Qwen2.5-1.5B-Instruct', dtype: 'q8' },
  'qwen2.5-3b': { repo: 'opalitestudios/Qwen2.5-3B-Instruct-ONNX', dtype: 'q4f16' },
};

/**
 * Resolve the Hugging Face repo for a given engine.
 *
 * The registry entries are GGUF (`…-Instruct-GGUF`). Transformers.js cannot
 * load GGUF, so map to the verified ONNX conversion in `ONNX_TARGETS`. WebLLM
 * uses MLC's own artifacts and keeps the registry repo.
 *
 * Throws when a registry model has no verified ONNX conversion, so `load()`
 * fails with a clear message instead of a hub 404.
 */
export function resolveModelRepo(spec: ModelSpec, engine: EngineKind): string {
  if (engine === 'webllm') return spec.repo;
  return onnxTarget(spec).repo;
}

/**
 * Resolve the quantization transformers.js should request for a model.
 *
 * The ONNX repos ship different builds than the GGUF registry entries, so the
 * dtype comes from the verified target rather than from `spec.quantization`.
 */
export function resolveModelDtype(spec: ModelSpec): DataType {
  return onnxTarget(spec).dtype;
}

function onnxTarget(spec: ModelSpec): ONNXModelTarget {
  const target = ONNX_TARGETS[spec.id];
  if (!target) {
    throw new Error(
      `No ONNX conversion for model "${spec.id}" (${spec.repo}). ` +
        'Add a verified target to ONNX_TARGETS in src/core/llm/models.ts.',
    );
  }
  return target;
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

/**
 * Recommend a model based on device capabilities.
 *
 * The 3B model is only worth its memory when there is a GPU and enough RAM;
 * the 1.5B model is the safe default everywhere else.
 */
export function recommendModel(hasWebGpu: boolean, memoryGb: number): ModelSpec {
  if (hasWebGpu && memoryGb >= 12) return getModel('qwen2.5-3b');
  return getModel('qwen2.5-1.5b');
}
