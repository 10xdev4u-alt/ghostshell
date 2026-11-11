import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentConfig,
  Conversation,
  GenerateResult,
  Message,
  ModelProgress,
  ToolDefinition,
  VMHandle,
  VMImage,
} from '@/types/index.js';
import type { AgentRunResult, AgentStep } from '@/core/agent/loop.js';
import type { LineRange, ToolLineRange } from '@/ui/lineRange.js';
import { App } from '@/app.js';
import { SETTINGS_KEY } from '@/ui/settings.js';

/**
 * App orchestration tests.
 *
 * The App class wires the core modules to the UI. Its branches (boot failure,
 * engine load failure, aborts, model changes, settings changes) are where the
 * app's error handling lives, so they are exercised here with the boundary
 * modules replaced by recording fakes. The DOM is a minimal stub; the event
 * bus, serial filter, settings resolver, and progress reporter stay real.
 */

const h = vi.hoisted(() => {
  type Listener = (event: { type: string; preventDefault: () => void }) => void;

  class FakeClassList {
    private readonly classes = new Set<string>();

    add(...names: string[]): void {
      for (const name of names) this.classes.add(name);
    }

    remove(...names: string[]): void {
      for (const name of names) this.classes.delete(name);
    }

    toggle(name: string, force?: boolean): boolean {
      const shouldAdd = force === undefined ? !this.classes.has(name) : force;
      if (shouldAdd) this.classes.add(name);
      else this.classes.delete(name);
      return shouldAdd;
    }

    contains(name: string): boolean {
      return this.classes.has(name);
    }
  }

  class FakeElement {
    tagName: string;
    id: string;
    className = '';
    textContent = '';
    children: FakeElement[] = [];
    parent: FakeElement | null = null;
    classList = new FakeClassList();
    dataset: Record<string, string> = {};
    style: Record<string, string> = {};
    scrollTop = 0;
    scrollHeight = 0;
    value = '';
    disabled = false;
    hidden = false;
    private readonly listeners = new Map<string, Set<Listener>>();

    constructor(tagName: string, id = '') {
      this.tagName = tagName;
      this.id = id;
    }

    appendChild(child: FakeElement): FakeElement {
      child.parent = this;
      this.children.push(child);
      return child;
    }

    replaceChildren(...children: FakeElement[]): void {
      for (const child of this.children) child.parent = null;
      this.children = [];
      for (const child of children) this.appendChild(child);
    }

    remove(): void {
      if (!this.parent) return;
      const index = this.parent.children.indexOf(this);
      if (index !== -1) this.parent.children.splice(index, 1);
      this.parent = null;
    }

    addEventListener(type: string, listener: Listener): void {
      let set = this.listeners.get(type);
      if (!set) {
        set = new Set();
        this.listeners.set(type, set);
      }
      set.add(listener);
    }

    removeEventListener(type: string, listener: Listener): void {
      this.listeners.get(type)?.delete(listener);
    }

    dispatchEvent(event: { type: string; preventDefault: () => void }): void {
      for (const listener of this.listeners.get(event.type) ?? []) listener(event);
    }

    click(): void {
      this.dispatchEvent({ type: 'click', preventDefault: () => undefined });
    }

    setAttribute(): void {}

    getAttribute(): string | undefined {
      return undefined;
    }
  }

  const state = {
    engines: [] as FakeEngine[],
    loops: [] as FakeAgentLoop[],
    chats: [] as FakeChat[],
    terminals: [] as FakeTerminal[],
    twinViews: [] as FakeTwinView[],
    fileTrees: [] as FakeFileTree[],
    diffViews: [] as FakeDiffView[],
    artifacts: [] as FakeArtifact[],
    modelProgresses: [] as FakeModelProgress[],
    settings: [] as FakeSettings[],
    dbs: [] as FakeDb[],
    repos: [] as FakeConversationRepo[],
    vms: [] as FakeVM[],
    netDevices: [] as unknown[],
    egressInstalls: [] as Array<{ blockAll: boolean; allowlist: unknown }>,
    egressRestores: 0,
    computeDiffResult: [] as Array<{ path: string; kind: 'added' | 'modified' | 'deleted' }>,
    loadError: null as Error | null,
    agentRunImpl: null as null | ((
      conversation: Conversation,
      ctx: unknown,
      onStep: (step: AgentStep) => void,
      signal: AbortSignal,
    ) => Promise<AgentRunResult>),
  };

  class FakeEngine {
    readonly id = 'fake-engine';
    readonly kind = 'wasm' as const;
    loaded = false;
    loadCalls = 0;
    unloadCalls = 0;
    generateCalls = 0;

    constructor() {
      state.engines.push(this);
    }

    async load(
      _spec: unknown,
      onProgress?: (progress: ModelProgress) => void,
    ): Promise<void> {
      this.loadCalls += 1;
      if (state.loadError) throw state.loadError;
      onProgress?.({ phase: 'loading', loaded: 1, total: 2, percent: 50 });
      this.loaded = true;
    }

    async unload(): Promise<void> {
      this.unloadCalls += 1;
      this.loaded = false;
    }

    isLoaded(): boolean {
      return this.loaded;
    }

    async generate(): Promise<GenerateResult> {
      this.generateCalls += 1;
      return { text: 'Done.', tokens: 1, finishReason: 'stop' };
    }
  }

  class FakeChat {
    onSubmitFn: ((text: string) => void) | null = null;
    messages: Message[] = [];
    working = false;
    annotations: Array<{
      messageId: string;
      ranges: ToolLineRange[];
      onJump: (start: number, end: number) => void;
    }> = [];
    attached = 0;
    disposed = 0;

    onSubmit(fn: (text: string) => void): void {
      this.onSubmitFn = fn;
    }

    submit(text: string): void {
      this.onSubmitFn?.(text);
    }

    attach(): void {
      this.attached += 1;
    }

    append(message: Message): FakeElement {
      this.messages.push(message);
      return new FakeElement('div');
    }

    annotateToolCalls(
      messageId: string,
      ranges: ToolLineRange[],
      onJump: (start: number, end: number) => void,
    ): void {
      this.annotations.push({ messageId, ranges, onJump });
    }

    setWorking(working: boolean): void {
      this.working = working;
    }

    scrollToBottom(): void {}

    dispose(): void {
      this.disposed += 1;
    }
  }

  class FakeTerminal {
    written: string[] = [];
    fits = 0;
    disposed = 0;

    write(data: string): void {
      this.written.push(data);
    }

    writeln(data: string): void {
      this.written.push(`${data}\n`);
    }

    clear(): void {}

    focus(): void {}

    fit(): void {
      this.fits += 1;
    }

    scrollToLine(): void {}

    scrollToText(): boolean {
      return true;
    }

    lineCount(): number {
      return 0;
    }

    lineAt(): string | undefined {
      return undefined;
    }

    dispose(): void {
      this.disposed += 1;
    }
  }

  class FakeTwinView {
    ranges: LineRange[] = [];
    beginCalls: number[] = [];
    endCalls: number[] = [];
    scrolls: number[] = [];
    attached = 0;
    detached = 0;

    attach(): void {
      this.attached += 1;
    }

    detach(): void {
      this.detached += 1;
    }

    beginTool(): number {
      const line = this.ranges.length;
      this.beginCalls.push(line);
      return line;
    }

    endTool(start: number): LineRange {
      const range = { start, end: start + 1 };
      this.ranges.push(range);
      this.endCalls.push(start);
      return range;
    }

    takeRanges(): LineRange[] {
      const out = this.ranges;
      this.ranges = [];
      return out;
    }

    lineCount(): number {
      return this.ranges.length;
    }

    lineAt(): string | undefined {
      return undefined;
    }

    scrollTerminalToLine(line: number): void {
      this.scrolls.push(line);
    }
  }

  class FakeFileTree {
    vm: VMHandle | null = null;
    refreshes = 0;
    attached = 0;
    detached = 0;
    disposed = 0;

    setVM(vm: VMHandle | null): void {
      this.vm = vm;
    }

    attach(): void {
      this.attached += 1;
    }

    detach(): void {
      this.detached += 1;
    }

    navigate(): Promise<void> {
      return Promise.resolve();
    }

    refresh(): Promise<void> {
      this.refreshes += 1;
      return Promise.resolve();
    }

    setLoading(): void {}

    dispose(): void {
      this.disposed += 1;
    }
  }

  class FakeDiffView {
    shown: Array<{ message: string; entries: Array<Record<string, unknown>> }> = [];
    cleared = 0;
    disposed = 0;

    show(message: string, entries: Array<Record<string, unknown>>): void {
      this.shown.push({ message, entries });
    }

    clear(): void {
      this.cleared += 1;
    }

    dispose(): void {
      this.disposed += 1;
    }
  }

  class FakeArtifact {
    shown: Array<{ kind: 'html' | 'text'; content: string }> = [];
    disposed = 0;

    show(artifact: { kind: 'html' | 'text'; content: string }): void {
      this.shown.push(artifact);
    }

    hide(): void {}

    dispose(): void {
      this.disposed += 1;
    }
  }

  class FakeModelProgress {
    shown: Array<ModelProgress | undefined> = [];
    updates: ModelProgress[] = [];
    hidden = 0;
    cancelFn: (() => void) | null = null;
    disposed = 0;

    show(progress?: ModelProgress): void {
      this.shown.push(progress);
    }

    update(progress: ModelProgress): void {
      this.updates.push(progress);
    }

    hide(): void {
      this.hidden += 1;
    }

    onCancel(fn: () => void): void {
      this.cancelFn = fn;
    }

    dispose(): void {
      this.disposed += 1;
    }
  }

  class FakeSettings {
    current: AgentConfig;
    listeners: Array<(config: AgentConfig) => void> = [];
    disposed = 0;

    constructor(config: AgentConfig) {
      this.current = config;
    }

    get(): AgentConfig {
      return this.current;
    }

    onChange(fn: (config: AgentConfig) => void): void {
      this.listeners.push(fn);
    }

    emit(config: AgentConfig): void {
      this.current = config;
      for (const listener of this.listeners) listener(config);
    }

    dispose(): void {
      this.disposed += 1;
    }
  }

  class FakeDb {
    opened = 0;
    closed = 0;
    settings = new Map<string, unknown>();
    conversations: Conversation[] = [];

    constructor() {
      state.dbs.push(this);
    }

    async open(): Promise<void> {
      this.opened += 1;
    }

    async close(): Promise<void> {
      this.closed += 1;
    }

    async putConversation(conversation: Conversation): Promise<void> {
      this.conversations.push(conversation);
    }

    async getConversation(id: string): Promise<Conversation | undefined> {
      return this.conversations.find((c) => c.id === id);
    }

    async listConversations(): Promise<Conversation[]> {
      return [...this.conversations];
    }

    async deleteConversation(id: string): Promise<void> {
      this.conversations = this.conversations.filter((c) => c.id !== id);
    }

    async setSetting(key: string, value: unknown): Promise<void> {
      this.settings.set(key, value);
    }

    async getSetting<T>(key: string): Promise<T | undefined> {
      return this.settings.get(key) as T | undefined;
    }
  }

  class FakeConversationRepo {
    created: Array<{ title: string; modelId: string }> = [];

    constructor(_db: unknown) {
      state.repos.push(this);
    }

    async create(title: string, modelId: string): Promise<Conversation> {
      this.created.push({ title, modelId });
      return { id: 'c1', title, messages: [], createdAt: 1, updatedAt: 1, modelId };
    }
  }

  class FakeSnapshotManager {
    constructor(_db: unknown) {}
  }

  class FakeVM {
    running = false;
    started: VMImage[] = [];
    stopped = 0;
    netDevices: unknown[] = [];
    serialHandlers: Array<(data: string) => void> = [];
    startImpl: () => Promise<void> = async () => {
      this.running = true;
    };

    listImpl: () => Array<{ name: string; kind: 'file' | 'dir' | 'symlink'; size: number; mtime: number }> = () => [];
    readImpl: () => string = () => '';

    constructor() {
      state.vms.push(this);
    }

    async start(image: VMImage): Promise<void> {
      this.started.push(image);
      await this.startImpl();
    }

    async stop(): Promise<void> {
      this.running = false;
      this.stopped += 1;
    }

    async pause(): Promise<void> {}

    async resume(): Promise<void> {}

    setNetDevice(device: unknown): void {
      this.netDevices.push(device);
    }

    onSerial(fn: (data: string) => void): void {
      this.serialHandlers.push(fn);
    }

    emitSerial(data: string): void {
      for (const fn of this.serialHandlers) fn(data);
    }

    async exec(): Promise<{
      stdout: string;
      stderr: string;
      exitCode: number;
      durationMs: number;
      timedOut: boolean;
    }> {
      return { stdout: '', stderr: '', exitCode: 0, durationMs: 1, timedOut: false };
    }

    sendSerial(): void {}

    async write(): Promise<void> {}

    async read(): Promise<string> {
      return this.readImpl();
    }

    async list(): Promise<Array<{ name: string; kind: 'file' | 'dir' | 'symlink'; size: number; mtime: number }>> {
      return this.listImpl();
    }
  }

  class FakeAgentLoop {
    calls: Array<{ conversation: Conversation; signal: AbortSignal }> = [];

    constructor(
      readonly tools: Map<string, ToolDefinition>,
      readonly config: AgentConfig,
    ) {
      state.loops.push(this);
    }

    async run(
      conversation: Conversation,
      _ctx: unknown,
      onStep: (step: AgentStep) => void,
      signal: AbortSignal,
    ): Promise<AgentRunResult> {
      this.calls.push({ conversation, signal });
      const impl = state.agentRunImpl ?? (async (c: Conversation) => ({
        messages: [...c.messages],
        steps: [],
        iterations: 0,
        finishReason: 'stop' as const,
      }));
      return impl(conversation, _ctx, onStep, signal);
    }
  }

  const createChat = vi.fn(() => {
    const chat = new FakeChat();
    state.chats.push(chat);
    return chat;
  });

  const createTerminal = vi.fn(() => {
    const terminal = new FakeTerminal();
    state.terminals.push(terminal);
    return terminal;
  });

  const createTwinView = vi.fn(() => {
    const twin = new FakeTwinView();
    state.twinViews.push(twin);
    return twin;
  });

  const createFileTree = vi.fn(() => {
    const tree = new FakeFileTree();
    state.fileTrees.push(tree);
    return tree;
  });

  const createDiffView = vi.fn(() => {
    const view = new FakeDiffView();
    state.diffViews.push(view);
    return view;
  });

  const createArtifactPanel = vi.fn(() => {
    const artifact = new FakeArtifact();
    state.artifacts.push(artifact);
    return artifact;
  });

  const createModelProgress = vi.fn(() => {
    const progress = new FakeModelProgress();
    state.modelProgresses.push(progress);
    return progress;
  });

  const createSettings = vi.fn((options: { config: AgentConfig }) => {
    const settings = new FakeSettings(options.config);
    state.settings.push(settings);
    return settings;
  });

  const createPrivacyReportSection = vi.fn(() => new FakeElement('div'));

  const createEngine = vi.fn(() => new FakeEngine());

  const builtinTools = vi.fn((): ToolDefinition[] => [
    {
      name: 'bash',
      description: 'run a command',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ ok: true, content: 'ok' }),
    },
    {
      name: 'read_file',
      description: 'read a file',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ ok: true, content: 'file' }),
    },
  ]);

  const createToolRegistry = vi.fn((defs: ToolDefinition[]) => new Map(defs.map((d) => [d.name, d])));

  const buildNetDevice = vi.fn((config: { mode: string }) => {
    state.netDevices.push(config);
    return {};
  });

  const getImage = vi.fn(() => ({
    id: 'alpine-3.21-i386',
    name: 'Alpine 3.21',
    arch: 'ia32' as const,
    sizeBytes: 1,
    prebaked: [],
  }));

  const installEgressInterceptor = vi.fn((_log: unknown, blockAll: boolean, allowlist: unknown) => {
    state.egressInstalls.push({ blockAll, allowlist });
    return () => {
      state.egressRestores += 1;
    };
  });

  const computeDiff = vi.fn(
    (
      _before: Map<string, string>,
      _after: Map<string, string>,
    ): Array<{ path: string; kind: 'added' | 'modified' | 'deleted' }> => state.computeDiffResult,
  );

  const reset = (): void => {
    state.engines.length = 0;
    state.loops.length = 0;
    state.chats.length = 0;
    state.terminals.length = 0;
    state.twinViews.length = 0;
    state.fileTrees.length = 0;
    state.diffViews.length = 0;
    state.artifacts.length = 0;
    state.modelProgresses.length = 0;
    state.settings.length = 0;
    state.dbs.length = 0;
    state.repos.length = 0;
    state.vms.length = 0;
    state.netDevices.length = 0;
    state.egressInstalls.length = 0;
    state.egressRestores = 0;
    state.computeDiffResult = [];
    state.loadError = null;
    state.agentRunImpl = null;
  };

  return {
    state,
    reset,
    FakeElement,
    FakeClassList,
    IdbDatabase: FakeDb,
    ConversationRepository: FakeConversationRepo,
    SnapshotManager: FakeSnapshotManager,
    V86VMHandle: FakeVM,
    createV86Filesystem: vi.fn(() => ({})),
    DEFAULT_FS_PREFIX: 'fs9p',
    buildNetDevice,
    ALPINE_BOOT: { biosUrl: 'bios.bin', vgaBiosUrl: 'vga.bin', cmdline: 'console=ttyS0' },
    getImage,
    V86_WASM_URL: 'data:application/wasm;base64,AAAA',
    createToolRegistry,
    AgentLoop: FakeAgentLoop,
    builtinTools,
    createEngine,
    installEgressInterceptor,
    InMemoryEgressLog: class {
      record(): void {}
      list(): never[] {
        return [];
      }
      clear(): void {}
    },
    createChat,
    createTerminal,
    createTwinView,
    createFileTree,
    createDiffView,
    createArtifactPanel,
    createModelProgress,
    createSettings,
    createPrivacyReportSection,
    computeDiff,
  };
});

type FakeElement = InstanceType<typeof h.FakeElement>;

vi.mock('@/core/persistence/db.js', () => ({ IdbDatabase: h.IdbDatabase }));
vi.mock('@/core/persistence/conversations.js', () => ({
  ConversationRepository: h.ConversationRepository,
}));
vi.mock('@/core/persistence/snapshots.js', () => ({ SnapshotManager: h.SnapshotManager }));
vi.mock('@/core/vm/v86.js', () => ({ V86VMHandle: h.V86VMHandle }));
vi.mock('@/core/vm/fs9p.js', () => ({
  createV86Filesystem: h.createV86Filesystem,
  DEFAULT_FS_PREFIX: h.DEFAULT_FS_PREFIX,
}));
vi.mock('@/core/vm/network.js', () => ({ buildNetDevice: h.buildNetDevice }));
vi.mock('@/core/vm/image.js', () => ({ ALPINE_BOOT: h.ALPINE_BOOT, getImage: h.getImage }));
vi.mock('@/core/vm/wasm.js', () => ({ V86_WASM_URL: h.V86_WASM_URL }));
vi.mock('@/core/agent/loop.js', () => ({
  createToolRegistry: h.createToolRegistry,
  AgentLoop: h.AgentLoop,
}));
vi.mock('@/core/agent/tools.js', () => ({ builtinTools: h.builtinTools }));
vi.mock('@/core/llm/engine.js', () => ({ createEngine: h.createEngine }));
vi.mock('@/core/security/egress.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/security/egress.js')>();
  return {
    ...actual,
    installEgressInterceptor: h.installEgressInterceptor,
    InMemoryEgressLog: h.InMemoryEgressLog,
  };
});
vi.mock('@/ui/chat.js', () => ({ createChat: h.createChat }));
vi.mock('@/ui/terminal.js', () => ({ createTerminal: h.createTerminal }));
vi.mock('@/ui/twinview.js', () => ({ createTwinView: h.createTwinView }));
vi.mock('@/ui/filetree.js', () => ({ createFileTree: h.createFileTree }));
vi.mock('@/ui/diff.js', () => ({ computeDiff: h.computeDiff, createDiffView: h.createDiffView }));
vi.mock('@/ui/artifact.js', () => ({ createArtifactPanel: h.createArtifactPanel }));
vi.mock('@/ui/progress.js', () => ({ createModelProgress: h.createModelProgress }));
vi.mock('@/ui/settings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/ui/settings.js')>();
  return {
    ...actual,
    createSettings: h.createSettings,
    createPrivacyReportSection: h.createPrivacyReportSection,
  };
});

const PANEL_IDS = [
  'gs-chat',
  'gs-terminal',
  'gs-filetree',
  'gs-diff',
  'gs-artifact',
  'gs-model-progress',
  'gs-privacy-report',
  'gs-start',
  'gs-vm',
  'gs-egress',
  'gs-model',
] as const;

type DocEnv = {
  byId: Map<string, FakeElement>;
  welcome: FakeElement;
  tabs: FakeElement[];
  panels: FakeElement[];
  doc: {
    getElementById: (id: string) => FakeElement | null;
    querySelectorAll: (selector: string) => FakeElement[];
    querySelector: (selector: string) => FakeElement | null;
    createElement: (tagName: string) => FakeElement;
  };
};

function makeDocument(): DocEnv {
  const byId = new Map<string, FakeElement>();
  for (const id of PANEL_IDS) byId.set(id, new h.FakeElement('div', id));

  const welcome = new h.FakeElement('div');
  welcome.className = 'gs-welcome';

  const names = ['terminal', 'files', 'chat'];
  const tabs = names.map((name) => {
    const tab = new h.FakeElement('button');
    tab.className = 'gs-tab';
    tab.dataset['tab'] = name;
    return tab;
  });
  const panels = names.map((name) => {
    const panel = new h.FakeElement('div');
    panel.className = 'gs-tab-panel';
    panel.id = `gs-panel-${name}`;
    return panel;
  });

  return {
    byId,
    welcome,
    tabs,
    panels,
    doc: {
      getElementById: (id: string) => byId.get(id) ?? null,
      querySelectorAll: (selector: string) =>
        selector === '.gs-tab' ? tabs : selector === '.gs-tab-panel' ? panels : [],
      querySelector: (selector: string) => (selector === '.gs-welcome' ? welcome : null),
      createElement: (tagName: string) => new h.FakeElement(tagName),
    },
  };
}

describe('App', () => {
  let app: App;
  let env: DocEnv;

  beforeEach(() => {
    h.reset();
    vi.clearAllMocks();
    env = makeDocument();
    vi.stubGlobal('document', env.doc);
    app = new App();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('init', () => {
    it('opens the db, installs lockdown egress, and mounts every panel', async () => {
      await app.init();

      const db = h.state.dbs[0]!;
      const chat = h.state.chats[0]!;
      expect(db.opened).toBe(1);
      expect(h.state.egressInstalls[0]!.blockAll).toBe(true);
      expect(chat.attached).toBe(1);
      expect(h.state.terminals).toHaveLength(1);
      expect(h.state.twinViews[0]!.attached).toBe(1);
      expect(h.state.fileTrees[0]!.attached).toBe(1);
      expect(h.state.diffViews).toHaveLength(1);
      expect(h.state.artifacts).toHaveLength(1);
      expect(h.state.modelProgresses).toHaveLength(1);
      expect(h.state.settings).toHaveLength(1);
      expect(h.state.netDevices.at(-1)).toEqual({ mode: 'off' });
      expect(env.byId.get('gs-model')!.textContent).toBe('🧠 unloaded');

      app.dispose();
      expect(h.state.egressRestores).toBe(1);
      expect(chat.disposed).toBe(1);
      expect(h.state.terminals[0]!.disposed).toBe(1);
      expect(h.state.twinViews[0]!.detached).toBe(1);
      expect(h.state.fileTrees[0]!.disposed).toBe(1);
      expect(h.state.diffViews[0]!.disposed).toBe(1);
      expect(h.state.artifacts[0]!.disposed).toBe(1);
      expect(h.state.settings[0]!.disposed).toBe(1);
      expect(h.state.modelProgresses[0]!.disposed).toBe(1);
      expect(db.closed).toBe(1);
    });

    it('is safe to dispose before init', () => {
      expect(() => app.dispose()).not.toThrow();
      expect(h.state.dbs[0]!.closed).toBe(1);
    });

    it('applies persisted settings before the first boot', async () => {
      await h.state.dbs[0]!.setSetting(SETTINGS_KEY, { networkMode: 'fetch' });
      await app.init();
      expect(h.state.netDevices.at(-1)).toEqual({ mode: 'fetch' });
      expect(h.state.egressInstalls[0]!.blockAll).toBe(false);
      expect(env.byId.get('gs-egress')!.textContent).toBe('🌐 online (logged)');
    });

    it('mounts the privacy report section when the flag is on', async () => {
      await app.init();
      expect(env.byId.get('gs-privacy-report')!.children).toHaveLength(1);
    });

    it('works without the privacy report mount', async () => {
      env.byId.delete('gs-privacy-report');
      await expect(app.init()).resolves.toBeUndefined();
    });

    it('works without the model progress mount', async () => {
      env.byId.delete('gs-model-progress');
      await app.init();
      expect(h.state.modelProgresses).toHaveLength(0);
      h.state.vms[0]!.running = true;
      const chat = h.state.chats[0]!;
      chat.submit('hello');
      await vi.waitFor(() => expect(chat.working).toBe(false));
    });

    it('filters VM serial output onto the bus', async () => {
      await app.init();
      const received: string[] = [];
      app.bus.on('vm:serial', (data) => received.push(data));
      h.state.vms[0]!.emitSerial('hello\n');
      expect(received).toEqual(['hello\n']);
    });
  });

  describe('start', () => {
    it('boots the VM and updates the UI', async () => {
      await app.init();
      const vm = h.state.vms[0]!;
      const ready: unknown[] = [];
      app.bus.on('vm:ready', () => ready.push(undefined));

      env.byId.get('gs-start')!.click();
      await vi.waitFor(() => expect(env.welcome.classList.contains('is-hidden')).toBe(true));

      expect(vm.running).toBe(true);
      expect(env.welcome.classList.contains('is-hidden')).toBe(true);
      const startBtn = env.byId.get('gs-start')!;
      expect(startBtn.disabled).toBe(true);
      expect(startBtn.textContent).toBe('Running…');
      expect(env.byId.get('gs-vm')!.textContent).toBe('🖥️ running');
      expect(h.state.fileTrees[0]!.vm).not.toBeNull();
      expect(ready).toHaveLength(1);
    });

    it('does nothing when the VM is already running', async () => {
      await app.init();
      const vm = h.state.vms[0]!;
      vm.running = true;
      env.byId.get('gs-start')!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(vm.started).toHaveLength(0);
    });

    it('surfaces boot failures in the welcome panel', async () => {
      await app.init();
      const vm = h.state.vms[0]!;
      vm.startImpl = () => Promise.reject(new Error('missing image'));

      env.byId.get('gs-start')!.click();
      await vi.waitFor(() => expect(env.welcome.children).toHaveLength(1));

      const hint = env.welcome.children[0]!;
      expect(hint.className).toBe('gs-hint');
      expect(hint.textContent).toBe('Boot failed: missing image');
      expect(env.byId.get('gs-vm')!.textContent).toBe('🖥️ stopped');
    });
  });

  describe('chat submit', () => {
    it('asks the user to start the VM when it is not running', async () => {
      await app.init();
      const chat = h.state.chats[0]!;
      chat.submit('hello');
      await vi.waitFor(() => expect(chat.messages).toHaveLength(1));
      expect(chat.messages[0]).toMatchObject({
        role: 'assistant',
        content: 'Click "Start GhostShell" to boot the VM first.',
      });
    });

    it('runs the loop, streams steps, and persists the conversation', async () => {
      await app.init();
      h.state.vms[0]!.running = true;
      const chat = h.state.chats[0]!;
      const twin = h.state.twinViews[0]!;
      const fileTree = h.state.fileTrees[0]!;
      const diff = h.state.diffViews[0]!;
      const artifact = h.state.artifacts[0]!;
      const progress = h.state.modelProgresses[0]!;
      const db = h.state.dbs[0]!;

      twin.ranges.push({ start: 0, end: 2 });
      const toolCall = { id: 't1', name: 'bash', arguments: { command: 'ls' }, raw: '{"name":"bash"}' };
      const stepMessage: Message = {
        id: 'm-step',
        role: 'assistant',
        content: '',
        toolCalls: [toolCall],
        timestamp: 1,
      };
      const step: AgentStep = {
        iteration: 1,
        message: stepMessage,
        toolCalls: [toolCall],
        results: [
          {
            ok: true,
            content: 'ok',
            artifacts: [
              { id: 'a1', kind: 'markdown', content: '# hi', mime: 'text/markdown', createdAt: 1 },
            ],
          },
        ],
      };
      h.state.agentRunImpl = async (conversation, _ctx, onStep) => {
        onStep(step);
        return {
          messages: [...conversation.messages, stepMessage],
          steps: [step],
          iterations: 1,
          finishReason: 'stop',
        };
      };

      chat.submit('hello');
      await vi.waitFor(() => expect(chat.working).toBe(false));
      await vi.waitFor(() => expect(db.conversations).toHaveLength(2));

      expect(chat.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
      expect(chat.messages[0]).toMatchObject({ role: 'user', content: 'hello' });
      expect(chat.working).toBe(false);
      expect(progress.hidden).toBeGreaterThan(0);
      expect(progress.updates.length).toBeGreaterThan(0);

      expect(chat.annotations).toHaveLength(1);
      expect(chat.annotations[0]).toMatchObject({
        messageId: 'm-step',
        ranges: [{ start: 0, end: 2, callId: 't1' }],
      });

      expect(artifact.shown).toEqual([{ kind: 'text', content: '# hi' }]);

      const loop = h.state.loops[0]!;
      const bash = loop.tools.get('bash')!;
      twin.beginCalls.length = 0;
      twin.endCalls.length = 0;
      await bash.execute({} as never, {});
      expect(twin.beginCalls).toHaveLength(1);
      expect(twin.endCalls).toHaveLength(1);

      expect(db.conversations[0]!.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
      expect(diff.shown).toHaveLength(1);
      expect(fileTree.refreshes).toBeGreaterThan(0);
    });

    it('reuses a loaded engine for a second submit', async () => {
      await app.init();
      h.state.vms[0]!.running = true;
      const chat = h.state.chats[0]!;
      chat.submit('one');
      await vi.waitFor(() => expect(chat.working).toBe(false));
      chat.submit('two');
      await vi.waitFor(() => expect(chat.working).toBe(false));
      expect(h.state.engines).toHaveLength(1);
      expect(h.state.engines[0]!.loadCalls).toBe(1);
    });

    it('reports a generic loop failure', async () => {
      await app.init();
      h.state.vms[0]!.running = true;
      h.state.agentRunImpl = () => Promise.reject(new Error('boom'));
      const chat = h.state.chats[0]!;
      chat.submit('hello');
      await vi.waitFor(() =>
        expect(chat.messages.some((m) => m.content.includes('Something went wrong: boom'))).toBe(true),
      );
      expect(chat.working).toBe(false);
    });

    it('reports an abort as Canceled', async () => {
      await app.init();
      h.state.vms[0]!.running = true;
      h.state.agentRunImpl = () => Promise.reject({ name: 'AbortError' });
      const chat = h.state.chats[0]!;
      chat.submit('hello');
      await vi.waitFor(() =>
        expect(chat.messages.some((m) => m.content === 'Canceled.')).toBe(true),
      );
    });

    it('surfaces engine load failures', async () => {
      await app.init();
      h.state.vms[0]!.running = true;
      h.state.loadError = new Error('load failed');
      const chat = h.state.chats[0]!;
      chat.submit('hello');
      await vi.waitFor(() =>
        expect(chat.messages.some((m) => m.content.includes('Something went wrong: load failed'))).toBe(true),
      );
      expect(env.byId.get('gs-model')!.textContent).toBe('🧠 unloaded');
    });

    it('cancel aborts an in-flight run and reports Canceled', async () => {
      await app.init();
      h.state.vms[0]!.running = true;
      let rejectRun: ((err: unknown) => void) | null = null;
      let runStarted = false;
      h.state.agentRunImpl = () =>
        new Promise((_resolve, reject) => {
          runStarted = true;
          rejectRun = reject;
        });
      const chat = h.state.chats[0]!;
      const progress = h.state.modelProgresses[0]!;

      chat.submit('hello');
      await vi.waitFor(() => expect(chat.working).toBe(true));
      await vi.waitFor(() => expect(runStarted).toBe(true));
      progress.cancelFn!();
      rejectRun!({ name: 'AbortError' });

      await vi.waitFor(() =>
        expect(chat.messages.some((m) => m.content === 'Canceled.')).toBe(true),
      );
      expect(chat.working).toBe(false);
    });

    it('jump links scroll the terminal to the tool range', async () => {
      await app.init();
      h.state.vms[0]!.running = true;
      const chat = h.state.chats[0]!;
      const twin = h.state.twinViews[0]!;
      twin.ranges.push({ start: 0, end: 2 });
      const toolCall = { id: 't1', name: 'bash', arguments: {}, raw: '' };
      const stepMessage: Message = { id: 'm-step', role: 'assistant', content: '', timestamp: 1 };
      h.state.agentRunImpl = async (conversation, _ctx, onStep) => {
        onStep({ iteration: 1, message: stepMessage, toolCalls: [toolCall], results: [] });
        return { messages: [...conversation.messages], steps: [], iterations: 1, finishReason: 'stop' };
      };

      chat.submit('hello');
      await vi.waitFor(() => expect(chat.annotations).toHaveLength(1));
      chat.annotations[0]!.onJump(0, 2);

      expect(twin.scrolls).toContain(0);
      expect(h.state.terminals[0]!.fits).toBeGreaterThan(0);
      expect(env.panels.find((p) => p.id === 'gs-panel-terminal')!.classList.contains('is-active')).toBe(true);
    });

    it('enriches diff entries with before/after content and reports no changes', async () => {
      await app.init();
      const vm = h.state.vms[0]!;
      vm.running = true;
      vm.listImpl = () => [{ name: 'a.txt', kind: 'file', size: 1, mtime: 1 }];
      vm.readImpl = () => 'before';
      h.state.computeDiffResult = [{ path: '/root/workspace/a.txt', kind: 'modified' }];
      const chat = h.state.chats[0]!;
      const diff = h.state.diffViews[0]!;

      chat.submit('edit');
      await vi.waitFor(() => expect(diff.shown).toHaveLength(1));
      expect(diff.shown[0]!.message).toBe('Agent changes');
      expect(diff.shown[0]!.entries[0]).toMatchObject({
        path: '/root/workspace/a.txt',
        kind: 'modified',
        before: 'before',
        after: 'before',
      });

      h.state.computeDiffResult = [];
      chat.submit('again');
      await vi.waitFor(() => expect(diff.shown).toHaveLength(2));
      expect(diff.shown[1]!.message).toBe('No changes.');
    });

    it('skips unreadable directories and binary files while snapshotting', async () => {
      await app.init();
      const vm = h.state.vms[0]!;
      vm.running = true;
      vm.listImpl = () => {
        throw new Error('EIO');
      };
      h.state.computeDiffResult = [];
      const chat = h.state.chats[0]!;
      const diff = h.state.diffViews[0]!;

      chat.submit('go');
      await vi.waitFor(() => expect(diff.shown).toHaveLength(1));
      expect(diff.shown[0]!.message).toBe('No changes.');
    });

    it('skips binary file contents while snapshotting', async () => {
      await app.init();
      const vm = h.state.vms[0]!;
      vm.running = true;
      vm.listImpl = () => [{ name: 'blob.bin', kind: 'file', size: 3, mtime: 1 }];
      vm.readImpl = () => 'a\0b';
      h.state.computeDiffResult = [];
      const chat = h.state.chats[0]!;
      const diff = h.state.diffViews[0]!;

      chat.submit('go');
      await vi.waitFor(() => expect(diff.shown).toHaveLength(1));
      expect(diff.shown[0]!.message).toBe('No changes.');
    });
  });

  describe('settings changes', () => {
    it('rebuilds the network device and reinstalls egress', async () => {
      await app.init();
      const settings = h.state.settings[0]!;
      settings.emit({ ...settings.get(), networkMode: 'fetch' });

      expect(h.state.netDevices.at(-1)).toEqual({ mode: 'fetch' });
      expect(h.state.egressRestores).toBe(1);
      expect(h.state.egressInstalls).toHaveLength(2);
      expect(h.state.egressInstalls[1]!.blockAll).toBe(false);
      expect(env.byId.get('gs-egress')!.textContent).toBe('🌐 online (logged)');
    });

    it('unloads the loaded engine when the model changes', async () => {
      await app.init();
      h.state.vms[0]!.running = true;
      const chat = h.state.chats[0]!;
      chat.submit('hello');
      await vi.waitFor(() => expect(h.state.engines[0]!.isLoaded()).toBe(true));
      expect(env.byId.get('gs-model')!.textContent).toBe('🧠 loaded');

      const settings = h.state.settings[0]!;
      settings.emit({ ...settings.get(), modelId: 'qwen2.5-3b' });
      expect(h.state.engines[0]!.unloadCalls).toBe(1);
      expect(env.byId.get('gs-model')!.textContent).toBe('🧠 unloaded');
    });

    it('keeps the loaded engine when the model is unchanged', async () => {
      await app.init();
      h.state.vms[0]!.running = true;
      const chat = h.state.chats[0]!;
      chat.submit('hello');
      await vi.waitFor(() => expect(h.state.engines[0]!.isLoaded()).toBe(true));

      const settings = h.state.settings[0]!;
      settings.emit({ ...settings.get(), modelId: settings.get().modelId });
      expect(h.state.engines[0]!.unloadCalls).toBe(0);
    });
  });

  describe('tabs', () => {
    it('activates panels and refreshes the file tree', async () => {
      await app.init();
      const filesTab = env.tabs.find((t) => t.dataset['tab'] === 'files')!;
      filesTab.click();
      expect(env.panels.find((p) => p.id === 'gs-panel-files')!.classList.contains('is-active')).toBe(true);
      expect(h.state.fileTrees[0]!.refreshes).toBe(1);

      const terminalTab = env.tabs.find((t) => t.dataset['tab'] === 'terminal')!;
      terminalTab.click();
      expect(h.state.terminals[0]!.fits).toBeGreaterThan(0);
    });
  });

  describe('FilteringVMHandle', () => {
    it('marks commands and resets the filter on stop', async () => {
      await app.init();
      const filtered = (app as unknown as { filteredVM: VMHandle }).filteredVM;
      const serialFilter = (
        app as unknown as {
          serialFilter: { beginCommand: (command: string) => void; endCommand: () => void; reset: () => void };
        }
      ).serialFilter;
      const begin = vi.spyOn(serialFilter, 'beginCommand');
      const end = vi.spyOn(serialFilter, 'endCommand');
      const reset = vi.spyOn(serialFilter, 'reset');

      await filtered.exec('ls -la');
      expect(begin).toHaveBeenCalledWith('ls -la');
      expect(end).toHaveBeenCalled();

      begin.mockClear();
      end.mockClear();
      await filtered.list('/root');
      expect(begin).toHaveBeenCalledWith('list /root');
      expect(end).toHaveBeenCalled();

      await filtered.stop();
      expect(reset).toHaveBeenCalled();
    });
  });
});
