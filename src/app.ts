import { EventBus } from '@/lib/events.js';
import { uuid } from '@/lib/utils.js';
import { IdbDatabase } from '@/core/persistence/db.js';
import { ConversationRepository } from '@/core/persistence/conversations.js';
import { SnapshotManager } from '@/core/persistence/snapshots.js';
import { V86VMHandle } from '@/core/vm/v86.js';
import { createToolRegistry, AgentLoop, type AgentStep } from '@/core/agent/loop.js';
import { builtinTools } from '@/core/agent/tools.js';
import { buildSystemPrompt } from '@/core/agent/prompts.js';
import { createEngine } from '@/core/llm/engine.js';
import { ATTESTATION_CONFIG, DEFAULT_AGENT_CONFIG, FLAGS } from '@/config.js';
import { ALPINE_BOOT, getImage } from '@/core/vm/image.js';
import { buildNetDevice } from '@/core/vm/network.js';
import { createV86Filesystem, DEFAULT_FS_PREFIX } from '@/core/vm/fs9p.js';
import { createChat } from '@/ui/chat.js';
import { createTerminal } from '@/ui/terminal.js';
import { createTwinView } from '@/ui/twinview.js';
import { createFileTree } from '@/ui/filetree.js';
import { computeDiff, createDiffView, type DiffEntry } from '@/ui/diff.js';
import { createArtifactPanel } from '@/ui/artifact.js';
import { createSerialFilter, type SerialFilter } from '@/ui/serial.js';
import type { ToolLineRange } from '@/ui/lineRange.js';
import {
  createPrivacyReportSection,
  createSettings,
  resolveSettingsConfig,
  SETTINGS_KEY,
} from '@/ui/settings.js';
import {
  BOOT_EGRESS_ALLOWLIST,
  installEgressInterceptor,
  InMemoryEgressLog,
} from '@/core/security/egress.js';
import { V86_WASM_URL } from '@/core/vm/wasm.js';
import { getModel } from '@/core/llm/models.js';
import type {
  AgentConfig,
  AppEventMap,
  Artifact,
  CommandResult,
  Conversation,
  DirEntry,
  LLMEngine,
  Message,
  ToolContext,
  VMHandle,
  VMImage,
} from '@/types/index.js';

/** Guest directory the agent works in and the diff viewer watches. */
const WORKSPACE_ROOT = '/root/workspace';

/**
 * App orchestrator. Wires the core modules to the UI.
 *
 * Lifecycle:
 *   1. open the DB, install the egress interceptor
 *   2. build the UI panels and the serial filter
 *   3. boot the VM on the user's first action
 *   4. load the LLM lazily on the first chat submit
 */
export class App {
  readonly bus = new EventBus<AppEventMap>();
  readonly db = new IdbDatabase();
  readonly egress = new InMemoryEgressLog();
  /**
   * Boots the vendored Alpine image. `ALPINE_BOOT` supplies the BIOS, VGA
   * BIOS, and kernel cmdline; the guest root is the persistent OPFS-backed
   * 9p filesystem; the NIC comes from the selected network mode.
   */
  readonly vm = new V86VMHandle({
    bios: { url: ALPINE_BOOT.biosUrl },
    vgaBios: { url: ALPINE_BOOT.vgaBiosUrl },
    cmdline: ALPINE_BOOT.cmdline,
    filesystem: createV86Filesystem({ prefix: DEFAULT_FS_PREFIX }),
    netDevice: buildNetDevice({ mode: DEFAULT_AGENT_CONFIG.networkMode }),
    // The single-file release has no build/ directory next to the page, so
    // the emulator WASM is inlined into the bundle and handed to v86 as a
    // data: URL (src/core/vm/wasm.ts).
    wasmPath: V86_WASM_URL,
  });
  readonly conversations: ConversationRepository;
  readonly snapshots: SnapshotManager;

  private readonly serialFilter: SerialFilter = createSerialFilter();
  private filteredVM!: VMHandle;
  private chat!: ReturnType<typeof createChat>;
  private terminal: ReturnType<typeof createTerminal> | null = null;
  private twinView: ReturnType<typeof createTwinView> | null = null;
  private fileTree: ReturnType<typeof createFileTree> | null = null;
  private diffView: ReturnType<typeof createDiffView> | null = null;
  private artifact: ReturnType<typeof createArtifactPanel> | null = null;
  private settings: ReturnType<typeof createSettings> | null = null;
  private engine: LLMEngine | null = null;
  private engineLoad: Promise<LLMEngine> | null = null;
  private conversation: Conversation | null = null;
  private runController: AbortController | null = null;
  private restoreEgress: (() => void) | null = null;

  constructor() {
    this.conversations = new ConversationRepository(this.db);
    this.snapshots = new SnapshotManager(this.db);
  }

  async init(): Promise<void> {
    await this.db.open();
    const persisted = await this.db.getSetting<Partial<AgentConfig>>(SETTINGS_KEY);
    const config = resolveSettingsConfig(DEFAULT_AGENT_CONFIG, persisted);
    // The persisted network mode must be in place before the first boot;
    // a running VM keeps the device it booted with until restarted.
    this.vm.setNetDevice(buildNetDevice({ mode: config.networkMode }));
    this.restoreEgress = installEgressInterceptor(
      this.egress,
      config.networkMode === 'off',
      BOOT_EGRESS_ALLOWLIST,
    );

    this.filteredVM = new FilteringVMHandle(this.vm, this.serialFilter);

    this.chat = createChat(document.getElementById('gs-chat')!);
    this.chat.onSubmit((text) => void this.handleSubmit(text));
    this.chat.attach();

    this.terminal = createTerminal(document.getElementById('gs-terminal')!, this.bus);
    this.twinView = createTwinView({ bus: this.bus, terminal: this.terminal });
    this.twinView.attach();

    this.fileTree = createFileTree(document.getElementById('gs-filetree')!);
    this.fileTree.attach();
    this.diffView = createDiffView(document.getElementById('gs-diff')!);
    this.artifact = createArtifactPanel(document.getElementById('gs-artifact')!);
    this.settings = createSettings({ config, db: this.db });
    this.settings.onChange((next) => this.applyConfigChange(next));

    if (FLAGS.privacyAttestation) {
      const privacyMount = document.getElementById('gs-privacy-report');
      if (privacyMount) {
        privacyMount.appendChild(
          createPrivacyReportSection({
            config: ATTESTATION_CONFIG,
            egress: () => this.egress.list(),
          }),
        );
      }
    }

    // The raw serial stream carries the command-runner sentinel protocol.
    // Filter it once here so the terminal and twin-view only see guest output.
    this.vm.onSerial((data) => {
      const filtered = this.serialFilter.write(data);
      if (filtered.length > 0) this.bus.emit('vm:serial', filtered);
    });

    const startBtn = document.getElementById('gs-start') as HTMLButtonElement | null;
    startBtn?.addEventListener('click', () => void this.start());

    this.wireTabs();
    this.updateBadges();
  }

  private wireTabs(): void {
    for (const tab of document.querySelectorAll<HTMLElement>('.gs-tab')) {
      tab.addEventListener('click', () => this.activateTab(tab.dataset['tab']!));
    }
  }

  private activateTab(name: string): void {
    for (const tab of document.querySelectorAll<HTMLElement>('.gs-tab')) {
      tab.classList.toggle('is-active', tab.dataset['tab'] === name);
    }
    for (const panel of document.querySelectorAll<HTMLElement>('.gs-tab-panel')) {
      panel.classList.toggle('is-active', panel.id === `gs-panel-${name}`);
    }
    if (name === 'terminal') this.terminal?.fit();
    if (name === 'files') void this.fileTree?.refresh();
  }

  async start(): Promise<void> {
    if (this.vm.running) return;
    const image = getImage('alpine-3.21-i386');
    await this.vm.start(image);
    this.serialFilter.reset();
    this.fileTree?.setVM(this.filteredVM);
    this.bus.emit('vm:ready', undefined);

    document.querySelector('.gs-welcome')?.classList.add('is-hidden');
    const startBtn = document.getElementById('gs-start') as HTMLButtonElement | null;
    if (startBtn) {
      startBtn.disabled = true;
      startBtn.textContent = 'Running…';
    }
    this.updateBadges();
  }

  /**
   * Handle a chat submit: append the user message, load the model on first
   * use, run the agent loop, and persist the resulting conversation.
   */
  private async handleSubmit(text: string): Promise<void> {
    if (!this.vm.running) {
      this.chat?.append({
        id: uuid(),
        role: 'assistant',
        content: 'Click "Start GhostShell" to boot the VM first.',
        timestamp: Date.now(),
      });
      return;
    }

    const config = this.settings?.get() ?? DEFAULT_AGENT_CONFIG;
    const userMessage: Message = { id: uuid(), role: 'user', content: text, timestamp: Date.now() };
    this.chat?.append(userMessage);
    this.bus.emit('agent:message', userMessage);
    this.chat?.setWorking(true);

    try {
      const engine = await this.ensureEngine();
      const conversation = await this.ensureConversation(config.modelId, text);
      conversation.messages.push(userMessage);
      await this.db.putConversation(conversation);

      const before = await snapshotWorkspace(this.filteredVM, WORKSPACE_ROOT);
      const loop = this.createLoop(config);
      const controller = new AbortController();
      this.runController = controller;

      const result = await loop.run(
        conversation,
        {
          vm: this.filteredVM,
          llm: engine,
          db: this.db,
          egress: this.egress,
          signal: controller.signal,
        },
        (step) => this.handleStep(step, config),
        controller.signal,
      );
      this.runController = null;

      conversation.messages = result.messages;
      conversation.updatedAt = Date.now();
      await this.db.putConversation(conversation);

      const after = await snapshotWorkspace(this.filteredVM, WORKSPACE_ROOT);
      this.showDiff(before, after);
      this.chat?.setWorking(false);
    } catch (err) {
      this.runController = null;
      this.chat?.append({
        id: uuid(),
        role: 'assistant',
        content: `Something went wrong: ${errorMessage(err)}`,
        timestamp: Date.now(),
      });
      this.chat?.setWorking(false);
    }
  }

  /** Stream one agent step into the chat, twin-view, file tree, and artifact panel. */
  private handleStep(step: AgentStep, config: AgentConfig): void {
    this.chat?.append(step.message);
    this.bus.emit('agent:message', step.message);

    // The loop executes tool calls in order, so the twin-view ranges line up
    // with `step.toolCalls` by index.
    const ranges = this.twinView?.takeRanges() ?? [];
    const toolRanges: ToolLineRange[] = [];
    for (let i = 0; i < step.toolCalls.length && i < ranges.length; i += 1) {
      const call = step.toolCalls[i]!;
      const range = ranges[i]!;
      toolRanges.push({ start: range.start, end: range.end, callId: call.id });
    }
    if (toolRanges.length > 0) {
      this.chat?.annotateToolCalls(step.message.id, toolRanges, (start, end) =>
        this.jumpToRange(start, end),
      );
    }

    for (const call of step.toolCalls) this.bus.emit('agent:tool-call', call);

    for (const result of step.results) {
      this.bus.emit('agent:tool-result', result);
      const toolMessage: Message = {
        id: uuid(),
        role: 'tool',
        content: result.content,
        timestamp: Date.now(),
        model: config.modelId,
      };
      this.chat?.append(toolMessage);
      this.bus.emit('agent:message', toolMessage);
      const artifact = result.artifacts?.[0];
      if (artifact) this.showArtifact(artifact);
    }

    void this.fileTree?.refresh();
  }

  private jumpToRange(start: number, end: number): void {
    void end;
    this.activateTab('terminal');
    this.terminal?.fit();
    this.twinView?.scrollTerminalToLine(start);
  }

  private showDiff(before: Map<string, string>, after: Map<string, string>): void {
    const entries: DiffEntry[] = [];
    for (const entry of computeDiff(before, after)) {
      const enriched: DiffEntry = { path: entry.path, kind: entry.kind };
      const beforeContent = before.get(entry.path);
      const afterContent = after.get(entry.path);
      if (beforeContent !== undefined) enriched.before = beforeContent;
      if (afterContent !== undefined) enriched.after = afterContent;
      entries.push(enriched);
    }
    this.diffView?.show(entries.length > 0 ? 'Agent changes' : 'No changes.', entries);
  }

  private showArtifact(artifact: Artifact): void {
    const content =
      artifact.kind === 'html' || artifact.kind === 'svg'
        ? { kind: 'html' as const, content: artifact.content }
        : { kind: 'text' as const, content: artifact.content };
    this.artifact?.show(content);
  }

  private async ensureConversation(modelId: string, title: string): Promise<Conversation> {
    if (this.conversation) return this.conversation;
    this.conversation = await this.conversations.create(title.slice(0, 60), modelId);
    return this.conversation;
  }

  /**
   * Load the configured model on first use. The engine is created once and
   * reused; concurrent callers share the same in-flight load.
   */
  private ensureEngine(): Promise<LLMEngine> {
    if (this.engine?.isLoaded()) return Promise.resolve(this.engine);
    if (this.engineLoad) return this.engineLoad;

    const config = this.settings?.get() ?? DEFAULT_AGENT_CONFIG;
    const spec = getModel(config.modelId);
    const engine = createEngine('transformers', { spec });
    this.engine = engine;
    this.updateModelBadge();

    this.engineLoad = engine
      .load(spec, (progress) => {
        this.bus.emit('llm:progress', progress);
        this.updateModelBadge();
      })
      .then(() => {
        this.engineLoad = null;
        this.bus.emit('llm:loaded', undefined);
        this.updateModelBadge();
        return engine;
      })
      .catch((err: unknown) => {
        this.engineLoad = null;
        if (this.engine === engine) this.engine = null;
        this.updateModelBadge();
        throw err;
      });

    return this.engineLoad;
  }

  private createLoop(config: AgentConfig): AgentLoop {
    const registry = createToolRegistry(builtinTools());

    // Wrap every tool so the twin-view can record the serial lines it produced.
    for (const tool of registry.values()) {
      const execute = tool.execute;
      tool.execute = async (ctx, args) => {
        const start = this.twinView?.beginTool() ?? 0;
        try {
          return await execute(ctx, args);
        } finally {
          this.twinView?.endTool(start);
        }
      };
    }

    return new AgentLoop(registry, {
      ...config,
      systemPrompt: buildSystemPrompt({
        modelName: getModel(config.modelId).name,
        workspace: WORKSPACE_ROOT,
      }),
    });
  }

  /**
   * Apply a settings change made in the panel.
   *
   * The network device is rebuilt for the next boot (a running VM keeps its
   * NIC), and the egress interceptor is reinstalled so lockdown follows the
   * selected mode.
   */
  private applyConfigChange(config: AgentConfig): void {
    this.vm.setNetDevice(buildNetDevice({ mode: config.networkMode }));
    this.restoreEgress?.();
    this.restoreEgress = installEgressInterceptor(
      this.egress,
      config.networkMode === 'off',
      BOOT_EGRESS_ALLOWLIST,
    );
    this.updateBadges();
  }

  private updateBadges(): void {
    const vm = document.getElementById('gs-vm');
    if (vm) vm.textContent = this.vm.running ? '🖥️ running' : '🖥️ stopped';
    const egress = document.getElementById('gs-egress');
    if (egress) {
      const lockdown = this.settings?.get().networkMode === 'off';
      egress.textContent = lockdown ? '🌐 offline (lockdown)' : '🌐 online (logged)';
    }
    this.updateModelBadge();
  }

  private updateModelBadge(): void {
    const model = document.getElementById('gs-model');
    if (!model) return;
    if (this.engine?.isLoaded()) model.textContent = '🧠 loaded';
    else if (this.engineLoad) model.textContent = '🧠 loading…';
    else model.textContent = '🧠 unloaded';
  }

  dispose(): void {
    this.restoreEgress?.();
    this.runController?.abort();
    this.twinView?.detach();
    this.chat?.dispose();
    this.terminal?.dispose();
    this.fileTree?.dispose();
    this.diffView?.dispose();
    this.artifact?.dispose();
    this.settings?.dispose();
    void this.db.close();
  }
}

/**
 * VMHandle wrapper that tells the serial filter which command is running.
 *
 * The filter's state machine already drops the sentinel wrapper, so the
 * command context is a fallback for transports that interleave the echoed
 * command with the begin marker. The wrapper also gives the agent loop and
 * the file tree a single handle whose serial output is filtered.
 */
class FilteringVMHandle implements VMHandle {
  constructor(
    private readonly inner: VMHandle,
    private readonly filter: SerialFilter,
  ) {}

  get id(): string {
    return this.inner.id;
  }

  get running(): boolean {
    return this.inner.running;
  }

  start(image: VMImage): Promise<void> {
    return this.inner.start(image);
  }

  stop(): Promise<void> {
    this.filter.reset();
    return this.inner.stop();
  }

  pause(): Promise<void> {
    return this.inner.pause();
  }

  resume(): Promise<void> {
    return this.inner.resume();
  }

  sendSerial(data: string): void {
    this.inner.sendSerial(data);
  }

  async exec(cmd: string, timeoutMs?: number): Promise<CommandResult> {
    this.filter.beginCommand(cmd);
    try {
      return await this.inner.exec(cmd, timeoutMs);
    } finally {
      this.filter.endCommand();
    }
  }

  write(path: string, content: string): Promise<void> {
    return this.inner.write(path, content);
  }

  read(path: string): Promise<string> {
    return this.inner.read(path);
  }

  async list(path: string): Promise<DirEntry[]> {
    this.filter.beginCommand(`list ${path}`);
    try {
      return await this.inner.list(path);
    } finally {
      this.filter.endCommand();
    }
  }

  onSerial = (fn: (data: string) => void): void => {
    this.inner.onSerial(fn);
  };
}

/**
 * Read every text file under `root` into a path -> content map. Used to diff
 * the workspace before and after an agent turn. Unreadable and binary files
 * are skipped.
 */
async function snapshotWorkspace(vm: VMHandle, root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();

  const walk = async (dir: string): Promise<void> => {
    let entries: DirEntry[];
    try {
      entries = await vm.list(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = dir === '/' ? `/${entry.name}` : `${dir}/${entry.name}`;
      if (entry.kind === 'dir') {
        await walk(path);
      } else if (entry.kind === 'file') {
        try {
          const content = await vm.read(path);
          if (!content.includes(String.fromCharCode(0))) files.set(path, content);
        } catch {
          // Skip files that disappear or cannot be read.
        }
      }
    }
  };

  await walk(root);
  return files;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
