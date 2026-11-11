/**
 * GhostShell domain model.
 *
 * Every module depends on these types. They are deliberately backend-agnostic:
 * the same `LLMEngine` is satisfied by Transformers.js or WebLLM, the same
 * `VMHandle` by v86 today and a future native backend.
 */

export type UUID = string;

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

export type Quantization = 'q4_k_m' | 'q5_k_m' | 'q8_0' | 'f16';
export type BackendKind = 'wasm' | 'webgpu';

export interface ModelSpec {
  id: string;
  name: string;
  repo: string;
  sizeBytes: number;
  contextLength: number;
  quantization: Quantization;
  backend: BackendKind;
  license: string;
  sha256?: string;
}

export interface ModelCard {
  spec: ModelSpec;
  description: string;
  toolCallScore?: number;
  tokPerSec?: Record<string, number>;
}

// ---------------------------------------------------------------------------
// LLM engine
// ---------------------------------------------------------------------------

/**
 * The phases a model run actually reports.
 *
 * Transformers.js exposes file download progress (`initiate` / `download` /
 * `progress` / `done`) and a `ready` status, which map to `downloading` and
 * `loading`; `generating` is the token stream. The library has no callback
 * for ONNX session creation, so a `compiling` phase would have no emitter.
 * A phase in this list must be genuinely emitted — issue #102.
 */
export const MODEL_PROGRESS_PHASES = ['downloading', 'loading', 'generating'] as const;

export type ModelProgressPhase = (typeof MODEL_PROGRESS_PHASES)[number];

/**
 * Progress for a model load or generation run.
 *
 * `loaded`/`total` are bytes for the download/loading phases and generated
 * tokens for the generation phase. `total` is 0 when the size is unknown.
 * `percent` is 0–100, or `null` when `total` is unknown (indeterminate).
 */
export interface ModelProgress {
  phase: ModelProgressPhase;
  loaded: number;
  total: number;
  percent: number | null;
  message?: string;
}

/**
 * Load-phase progress. Kept as the legacy name; `ModelProgress` is the
 * unified event shape used by both `load` and `generate`.
 */
export interface LoadProgress {
  phase: ModelProgressPhase | 'extracting';
  loaded: number;
  total: number;
  message?: string;
  /** 0–100, or `null` when `total` is unknown. */
  percent?: number | null;
}

export interface GenerateRequest {
  messages: Message[];
  temperature?: number;
  maxTokens?: number;
  grammar?: string;
  stop?: string[];
}

export interface GenerateResult {
  text: string;
  tokens: number;
  finishReason: 'stop' | 'length' | 'error' | 'aborted';
  toolCalls?: ToolCall[];
}

export interface LLMEngine {
  readonly id: string;
  readonly kind: BackendKind;
  /**
   * Load a model, reporting progress. When `signal` aborts, the returned
   * promise rejects with an `AbortError` and the download is stopped.
   */
  load(
    spec: ModelSpec,
    onProgress: (p: ModelProgress) => void,
    signal?: AbortSignal,
  ): Promise<void>;
  unload(): Promise<void>;
  isLoaded(): boolean;
  generate(
    req: GenerateRequest,
    onToken: (token: string) => void,
    signal: AbortSignal,
    onProgress?: (p: ModelProgress) => void,
  ): Promise<GenerateResult>;
}

// ---------------------------------------------------------------------------
// Messages / conversation
// ---------------------------------------------------------------------------

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  raw: string;
}

export interface ToolResult {
  ok: boolean;
  content: string;
  artifacts?: Artifact[];
  metadata?: Record<string, unknown>;
}

export interface Message {
  id: UUID;
  role: MessageRole;
  content: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  timestamp: number;
  model?: string;
}

export interface Conversation {
  id: UUID;
  title: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
  modelId: string;
  vmSnapshotId?: UUID;
}

// ---------------------------------------------------------------------------
// Tools / agent
// ---------------------------------------------------------------------------

export interface JSONSchema {
  type: 'object';
  properties: Record<string, JSONSchemaProperty>;
  required?: string[];
}

export interface JSONSchemaProperty {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description?: string;
  items?: JSONSchemaProperty;
  enum?: string[];
}

export interface ToolContext {
  vm: VMHandle;
  llm: LLMEngine;
  db: Database;
  egress: EgressLog;
  signal?: AbortSignal;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JSONSchema;
  execute: (ctx: ToolContext, args: Record<string, unknown>) => Promise<ToolResult>;
}

export interface AgentConfig {
  maxIterations: number;
  toolTimeoutMs: number;
  maxRetries: number;
  contextWindow: number;
  temperature: number;
  modelId: string;
  networkMode: NetworkMode;
  systemPrompt: string;
}

export type NetworkMode = 'off' | 'fetch' | 'wisp' | 'inbrowser';

// ---------------------------------------------------------------------------
// VM
// ---------------------------------------------------------------------------

export interface VMImage {
  id: string;
  name: string;
  arch: 'ia32';
  sizeBytes: number;
  url?: string;
  prebaked: string[];
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
}

export interface DirEntry {
  name: string;
  kind: 'file' | 'dir' | 'symlink';
  size: number;
  mtime: number;
}

export interface VMHandle {
  readonly id: string;
  readonly running: boolean;
  start(image: VMImage): Promise<void>;
  stop(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  exec(cmd: string, timeoutMs?: number): Promise<CommandResult>;
  /**
   * Write raw data to the guest serial console. Used to interrupt a running
   * command (`\x03`); no-op when the VM is not running.
   */
  sendSerial(data: string): void;
  write(path: string, content: string): Promise<void>;
  read(path: string): Promise<string>;
  list(path: string): Promise<DirEntry[]>;
  onSerial: (fn: (data: string) => void) => void;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export interface VMSnapshot {
  id: UUID;
  conversationId: UUID;
  createdAt: number;
  kind: 'full' | 'delta';
  sizeBytes: number;
  stateRef: string;
}

export interface Database {
  open(): Promise<void>;
  close(): Promise<void>;
  putConversation(c: Conversation): Promise<void>;
  getConversation(id: UUID): Promise<Conversation | undefined>;
  listConversations(): Promise<Conversation[]>;
  deleteConversation(id: UUID): Promise<void>;
  putSnapshot(s: VMSnapshot, data: Uint8Array): Promise<void>;
  getSnapshot(id: UUID): Promise<{ meta: VMSnapshot; data: Uint8Array } | undefined>;
  deleteSnapshot(id: UUID): Promise<void>;
  setSetting(key: string, value: unknown): Promise<void>;
  getSetting<T>(key: string): Promise<T | undefined>;
}

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

export interface EgressEvent {
  id: UUID;
  timestamp: number;
  url: string;
  method: string;
  blocked: boolean;
  reason?: string | undefined;
}

export interface EgressLog {
  record(event: Omit<EgressEvent, 'id' | 'timestamp'>): void;
  list(): EgressEvent[];
  clear(): void;
}

export interface PrivacyReport {
  htmlSha256: string;
  modelSha256: string;
  vmImageSha256: string;
  dependencies: { name: string; version: string; license: string }[];
  egress: EgressEvent[];
  generatedAt: number;
  signature?: string;
}

// ---------------------------------------------------------------------------
// Artifacts / plugins
// ---------------------------------------------------------------------------

export type ArtifactKind = 'html' | 'svg' | 'markdown' | 'canvas' | 'json';

export interface Artifact {
  id: UUID;
  kind: ArtifactKind;
  content: string;
  mime: string;
  createdAt: number;
}

export interface Recipe {
  /** Unique recipe name, also used for the installed registry key. */
  name: string;
  /** Semantic version of the recipe manifest. */
  version: string;
  description: string;
  license: string;
  author: string;
  /** System-prompt fragment merged into the agent prompt on install. */
  prompt: string;
  /** Built-in tool names this recipe is allowed to use. */
  tools: string[];
  fewShot?: unknown;
  /** Shell script run inside the VM during install. */
  setup: string;
  /** Optional shell script that reverses `setup`, run during uninstall. */
  unsetup?: string | undefined;
  evals?: unknown;
  /**
   * Integrity check over the canonical recipe JSON (sorted keys), excluding
   * the `integrity` field itself. See `canonicalRecipe` in plugins/recipes.ts.
   */
  integrity: { sha256: string };
}

export interface MCPServer {
  name: string;
  transport: 'stdio' | 'sse' | 'http';
  /** Executable for stdio servers (run inside the VM). */
  command?: string | undefined;
  /** Arguments passed to `command` for stdio servers. */
  args?: string[] | undefined;
  /** Endpoint for `http` (Streamable HTTP) and `sse` servers. */
  url?: string | undefined;
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface EventListener<T> {
  (event: T): void;
}

export interface AppEventMap {
  'vm:serial': string;
  'vm:ready': void;
  'vm:stopped': void;
  'llm:progress': ModelProgress;
  'llm:token': string;
  'llm:loaded': void;
  'agent:tool-call': ToolCall;
  'agent:tool-result': ToolResult;
  'agent:message': Message;
  'egress': EgressEvent;
  'snapshot': VMSnapshot;
}
