import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSettings,
  populateModelSelect,
  resolveSettingsConfig,
  SETTINGS_KEY,
  type SettingsStore,
} from '@/ui/settings.js';
import { DEFAULT_AGENT_CONFIG } from '@/config.js';
import { listModels } from '@/core/llm/models.js';
import type { AgentConfig } from '@/types/index.js';

/**
 * The settings panel must bind the selects in index.html, persist changes to
 * the settings store, and notify the app (issue #88 / #20). These tests use
 * minimal fakes because the suite runs in the Node environment (no DOM).
 */

class FakeOption {
  value: string;
  textContent: string;

  constructor(value = '', text = '') {
    this.value = value;
    this.textContent = text;
  }
}

class FakeSelect {
  value = '';
  readonly children: FakeOption[] = [];
  private readonly listeners = new Map<string, Set<() => void>>();

  appendChild(child: FakeOption): void {
    this.children.push(child);
  }

  replaceChildren(): void {
    this.children.length = 0;
  }

  addEventListener(type: string, fn: () => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn);
  }

  removeEventListener(type: string, fn: () => void): void {
    this.listeners.get(type)?.delete(fn);
  }

  change(value: string): void {
    this.value = value;
    for (const fn of this.listeners.get('change') ?? []) fn();
  }

  optionValues(): string[] {
    return this.children.map((child) => child.value);
  }
}

class FakeSettingsDb implements SettingsStore {
  readonly stored = new Map<string, unknown>();

  async setSetting(key: string, value: unknown): Promise<void> {
    this.stored.set(key, value);
  }
}

function asSelect(select: FakeSelect): HTMLSelectElement {
  return select as unknown as HTMLSelectElement;
}

describe('settings panel', () => {
  beforeEach(() => {
    vi.stubGlobal('document', {
      createElement: (_tag: string) => new FakeOption(),
      getElementById: () => null,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('populates the model select from the registry', () => {
    const select = new FakeSelect();
    populateModelSelect(asSelect(select));
    expect(select.optionValues()).toEqual(listModels().map((spec) => spec.id));
  });

  it('binds both selects and reflects the persisted config', () => {
    const db = new FakeSettingsDb();
    const modelSelect = new FakeSelect();
    const networkSelect = new FakeSelect();
    const settings = createSettings({
      config: { ...DEFAULT_AGENT_CONFIG, modelId: 'qwen2.5-3b', networkMode: 'fetch' },
      db,
      elements: { modelSelect: asSelect(modelSelect), networkSelect: asSelect(networkSelect) },
    });

    expect(modelSelect.optionValues()).toEqual(listModels().map((spec) => spec.id));
    expect(modelSelect.value).toBe('qwen2.5-3b');
    expect(networkSelect.value).toBe('fetch');
    settings.dispose();
  });

  it('persists and emits a model change', async () => {
    const db = new FakeSettingsDb();
    const modelSelect = new FakeSelect();
    const settings = createSettings({
      config: DEFAULT_AGENT_CONFIG,
      db,
      elements: { modelSelect: asSelect(modelSelect) },
    });
    const changes: string[] = [];
    settings.onChange((config) => changes.push(config.modelId));

    modelSelect.change('qwen2.5-3b');

    expect(settings.get().modelId).toBe('qwen2.5-3b');
    expect(changes).toEqual(['qwen2.5-3b']);
    await vi.waitFor(() =>
      expect(db.stored.get(SETTINGS_KEY)).toMatchObject({
        modelId: 'qwen2.5-3b',
        networkMode: DEFAULT_AGENT_CONFIG.networkMode,
      }),
    );
    settings.dispose();
  });

  it('persists and emits a network mode change', async () => {
    const db = new FakeSettingsDb();
    const networkSelect = new FakeSelect();
    const settings = createSettings({
      config: DEFAULT_AGENT_CONFIG,
      db,
      elements: { networkSelect: asSelect(networkSelect) },
    });
    const changes: AgentConfig['networkMode'][] = [];
    settings.onChange((config) => changes.push(config.networkMode));

    networkSelect.change('wisp');

    expect(settings.get().networkMode).toBe('wisp');
    expect(changes).toEqual(['wisp']);
    await vi.waitFor(() =>
      expect(db.stored.get(SETTINGS_KEY)).toMatchObject({ networkMode: 'wisp' }),
    );
    settings.dispose();
  });

  it('ignores an invalid network mode', () => {
    const db = new FakeSettingsDb();
    const networkSelect = new FakeSelect();
    const settings = createSettings({
      config: DEFAULT_AGENT_CONFIG,
      db,
      elements: { networkSelect: asSelect(networkSelect) },
    });

    networkSelect.change('bogus');

    expect(settings.get().networkMode).toBe(DEFAULT_AGENT_CONFIG.networkMode);
    expect(db.stored.has(SETTINGS_KEY)).toBe(false);
    settings.dispose();
  });

  it('stops listening after dispose', () => {
    const modelSelect = new FakeSelect();
    const settings = createSettings({
      config: DEFAULT_AGENT_CONFIG,
      elements: { modelSelect: asSelect(modelSelect) },
    });

    settings.dispose();
    modelSelect.change('qwen2.5-3b');

    expect(settings.get().modelId).toBe(DEFAULT_AGENT_CONFIG.modelId);
  });
});

describe('resolveSettingsConfig', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('applies persisted values over defaults', () => {
    const config = resolveSettingsConfig(DEFAULT_AGENT_CONFIG, {
      modelId: 'qwen2.5-3b',
      networkMode: 'fetch',
    });
    expect(config.modelId).toBe('qwen2.5-3b');
    expect(config.networkMode).toBe('fetch');
  });

  it('falls back to defaults for corrupt values', () => {
    const config = resolveSettingsConfig(DEFAULT_AGENT_CONFIG, {
      modelId: 'no-such-model',
      networkMode: 'bogus' as AgentConfig['networkMode'],
    });
    expect(config.modelId).toBe(DEFAULT_AGENT_CONFIG.modelId);
    expect(config.networkMode).toBe(DEFAULT_AGENT_CONFIG.networkMode);
  });

  it('applies query overrides last', () => {
    vi.stubGlobal('location', { search: '?model=qwen2.5-3b&net=wisp' });
    const config = resolveSettingsConfig(DEFAULT_AGENT_CONFIG, {
      modelId: 'qwen2.5-1.5b',
      networkMode: 'fetch',
    });
    expect(config.modelId).toBe('qwen2.5-3b');
    expect(config.networkMode).toBe('wisp');
  });
});
