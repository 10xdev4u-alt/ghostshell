import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  computeDiff,
  computeLineDiff,
  createDiffView,
  renderLineDiff,
} from '@/ui/diff.js';
import { FakeElement, findAllByClass, findByClass, installFakeDocument } from './helpers/dom.js';

describe('diff viewer', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('computes added, modified, and deleted entries from before/after maps', () => {
    const before = new Map([
      ['/a.txt', 'one'],
      ['/b.txt', 'two'],
      ['/gone.txt', 'bye'],
    ]);
    const after = new Map([
      ['/a.txt', 'one'],
      ['/b.txt', 'changed'],
      ['/new.txt', 'three'],
    ]);

    expect(computeDiff(before, after)).toEqual([
      { path: '/b.txt', kind: 'modified' },
      { path: '/new.txt', kind: 'added' },
      { path: '/gone.txt', kind: 'deleted' },
    ]);
  });

  it('returns no entries for identical maps', () => {
    const before = new Map([['/a.txt', 'one']]);
    const after = new Map([['/a.txt', 'one']]);
    expect(computeDiff(before, after)).toEqual([]);
  });

  it('computes a line-level diff with before/after line numbers', () => {
    const entries = computeLineDiff('one\ntwo\nthree\n', 'one\nTWO\nthree\n');
    expect(entries).toEqual([
      { type: 'unchanged', content: 'one', beforeLine: 1, afterLine: 1 },
      { type: 'removed', content: 'two', beforeLine: 2 },
      { type: 'added', content: 'TWO', afterLine: 2 },
      { type: 'unchanged', content: 'three', beforeLine: 3, afterLine: 3 },
    ]);
  });

  it('handles fully added and fully removed content', () => {
    expect(computeLineDiff('', 'new\n')).toEqual([
      { type: 'added', content: 'new', afterLine: 1 },
    ]);
    expect(computeLineDiff('old\n', '')).toEqual([
      { type: 'removed', content: 'old', beforeLine: 1 },
    ]);
  });

  it('renders line diff entries with added/removed/unchanged classes', () => {
    installFakeDocument();
    const wrap = renderLineDiff([
      { type: 'unchanged', content: 'one', beforeLine: 1, afterLine: 1 },
      { type: 'removed', content: 'two', beforeLine: 2 },
      { type: 'added', content: 'TWO', afterLine: 2 },
    ]);

    const lines = findAllByClass(wrap as unknown as FakeElement, 'gs-diff-line');
    expect(lines).toHaveLength(3);
    expect(lines[0]!.className).toContain('gs-diff-line--unchanged');
    expect(lines[1]!.className).toContain('gs-diff-line--removed');
    expect(lines[2]!.className).toContain('gs-diff-line--added');
    expect(findByClass(lines[2]!, 'gs-diff-line__content')?.textContent).toBe('TWO');
  });

  it('renders a diff view with a header and entries', () => {
    installFakeDocument();
    const container = new FakeElement('div');
    const view = createDiffView(container as unknown as HTMLElement);

    view.show('Agent changes', [
      { path: '/new.txt', kind: 'added', after: 'hello\n' },
      { path: '/old.txt', kind: 'deleted', before: 'bye\n' },
    ]);

    const inner = container.children[0]!;
    expect(findByClass(inner, 'gs-diff-header')?.textContent).toBe('Agent changes');
    const entries = findAllByClass(inner, 'gs-diff-entry');
    expect(entries).toHaveLength(2);
    expect(entries[0]!.className).toContain('gs-diff-entry--added');
    expect(findByClass(entries[0]!, 'gs-diff-whole--added')?.textContent).toBe('hello\n');
  });
});
