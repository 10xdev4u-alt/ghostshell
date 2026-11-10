import type { DirEntry } from '@/types/index.js';

/**
 * File tree panel. Renders a directory listing from the VM and lets the user
 * click to expand directories or preview files.
 */

export interface FileTreeHandle {
  render(entries: DirEntry[], path: string): void;
  setLoading(loading: boolean): void;
  dispose(): void;
}

export function createFileTree(container: HTMLElement): FileTreeHandle {
  const tree = document.createElement('div');
  tree.className = 'gs-filetree-inner';
  container.appendChild(tree);

  return {
    render(entries, path) {
      tree.replaceChildren();
      const header = document.createElement('div');
      header.className = 'gs-filetree-path';
      header.textContent = path;
      tree.appendChild(header);
      const list = document.createElement('ul');
      list.className = 'gs-filetree-list';
      for (const entry of entries) {
        list.appendChild(renderEntry(entry));
      }
      tree.appendChild(list);
    },
    setLoading(loading) {
      container.classList.toggle('is-loading', loading);
    },
    dispose() {
      tree.remove();
    },
  };
}

function renderEntry(entry: DirEntry): HTMLElement {
  const li = document.createElement('li');
  li.className = `gs-filetree-item gs-filetree-item--${entry.kind}`;
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
  return li;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
