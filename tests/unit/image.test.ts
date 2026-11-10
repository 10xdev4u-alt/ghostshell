import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ALPINE_BOOT,
  DEFAULT_IMAGE,
  assertImageAvailable,
  getImage,
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
