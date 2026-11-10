import type { Artifact } from '@/types/index.js';

/**
 * Diff viewer. Shows the changes the agent made to the VM filesystem.
 *
 * v0.1 compares snapshots by hashing files before/after a turn. v0.2 adds a
 * proper line-level diff (jsdiff).
 */

export interface DiffViewHandle {
  show(message: string, entries: DiffEntry[]): void;
  clear(): void;
  dispose(): void;
}

export interface DiffEntry {
  path: string;
  kind: 'added' | 'modified' | 'deleted';
  before?: string;
  after?: string;
}

export function createDiffView(container: HTMLElement): DiffViewHandle {
  const view = document.createElement('div');
  view.className = 'gs-diff-inner';
  container.appendChild(view);

  return {
    show(message, entries) {
      view.replaceChildren();
      const header = document.createElement('div');
      header.className = 'gs-diff-header';
      header.textContent = message;
      view.appendChild(header);
      for (const entry of entries) {
        view.appendChild(renderEntry(entry));
      }
    },
    clear() {
      view.replaceChildren();
    },
    dispose() {
      view.remove();
    },
  };
}

function renderEntry(entry: DiffEntry): HTMLElement {
  const el = document.createElement('div');
  el.className = `gs-diff-entry gs-diff-entry--${entry.kind}`;
  const path = document.createElement('span');
  path.className = 'gs-diff-path';
  path.textContent = `${icon(entry.kind)} ${entry.path}`;
  el.appendChild(path);
  if (entry.after) {
    const pre = document.createElement('pre');
    pre.textContent = entry.after.slice(0, 8000);
    el.appendChild(pre);
  }
  return el;
}

function icon(kind: DiffEntry['kind']): string {
  return kind === 'added' ? '➕' : kind === 'deleted' ? '➖' : '✏️';
}

/** Build a diff from two maps of path -> content hash. */
export function computeDiff(before: Map<string, string>, after: Map<string, string>): DiffEntry[] {
  const entries: DiffEntry[] = [];
  for (const [path, hash] of after) {
    if (!before.has(path)) entries.push({ path, kind: 'added' });
    else if (before.get(path) !== hash) entries.push({ path, kind: 'modified' });
  }
  for (const path of before.keys()) {
    if (!after.has(path)) entries.push({ path, kind: 'deleted' });
  }
  return entries;
}

export function artifactFromDiff(entries: DiffEntry[]): Artifact {
  return {
    id: crypto.randomUUID(),
    kind: 'markdown',
    content: entries.map((e) => `- ${e.kind}: ${e.path}`).join('\n'),
    mime: 'text/markdown',
    createdAt: Date.now(),
  };
}
