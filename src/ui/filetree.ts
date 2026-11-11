import type { DirEntry, VMHandle } from '@/types/index.js';

/**
 * File tree panel. Renders the VM filesystem lazily: directories are listed on
 * expand, files are read on select. Selection is keyboard- and click-driven.
 *
 * The panel is inert until `setVM` is called with a running VM; the app calls
 * `refresh()` after every agent step so the tree reflects the latest changes.
 */

export interface FileTreeHandle {
  /** Bind (or unbind) the VM. Refreshes automatically when a running VM is set. */
  setVM(vm: VMHandle | null): void;
  /** Attach keyboard listeners. Safe to call more than once. */
  attach(): void;
  detach(): void;
  /** Navigate to an absolute directory path. */
  navigate(path: string): Promise<void>;
  /** Reload the current directory. */
  refresh(): Promise<void>;
  setLoading(loading: boolean): void;
  dispose(): void;
}

export interface FileTreeOptions {
  /** Directory shown on first load. */
  root?: string;
}

interface VisibleEntry {
  entry: DirEntry;
  path: string;
  depth: number;
}

export function createFileTree(container: HTMLElement, options: FileTreeOptions = {}): FileTreeHandle {
  const root = options.root ?? '/root/workspace';

  container.replaceChildren();
  const tree = document.createElement('div');
  tree.className = 'gs-filetree-inner';
  const pathEl = document.createElement('div');
  pathEl.className = 'gs-filetree-path';
  const list = document.createElement('ul');
  list.className = 'gs-filetree-list';
  const preview = document.createElement('div');
  preview.className = 'gs-filetree-preview';
  preview.hidden = true;
  const status = document.createElement('div');
  status.className = 'gs-filetree-status';
  tree.append(pathEl, list, preview, status);
  container.appendChild(tree);

  let vm: VMHandle | null = null;
  let currentPath = root;
  let entries: DirEntry[] = [];
  let children = new Map<string, DirEntry[]>();
  let expanded = new Set<string>();
  let selected: string | null = null;
  let previewPath: string | null = null;
  let previewContent = '';
  let loading = false;
  let attached = false;
  let itemCleanups: Array<() => void> = [];

  const joinPath = (base: string, name: string): string =>
    base === '/' ? `/${name}` : `${base}/${name}`;

  function visibleEntries(): VisibleEntry[] {
    const out: VisibleEntry[] = [];
    const walk = (list: DirEntry[], basePath: string, depth: number): void => {
      for (const entry of list) {
        const path = joinPath(basePath, entry.name);
        out.push({ entry, path, depth });
        if (entry.kind === 'dir' && expanded.has(path)) {
          walk(children.get(path) ?? [], path, depth + 1);
        }
      }
    };
    walk(entries, currentPath, 0);
    return out;
  }

  function renderPreview(): void {
    preview.hidden = previewPath === null;
    preview.replaceChildren();
    if (previewPath === null) return;
    const header = document.createElement('div');
    header.className = 'gs-filetree-preview-path';
    header.textContent = previewPath;
    const pre = document.createElement('pre');
    pre.className = 'gs-filetree-preview-content';
    pre.textContent = previewContent.includes(String.fromCharCode(0)) ? '(binary file)' : previewContent;
    preview.append(header, pre);
  }

  function render(): void {
    pathEl.textContent = currentPath;

    for (const cleanup of itemCleanups) cleanup();
    itemCleanups = [];
    list.replaceChildren();

    const visible = visibleEntries();
    for (const { entry, path, depth } of visible) {
      const li = document.createElement('li');
      li.className = `gs-filetree-item gs-filetree-item--${entry.kind}`;
      li.dataset.path = path;
      li.dataset.depth = String(depth);
      li.style.setProperty('--gs-depth', String(depth));
      if (selected === path) li.classList.add('gs-filetree-item--selected');

      const icon = document.createElement('span');
      icon.className = 'gs-filetree-icon';
      icon.textContent = entry.kind === 'dir' ? '📁' : entry.kind === 'symlink' ? '🔗' : '📄';
      const name = document.createElement('span');
      name.className = 'gs-filetree-name';
      name.textContent = entry.name;
      const size = document.createElement('span');
      size.className = 'gs-filetree-size';
      size.textContent = entry.kind === 'file' ? formatSize(entry.size) : '';
      li.append(icon, name, size);

      const listener = (): void => selectPath(path, entry.kind);
      li.addEventListener('click', listener);
      itemCleanups.push(() => li.removeEventListener('click', listener));

      list.appendChild(li);
    }

    if (loading) {
      status.textContent = 'Loading…';
    } else if (entries.length === 0) {
      status.textContent = vm ? 'Empty directory.' : 'No VM running.';
    } else {
      status.textContent = '';
    }

    renderPreview();
  }

  function selectPath(path: string, kind: DirEntry['kind']): void {
    selected = path;
    if (kind === 'dir') {
      void toggleDir(path);
    } else {
      void previewFile(path);
    }
    render();
  }

  async function toggleDir(path: string): Promise<void> {
    if (expanded.has(path)) {
      expanded.delete(path);
      children.delete(path);
      render();
      return;
    }
    expanded.add(path);
    render();
    if (!vm || children.has(path)) return;
    try {
      const kids = await vm.list(path);
      children.set(path, kids);
    } catch (err) {
      children.set(path, []);
      status.textContent = `Could not list ${path}: ${errorMessage(err)}`;
    }
    render();
  }

  async function previewFile(path: string): Promise<void> {
    previewPath = path;
    previewContent = '';
    renderPreview();
    if (!vm) return;
    try {
      previewContent = await vm.read(path);
    } catch (err) {
      previewContent = `Could not read ${path}: ${errorMessage(err)}`;
    }
    renderPreview();
  }

  function moveSelection(delta: number): void {
    const visible = visibleEntries();
    if (visible.length === 0) return;
    const index = visible.findIndex((item) => item.path === selected);
    const next = index === -1 ? (delta > 0 ? 0 : visible.length - 1) : index + delta;
    const clamped = Math.min(visible.length - 1, Math.max(0, next));
    selected = visible[clamped]?.path ?? null;
    render();
  }

  function onKeyDown(event: KeyboardEvent): void {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        moveSelection(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        moveSelection(-1);
        break;
      case 'Enter': {
        event.preventDefault();
        if (!selected) break;
        const item = visibleEntries().find((entry) => entry.path === selected);
        if (item) selectPath(item.path, item.entry.kind);
        break;
      }
      case 'Escape': {
        event.preventDefault();
        if (selected && expanded.has(selected)) {
          expanded.delete(selected);
          children.delete(selected);
          render();
        } else if (currentPath !== root) {
          const parent = currentPath.replace(/\/[^/]*$/, '') || '/';
          void navigate(parent);
        }
        break;
      }
      default:
        break;
    }
  }

  async function refresh(): Promise<void> {
    if (!vm) {
      entries = [];
      render();
      return;
    }
    loading = true;
    render();
    try {
      entries = await vm.list(currentPath);
    } catch (err) {
      entries = [];
      status.textContent = `Could not list ${currentPath}: ${errorMessage(err)}`;
    }
    loading = false;
    render();
  }

  async function navigate(path: string): Promise<void> {
    currentPath = path;
    selected = null;
    previewPath = null;
    previewContent = '';
    expanded.clear();
    children.clear();
    await refresh();
  }

  return {
    setVM(next) {
      vm = next;
      if (vm?.running) {
        void refresh();
      } else {
        entries = [];
        render();
      }
    },

    attach() {
      if (attached) return;
      attached = true;
      container.addEventListener('keydown', onKeyDown);
      container.tabIndex = 0;
    },

    detach() {
      if (!attached) return;
      attached = false;
      container.removeEventListener('keydown', onKeyDown);
    },

    navigate,

    refresh,

    setLoading(next) {
      loading = next;
      render();
    },

    dispose() {
      this.detach();
      for (const cleanup of itemCleanups) cleanup();
      itemCleanups = [];
      tree.remove();
    },
  };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
