import type { GenerateRequest, GenerateResult, LLMEngine, LoadProgress, ModelSpec } from '@/types/index.js';

/**
 * WebLLM engine (WebGPU fast path).
 *
 * Uses @mlc-ai/web-llm. Supports JSON-mode constrained decoding (grammar),
 * SRI integrity, and OPFS cache — all verified in the WebLLM README.
 *
 * This is the engine that makes grammar-constrained tool calls practical.
 */
export class WebLLMEngine implements LLMEngine {
  readonly id = 'webllm';
  readonly kind = 'webgpu';
  private loaded = false;

  isLoaded(): boolean {
    return this.loaded;
  }

  async load(spec: ModelSpec, onProgress: (p: LoadProgress) => void): Promise<void> {
    // TODO: new webllm.MLCEngine(), reload(spec.repo), progress callback,
    //       cache: 'opfs', function calling enabled.
    void spec;
    void onProgress;
    throw new Error('WebLLMEngine.load not implemented (issue #15)');
  }

  async unload(): Promise<void> {
    this.loaded = false;
  }

  async generate(
    req: GenerateRequest,
    onToken: (token: string) => void,
    signal: AbortSignal,
  ): Promise<GenerateResult> {
    // TODO: chat.completions.create({ messages, stream: true, ... })
    void req;
    void onToken;
    void signal;
    throw new Error('WebLLMEngine.generate not implemented (issue #15)');
  }
}
