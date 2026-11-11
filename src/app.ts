import { EventBus } from '@/lib/events.js';
import { IdbDatabase } from '@/core/persistence/db.js';
import { ConversationRepository } from '@/core/persistence/conversations.js';
import { SnapshotManager } from '@/core/persistence/snapshots.js';
import { V86VMHandle } from '@/core/vm/v86.js';
import { createToolRegistry, makeSystemMessage, AgentLoop } from '@/core/agent/loop.js';
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
import { createDiffView } from '@/ui/diff.js';
import { createArtifactPanel } from '@/ui/artifact.js';
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
import type { AgentConfig, AppEventMap } from '@/types/index.js';

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

    this.chat = createChat(document.getElementById('gs-chat')!);
    this.terminal = createTerminal(document.getElementById('gs-terminal')!);
    this.twinView = createTwinView(this.bus);
    this.twinView.attach();
    this.fileTree = createFileTree(document.getElementById('gs-filetree')!);
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

    const config = this.settings?.get() ?? DEFAULT_AGENT_CONFIG;
    const engine = createEngine('transformers');
    const registry = createToolRegistry(builtinTools());
    this.loop = new AgentLoop(registry, {
      ...config,
      systemPrompt: buildSystemPrompt({
        modelName: getModel(config.modelId).name,
        workspace: '/root/workspace',
      }),
    });
    void engine;
    this.updateBadges();
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
