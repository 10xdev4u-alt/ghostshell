import { describe, expect, it } from 'vitest';
import type { GenerateRequest } from '@/types/index.js';
import { WebLLMEngine } from '@/core/llm/webllm.js';

/**
 * The WebLLM engine is a declared v1.0 fast path that is not implemented yet
 * (issue #15). These tests pin the current contract: it reports unloaded and
 * fails loudly instead of silently falling back, so the factory never hands
 * the app an engine that cannot generate.
 */

describe('WebLLMEngine', () => {
  it('starts unloaded and unload keeps it unloaded', async () => {
    const engine = new WebLLMEngine();
    expect(engine.id).toBe('webllm');
    expect(engine.kind).toBe('webgpu');
    expect(engine.isLoaded()).toBe(false);
    await engine.unload();
    expect(engine.isLoaded()).toBe(false);
  });

  it('throws a not-implemented error from load', async () => {
    const engine = new WebLLMEngine();
    await expect(engine.load({} as never, () => undefined)).rejects.toThrow(
      'WebLLMEngine.load not implemented (issue #15)',
    );
  });

  it('throws a not-implemented error from generate', async () => {
    const engine = new WebLLMEngine();
    const request = { messages: [] } as GenerateRequest;
    await expect(
      engine.generate(request, () => undefined, new AbortController().signal),
    ).rejects.toThrow('WebLLMEngine.generate not implemented (issue #15)');
  });
});
