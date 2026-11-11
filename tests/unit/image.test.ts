import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ALPINE_BOOT,
  DEFAULT_IMAGE,
  assertImageAvailable,
  assertImageAvailableForBoot,
  getImage,
  hasFileSystem,
  nodeArtifactExists,
} from '@/core/vm/image.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('default boot image', () => {
  it('points at the artifacts produced by build-image.sh', () => {
    expect(ALPINE_BOOT.rootfsFsJson).toBe('images/alpine-fs.json');
    expect(ALPINE_BOOT.rootfsBaseUrl).toBe('images/alpine-rootfs-flat');
    expect(DEFAULT_IMAGE.artifacts).toEqual([
      'images/alpine-fs.json',
      'images/alpine-rootfs-flat',
    ]);
  });

  it('ships a build-image.sh script', () => {
    expect(existsSync(resolve(root, 'scripts/build-image.sh'))).toBe(true);
  });

  it('gitignores the generated rootfs artifacts', () => {
    const gitignore = readFileSync(resolve(root, '.gitignore'), 'utf8');
    expect(gitignore).toContain('images/alpine-rootfs-flat/');
    expect(gitignore).toContain('images/alpine-fs.json');
  });
});

describe('nodeArtifactExists', () => {
  it('detects the node filesystem', () => {
    expect(hasFileSystem()).toBe(true);
  });

  it('resolves artifact paths against the project root', () => {
    expect(nodeArtifactExists('scripts/build-image.sh')).toBe(true);
    expect(nodeArtifactExists('images/alpine-fs.json')).toBe(false);
  });

  it('does not depend on the current working directory', () => {
    const original = process.cwd();
    process.chdir('/');
    try {
      expect(nodeArtifactExists('scripts/build-image.sh')).toBe(true);
      expect(nodeArtifactExists('images/alpine-fs.json')).toBe(false);
    } finally {
      process.chdir(original);
    }
  });
});

describe('assertImageAvailableForBoot', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('probes file artifacts over HTTP in the browser', async () => {
    vi.stubGlobal('process', undefined);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });

    await expect(
      assertImageAvailableForBoot(DEFAULT_IMAGE, fetchMock as unknown as typeof fetch),
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith('images/alpine-fs.json', { method: 'HEAD' });
  });

  it('fails with an actionable message when an artifact is missing', async () => {
    vi.stubGlobal('process', undefined);
    const fetchMock = vi.fn().mockResolvedValue({ ok: false });

    await expect(
      assertImageAvailableForBoot(DEFAULT_IMAGE, fetchMock as unknown as typeof fetch),
    ).rejects.toThrow(/missing required artifacts/);
    await expect(
      assertImageAvailableForBoot(DEFAULT_IMAGE, fetchMock as unknown as typeof fetch),
    ).rejects.toThrow(/images\/alpine-fs\.json/);
    await expect(
      assertImageAvailableForBoot(DEFAULT_IMAGE, fetchMock as unknown as typeof fetch),
    ).rejects.toThrow(/scripts\/build-image\.sh/);
  });

  it('treats a network error as a missing artifact', async () => {
    vi.stubGlobal('process', undefined);
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));

    await expect(
      assertImageAvailableForBoot(DEFAULT_IMAGE, fetchMock as unknown as typeof fetch),
    ).rejects.toThrow(/missing required artifacts/);
  });
});

describe('getImage', () => {
  it('returns the default image when its artifacts exist', () => {
    expect(getImage('alpine-3.21-i386', () => true).id).toBe(DEFAULT_IMAGE.id);
  });

  it('fails with a clear message when the image is absent', () => {
    expect(() => getImage('alpine-3.21-i386', () => false)).toThrow(
      /missing required artifacts/,
    );
    expect(() => getImage('alpine-3.21-i386', () => false)).toThrow(/bun run image:build/);
  });

  it('assertImageAvailable names the missing artifact', () => {
    expect(() =>
      assertImageAvailable(DEFAULT_IMAGE, (path) => path !== 'images/alpine-fs.json'),
    ).toThrow(/images\/alpine-fs\.json/);
  });
});
