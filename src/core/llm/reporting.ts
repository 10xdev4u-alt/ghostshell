import type {
  GenerateRequest,
  GenerateResult,
  LLMEngine,
  ModelProgress,
  ModelSpec,
} from '@/types/index.js';

/**
 * Engine decorator that forwards generation progress to a fixed callback.
 *
 * The agent loop calls `generate` without a progress callback, so the app
 * wraps the engine to observe token-level progress without changing the loop.
 * Load progress already flows through the engine's own `onProgress` argument.
 */
export class ProgressReportingEngine implements LLMEngine {
  constructor(
    private readonly inner: LLMEngine,
    private readonly onProgress: (progress: ModelProgress) => void,
  ) {}

  get id(): string {
    return this.inner.id;
  }

  get kind() {
    return this.inner.kind;
  }

  isLoaded(): boolean {
    return this.inner.isLoaded();
  }

  load(
    spec: ModelSpec,
    onProgress: (p: ModelProgress) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.inner.load(spec, onProgress, signal);
  }

  unload(): Promise<void> {
    return this.inner.unload();
  }

  generate(
    req: GenerateRequest,
    onToken: (token: string) => void,
    signal: AbortSignal,
    onProgress?: (p: ModelProgress) => void,
  ): Promise<GenerateResult> {
    return this.inner.generate(req, onToken, signal, (progress) => {
      this.onProgress(progress);
      onProgress?.(progress);
    });
  }
}
