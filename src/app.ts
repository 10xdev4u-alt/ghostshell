import { EventBus } from '@/lib/events.js';
import { IdbDatabase } from '@/core/persistence/db.js';
import { ConversationRepository } from '@/core/persistence/conversations.js';
import { SnapshotManager } from '@/core/persistence/snapshots.js';
import { V86VMHandle } from '@/core/vm/v86.js';
import { createToolRegistry, makeSystemMessage, AgentLoop } from '@/core/agent/loop.js';
import { builtinTools } from '@/core/agent/tools.js';
import { buildSystemPrompt } from '@/core/agent/prompts.js';
import { createEngine } from '@/core/llm/engine.js';
import { DEFAULT_AGENT_CONFIG, FLAGS } from '@/config.js';
import { getImage } from '@/core/vm/image.js';
import { createChat } from '@/ui/chat.js';
import { createTerminal } from '@/ui/terminal.js';
import { createTwinView } from '@/ui/twinview.js';
import { createFileTree } from '@/ui/filetree.js';
import { createDiffView } from '@/ui/diff.js';
import { createArtifactPanel } from '@/ui/artifact.js';
import { createSettings } from '@/ui/settings.js';
import { installEgressInterceptor, InMemoryEgressLog } from '@/core/security/egress.js';
import type { AppEventMap } from '@/types/index.js';

/**
 * App orchestrator. Wires the core modules to the UI.
 *
 * Lifecycle:
 *   1. open the DB, install the egress interceptor
 *   2. build the VM / LLM / agent loop
 *   3. wire UI events
 *   4. start the VM on first user action
 */
export class App {
  readonly bus = new EventBus<AppEventMap>();
  readonly db = new IdbDatabase();
  readonly egress = new InMemoryEgressLog();
  readonly vm = new V86VMHandle();
  readonly conversations: ConversationRepository;
  readonly snapshots: SnapshotManager;

  private chat!: ReturnType<typeof createChat>;
  private terminal: ReturnType<typeof createTerminal> | null = null;
  private twinView: ReturnType<typeof createTwinView> | null = null;
  private fileTree: ReturnType<typeof createFileTree> | null = null;
  private diffView: ReturnType<typeof createDiffView> | null = null;
  private artifact: ReturnType<typeof createArtifactPanel> | null = null;
  private settings: ReturnType<typeof createSettings> | null = null;
  private loop: AgentLoop | null = null;
  private restoreEgress: (() => void) | null = null;

  constructor() {
    this.conversations = new ConversationRepository(this.db);
    this.snapshots = new SnapshotManager(this.db);
  }

  async init(): Promise<void> {
    await this.db.open();
    this.restoreEgress = installEgressInterceptor(this.egress, DEFAULT_AGENT_CONFIG.networkMode === 'off');

    this.chat = createChat(document.getElementById('gs-chat')!);
    this.terminal = createTerminal(document.getElementById('gs-terminal')!);
    this.twinView = createTwinView(this.bus);
    this.twinView.attach();
    this.fileTree = createFileTree(document.getElementById('gs-filetree')!);
    this.diffView = createDiffView(document.getElementById('gs-diff')!);
    this.artifact = createArtifactPanel(document.getElementById('gs-artifact')!);
    this.settings = createSettings(DEFAULT_AGENT_CONFIG);

    this.vm.onSerial((data) => this.bus.emit('vm:serial', data));

    const startBtn = document.getElementById('gs-start');
    startBtn?.addEventListener('click', () => void this.start());

    this.wireTabs();
    this.updateBadges();
  }

  private wireTabs(): void {
    const tabs = document.querySelectorAll<HTMLElement>('.gs-tab');
    for (const tab of tabs) {
      tab.addEventListener('click', () => {
        const name = tab.dataset['tab']!;
        for (const t of tabs) t.classList.toggle('is-active', t === tab);
        for (const panel of document.querySelectorAll('.gs-tab-panel')) {
          panel.classList.toggle('is-active', panel.id === `gs-panel-${name}`);
        }
        if (name === 'terminal') this.terminal?.fit();
      });
    }
  }

  async start(): Promise<void> {
    const image = getImage('alpine-3.21-i386');
    await this.vm.start(image);
    this.bus.emit('vm:ready', undefined);

    const engine = createEngine('transformers');
    const registry = createToolRegistry(builtinTools());
    this.loop = new AgentLoop(registry, {
      ...DEFAULT_AGENT_CONFIG,
      systemPrompt: buildSystemPrompt({ modelName: 'Qwen2.5-1.5B', workspace: '/root/workspace' }),
    });
    void engine;
    this.updateBadges();
  }

  private updateBadges(): void {
    const vm = document.getElementById('gs-vm');
    if (vm) vm.textContent = this.vm.running ? '🖥️ running' : '🖥️ stopped';
    const egress = document.getElementById('gs-egress');
    if (egress) egress.textContent = '🌐 offline (lockdown)';
  }

  dispose(): void {
    this.restoreEgress?.();
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
