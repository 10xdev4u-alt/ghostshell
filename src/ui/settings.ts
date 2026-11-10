import type { AgentConfig } from '@/types/index.js';
import { listModels } from '@/core/llm/models.js';
import { readQueryOverrides } from '@/config.js';

/**
 * Settings panel. Binds the model picker, network mode, and agent knobs to the
 * AgentConfig. Emits a change event whenever a value changes.
 */

export interface SettingsHandle {
  get(): AgentConfig;
  onChange(fn: (config: AgentConfig) => void): void;
  dispose(): void;
}

export function createSettings(config: AgentConfig): SettingsHandle {
  const overrides = readQueryOverrides();
  let current: AgentConfig = { ...config, ...overrides };
  const listeners = new Set<(config: AgentConfig) => void>();

  return {
    get: () => current,
    onChange(fn) {
      listeners.add(fn);
    },
    dispose() {
      listeners.clear();
    },
  };
}

export function populateModelSelect(select: HTMLSelectElement): void {
  for (const spec of listModels()) {
    const option = document.createElement('option');
    option.value = spec.id;
    option.textContent = spec.name;
    select.appendChild(option);
  }
}
