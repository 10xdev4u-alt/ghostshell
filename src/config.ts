import type { AgentConfig, ModelSpec } from '@/types/index.js';

/**
 * Central configuration. Everything here is overridable at runtime from the
 * Settings panel or via URL query params (`?model=qwen2.5-3b&net=fetch`).
 */

export const APP_VERSION = '0.1.0';
export const APP_NAME = 'GhostShell';

/** Default model registry. Expanded by the model picker. */
export const MODELS: ModelSpec[] = [
  {
    id: 'qwen2.5-1.5b',
    name: 'Qwen2.5-1.5B-Instruct',
    repo: 'Qwen/Qwen2.5-1.5B-Instruct-GGUF',
    sizeBytes: 1_040_000_000,
    contextLength: 32_768,
    quantization: 'q4_k_m',
    backend: 'wasm',
    license: 'Apache-2.0',
  },
  {
    id: 'qwen2.5-3b',
    name: 'Qwen2.5-3B-Instruct',
    repo: 'Qwen/Qwen2.5-3B-Instruct-GGUF',
    sizeBytes: 2_080_000_000,
    contextLength: 32_768,
    quantization: 'q4_k_m',
    backend: 'wasm',
    license: 'Apache-2.0',
  },
];

export const DEFAULT_MODEL_ID = 'qwen2.5-1.5b';

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  maxIterations: 24,
  toolTimeoutMs: 60_000,
  maxRetries: 2,
  contextWindow: 4096,
  temperature: 0.2,
  modelId: DEFAULT_MODEL_ID,
  networkMode: 'off',
  systemPrompt: '',
};

/** v86 is 32-bit, single-core, Pentium-4 class. Design within that. */
export const VM_CONSTRAINTS = {
  arch: 'ia32' as const,
  bits: 32,
  cores: 1,
  defaultMemoryMiB: 512,
  maxMemoryMiB: 2048,
  bootImage: 'alpine-3.21-i386',
} as const;

/** Model weight CDN. Pinned by sha256 where available. */
export const MODEL_CDN = {
  base: 'https://huggingface.co',
  cache: 'opfs' as 'opfs' | 'indexeddb',
};

/** Query-param overrides, e.g. ?model=qwen2.5-3b&net=fetch&debug=1 */
export function readQueryOverrides(): Partial<AgentConfig> {
  if (typeof globalThis.URLSearchParams === 'undefined') return {};
  const params = new URLSearchParams(globalThis.location?.search ?? '');
  const out: Partial<AgentConfig> = {};
  const model = params.get('model');
  const net = params.get('net');
  if (model) out.modelId = model;
  if (net && isNetworkMode(net)) out.networkMode = net;
  return out;
}

export function isNetworkMode(value: string): value is AgentConfig['networkMode'] {
  return value === 'off' || value === 'fetch' || value === 'wisp' || value === 'inbrowser';
}

/** Simple feature flags for incremental rollout. */
export const FLAGS = {
  webGpu: true,
  grammarConstrainedTools: true,
  twinView: true,
  artifactPanel: true,
  recipes: false,
  mcp: false,
  privacyAttestation: true,
  hostBridge: false,
  multiVm: false,
  voice: false,
};
