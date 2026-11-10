import type { GenerateRequest, GenerateResult, LLMEngine, LoadProgress, ModelSpec } from '@/types/index.js';

/**
 * Transformers.js engine (pure WASM, default).
 *
 * Uses @huggingface/transformers with the ONNX runtime. Model weights are
 * fetched from HF, cached in OPFS/IndexedDB, and loaded into a Web Worker so
 * the UI stays responsive.
 *
 * See docs/ENGINEERING_PLAN.md §3.2 for the model table and perf budget.
 */
export class TransformersEngine implements LLMEngine {
  readonly id = 'transformers';
  readonly kind = 'wasm';
  private loaded = false;
  private spec: ModelSpec | null = null;

  isLoaded(): boolean {
    return this.loaded;
  }

  async load(spec: ModelSpec, onProgress: (p: LoadProgress) => void): Promise<void> {
    this.spec = spec;
    // TODO: pipeline('text-generation', spec.repo) with dtype quantization,
    //       device: 'wasm' | 'webgpu', progress callback.
    void onProgress;
    throw new Error('TransformersEngine.load not implemented (issue #14)');
  }

  async unload(): Promise<void> {
    this.loaded = false;
    this.spec = null;
  }

  async generate(
    req: GenerateRequest,
    onToken: (token: string) => void,
    signal: AbortSignal,
  ): Promise<GenerateResult> {
    // TODO: tokenizer.apply_chat_template, generator loop, streaming callback.
    void req;
    void onToken;
    void signal;
    throw new Error('TransformersEngine.generate not implemented (issue #14)');
  }
}
