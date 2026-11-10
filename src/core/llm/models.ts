import type { ModelCard, ModelSpec } from '@/types/index.js';
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

/**
 * Resolve the Hugging Face repo for a given engine.
 *
 * The registry entries are GGUF (`…-Instruct-GGUF`). Transformers.js cannot
 * load GGUF, so map to the matching `onnx-community` ONNX conversion. WebLLM
 * uses MLC's own artifacts and keeps the registry repo.
 */
export function resolveModelRepo(spec: ModelSpec, engine: EngineKind): string {
  if (engine === 'webllm') return spec.repo;
  if (spec.repo.endsWith('-GGUF')) {
    const base = spec.repo.slice(0, -'-GGUF'.length);
    const name = base.split('/').pop() ?? base;
    return `onnx-community/${name}`;
  }
  return spec.repo;
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
