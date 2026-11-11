import { describe, expect, it, vi } from 'vitest';
import type { GenerateRequest, GenerateResult, LLMEngine, ModelProgress, ModelSpec } from '@/types/index.js';
import { ProgressReportingEngine } from '@/core/llm/reporting.js';

/**
 * ProgressReportingEngine is a decorator: it must forward every call to the
 * wrapped engine and mirror generation progress to the fixed callback the app
 * installed, without swallowing the per-call callback.
 */

function makeInner(): LLMEngine {
  return {
    id: 'inner',
    kind: 'wasm',
    load: vi.fn(async () => undefined),
    unload: vi.fn(async () => undefined),
    isLoaded: vi.fn(() => true),
    generate: vi.fn(async (): Promise<GenerateResult> => ({ text: 'ok', tokens: 2, finishReason: 'stop' })),
  };
}

const spec: ModelSpec = {
  id: 'm',
  name: 'M',
  repo: 'r',
  sizeBytes: 1,
  contextLength: 1,
  quantization: 'q4_k_m',
  backend: 'wasm',
  license: 'MIT',
};

const progress = (phase: ModelProgress['phase']): ModelProgress => ({
  phase,
  loaded: 1,
  total: 2,
  percent: 50,
});

describe('ProgressReportingEngine', () => {
  it('delegates identity and lifecycle calls to the inner engine', () => {
    const inner = makeInner();
    const engine = new ProgressReportingEngine(inner, vi.fn());

    expect(engine.id).toBe('inner');
    expect(engine.kind).toBe('wasm');
    expect(engine.isLoaded()).toBe(true);
    expect(inner.isLoaded).toHaveBeenCalled();

    engine.load(spec, vi.fn());
    expect(inner.load).toHaveBeenCalledWith(spec, expect.any(Function), undefined);

    engine.unload();
    expect(inner.unload).toHaveBeenCalled();
  });

  it('forwards generation progress to the fixed callback and the per-call callback', async () => {
    const inner = makeInner();
    const fixed = vi.fn();
    const engine = new ProgressReportingEngine(inner, fixed);
    const perCall = vi.fn();

    const result = await engine.generate({ messages: [] }, vi.fn(), new AbortController().signal, perCall);

    expect(result).toEqual({ text: 'ok', tokens: 2, finishReason: 'stop' });
    expect(inner.generate).toHaveBeenCalledTimes(1);

    const [, , , forwarded] = vi.mocked(inner.generate).mock.calls[0]!;
    expect(forwarded).toEqual(expect.any(Function));
    forwarded!(progress('generating'));

    expect(fixed).toHaveBeenCalledWith(progress('generating'));
    expect(perCall).toHaveBeenCalledWith(progress('generating'));
  });

  it('works without a per-call progress callback', async () => {
    const inner = makeInner();
    const fixed = vi.fn();
    const engine = new ProgressReportingEngine(inner, fixed);

    await engine.generate({ messages: [] }, vi.fn(), new AbortController().signal);

    const [, , , forwarded] = vi.mocked(inner.generate).mock.calls[0]!;
    expect(() => forwarded!(progress('loading'))).not.toThrow();
    expect(fixed).toHaveBeenCalledWith(progress('loading'));
  });
});
