import type { ModelCard, ModelSpec } from '@/types/index.js';
import { MODELS } from '@/config.js';

/**
 * Model registry.
 *
 * v0.1 ships two Qwen2.5 models. The registry is the single source of truth
 * for the model picker, the download URL, and the eval leaderboard.
 */

export function listModels(): ModelSpec[] {
  return MODELS;
}

export function getModel(id: string): ModelSpec {
  const spec = MODELS.find((m) => m.id === id);
  if (!spec) throw new Error(`Unknown model: ${id}`);
  return spec;
}

export function modelCards(): ModelCard[] {
  // TODO: merge with docs/research/eval-leaderboard.json when available.
  return MODELS.map((spec) => ({ spec, description: spec.name }));
}

/** Recommend a model based on device capabilities. */
export function recommendModel(hasWebGpu: boolean, memoryGb: number): ModelSpec {
  if (hasWebGpu && memoryGb >= 16) return getModel('qwen2.5-3b');
  return getModel('qwen2.5-1.5b');
}
