import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DirEntry, VMHandle } from '@/types/index.js';
import { createFileTree } from '@/ui/filetree.js';
import {
  FakeElement,
  FakeEvent,
  findAllByClass,
  findByClass,
  installFakeDocument,
} from './helpers/dom.js';

const directories = new Map<string, DirEntry[]>([
  [
    '/root/workspace',
    [
      { name: 'a.txt', kind: 'file', size: 5, mtime: 0 },
      { name: 'sub', kind: 'dir', size: 0, mtime: 0 },
    ],
  ],
  ['/root/workspace/sub', [{ name: 'b.txt', kind: 'file', size: 5, mtime: 0 }]],
]);

const files = new Map<string, string>([
  ['/root/workspace/a.txt', 'hello'],
  ['/root/workspace/sub/b.txt', 'world'],
]);

function fakeVM(): VMHandle {
  return {
    id: 'fake',
    running: true,
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    pause: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
    exec: vi.fn(async () => ({
      stdout: '',
      stderr: '',
      exitCode: 0,
      durationMs: 0,
      timedOut: false,
    })),
    sendSerial: vi.fn(),
    write: vi.fn(async () => undefined),
    read: vi.fn(async (path: string) => files.get(path) ?? ''),
    list: vi.fn(async (path: string) => directories.get(path) ?? []),
    onSerial: vi.fn(),
  };
}

function setup() {
  installFakeDocument();
  const container = new FakeElement('div');
  const tree = createFileTree(container as unknown as HTMLElement, { root: '/root/workspace' });
  return { container, tree };
}

function itemPaths(container: FakeElement): string[] {
  return findAllByClass(container, 'gs-filetree-item').map((item) => item.dataset.path ?? '');
}

function findItem(container: FakeElement, path: string): FakeElement {
  const item = findAllByClass(container, 'gs-filetree-item').find(
    (candidate) => candidate.dataset.path === path,
  );
  if (!item) throw new Error(`missing tree item ${path}`);
  return item;
}

describe('file tree', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists directories with path and depth metadata', async () => {
    const { container, tree } = setup();
    const vm = fakeVM();
    tree.setVM(vm);

    await vi.waitFor(() => expect(itemPaths(container)).toHaveLength(2));
    expect(itemPaths(container)).toEqual(['/root/workspace/a.txt', '/root/workspace/sub']);
    expect(findItem(container, '/root/workspace/sub').dataset.depth).toBe('0');
  });

  it('shows a placeholder before a VM is bound', () => {
    const { container, tree } = setup();
    tree.setVM(null);
    expect(findByClass(container, 'gs-filetree-status')?.textContent).toBe('No VM running.');
  });

  it('expands and collapses directories lazily', async () => {
    const { container, tree } = setup();
    const vm = fakeVM();
    tree.setVM(vm);
    await vi.waitFor(() => expect(itemPaths(container)).toHaveLength(2));

    findItem(container, '/root/workspace/sub').click();
    await vi.waitFor(() => expect(vm.list).toHaveBeenCalledWith('/root/workspace/sub'));
    await vi.waitFor(() => expect(itemPaths(container)).toHaveLength(3));
    expect(itemPaths(container)).toContain('/root/workspace/sub/b.txt');
    expect(findItem(container, '/root/workspace/sub/b.txt').dataset.depth).toBe('1');

    findItem(container, '/root/workspace/sub').click();
    await vi.waitFor(() => expect(itemPaths(container)).toHaveLength(2));
    expect(itemPaths(container)).not.toContain('/root/workspace/sub/b.txt');
  });

  it('previews a file on select', async () => {
    const { container, tree } = setup();
    const vm = fakeVM();
    tree.setVM(vm);
    await vi.waitFor(() => expect(itemPaths(container)).toHaveLength(2));

    findItem(container, '/root/workspace/a.txt').click();
    await vi.waitFor(() => expect(vm.read).toHaveBeenCalledWith('/root/workspace/a.txt'));
    await vi.waitFor(() =>
      expect(findByClass(container, 'gs-filetree-preview-content')?.textContent).toBe('hello'),
    );
  });

  it('navigates up and down with the keyboard', async () => {
    const { container, tree } = setup();
    tree.setVM(fakeVM());
    tree.attach();
    await vi.waitFor(() => expect(itemPaths(container)).toHaveLength(2));

    container.dispatchEvent(new FakeEvent('keydown', { key: 'ArrowDown' }));
    expect(
      findAllByClass(container, 'gs-filetree-item--selected').map((item) => item.dataset.path),
    ).toEqual(['/root/workspace/a.txt']);

    container.dispatchEvent(new FakeEvent('keydown', { key: 'ArrowDown' }));
    expect(
      findAllByClass(container, 'gs-filetree-item--selected').map((item) => item.dataset.path),
    ).toEqual(['/root/workspace/sub']);

    container.dispatchEvent(new FakeEvent('keydown', { key: 'ArrowUp' }));
    expect(
      findAllByClass(container, 'gs-filetree-item--selected').map((item) => item.dataset.path),
    ).toEqual(['/root/workspace/a.txt']);

    container.dispatchEvent(new FakeEvent('keydown', { key: 'ArrowDown' }));
    container.dispatchEvent(new FakeEvent('keydown', { key: 'Enter' }));
    await vi.waitFor(() => expect(itemPaths(container)).toHaveLength(3));

    container.dispatchEvent(new FakeEvent('keydown', { key: 'Escape' }));
    await vi.waitFor(() => expect(itemPaths(container)).toHaveLength(2));
  });

  it('navigates to an absolute path', async () => {
    const { container, tree } = setup();
    tree.setVM(fakeVM());

    await tree.navigate('/root/workspace/sub');
    expect(itemPaths(container)).toEqual(['/root/workspace/sub/b.txt']);
    expect(findByClass(container, 'gs-filetree-path')?.textContent).toBe('/root/workspace/sub');
  });
});
