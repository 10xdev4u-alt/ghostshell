import type { Artifact } from '@/types/index.js';
import { diffLines } from 'diff';

/**
 * Diff viewer. Shows the changes the agent made to the VM filesystem.
 *
 * `computeDiff` compares before/after content hashes; `computeLineDiff` uses
 * `diffLines` (jsdiff) to render added/removed/unchanged lines for a file
 * whose contents are available on both sides.
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

export interface LineDiffEntry {
  type: 'added' | 'removed' | 'unchanged';
  content: string;
  /** 1-based line number in the before text (when applicable). */
  beforeLine?: number;
  /** 1-based line number in the after text (when applicable). */
  afterLine?: number;
}

export function createDiffView(container: HTMLElement): DiffViewHandle {
  const view = document.createElement('div');
  view.className = 'gs-diff-inner';
  container.replaceChildren(view);

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

  if (entry.before !== undefined && entry.after !== undefined) {
    el.appendChild(renderLineDiff(computeLineDiff(entry.before, entry.after)));
    return el;
  }

  const content = entry.after ?? entry.before ?? '';
  if (content.length > 0) {
    const pre = document.createElement('pre');
    pre.className = `gs-diff-whole gs-diff-whole--${entry.after !== undefined ? 'added' : 'removed'}`;
    pre.textContent = content.slice(0, 8000);
    el.appendChild(pre);
  }
  return el;
}

export function renderLineDiff(entries: LineDiffEntry[]): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'gs-diff-lines';
  for (const entry of entries) {
    const line = document.createElement('div');
    line.className = `gs-diff-line gs-diff-line--${entry.type}`;

    const before = document.createElement('span');
    before.className = 'gs-diff-line__number gs-diff-line__number--before';
    before.textContent = entry.beforeLine !== undefined ? String(entry.beforeLine) : '';

    const after = document.createElement('span');
    after.className = 'gs-diff-line__number gs-diff-line__number--after';
    after.textContent = entry.afterLine !== undefined ? String(entry.afterLine) : '';

    const sign = document.createElement('span');
    sign.className = 'gs-diff-line__sign';
    sign.textContent = entry.type === 'added' ? '+' : entry.type === 'removed' ? '−' : ' ';

    const content = document.createElement('span');
    content.className = 'gs-diff-line__content';
    content.textContent = entry.content;

    line.append(before, after, sign, content);
    wrap.appendChild(line);
  }
  return wrap;
}

/**
 * Compute a line-level diff between two texts. Lines are split from the jsdiff
 * change values (which retain their trailing newlines); a trailing empty
 * fragment caused by a final newline is dropped.
 */
export function computeLineDiff(before: string, after: string): LineDiffEntry[] {
  const changes = diffLines(before, after);
  const entries: LineDiffEntry[] = [];
  let beforeLine = 1;
  let afterLine = 1;

  for (const change of changes) {
    for (const line of splitLines(change.value)) {
      if (change.added) {
        entries.push({ type: 'added', content: line, afterLine });
        afterLine += 1;
      } else if (change.removed) {
        entries.push({ type: 'removed', content: line, beforeLine });
        beforeLine += 1;
      } else {
        entries.push({ type: 'unchanged', content: line, beforeLine, afterLine });
        beforeLine += 1;
        afterLine += 1;
      }
    }
  }

  return entries;
}

function splitLines(value: string): string[] {
  if (value.length === 0) return [];
  const lines = value.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
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
