import type { VMImage } from '@/types/index.js';
import { VM_CONSTRAINTS } from '@/config.js';

/**
 * VM image manifest.
 *
 * v86 is 32-bit, so every image must be ia32. The default image is Alpine
 * 3.21 i386 with git, python3, node (32-bit), ripgrep, and a pre-warmed
 * package cache. Images are built by scripts/build-image.sh.
 *
 * The upstream Alpine image is built from the official `i386/alpine:3.21.0`
 * Docker base using the v86 project's own recipe:
 * https://github.com/copy/v86/tree/master/tools/docker/alpine
 *
 * The resulting 9p rootfs (`alpine-rootfs-flat/` + `alpine-fs.json`) is what
 * the browser actually boots; it is not hosted upstream, so it is built and
 * vendored by this repository.
 */

/** Boot media resolved by the v86 handle when no explicit deps are given. */
export interface BootMedia {
  biosUrl: string;
  vgaBiosUrl: string;
  rootfsBaseUrl: string;
  rootfsFsJson: string;
  cmdline: string;
}

/**
 * Boot configuration mirroring v86's `examples/alpine.html`, with the 9p
 * rootfs produced by `tools/docker/alpine/build.sh`.
 */
export const ALPINE_BOOT: BootMedia = {
  biosUrl: 'https://copy.sh/v86/bios/seabios.bin',
  vgaBiosUrl: 'https://copy.sh/v86/bios/vgabios.bin',
  rootfsBaseUrl: 'images/alpine-rootfs-flat',
  rootfsFsJson: 'images/alpine-fs.json',
  cmdline:
    'rw root=host9p rootfstype=9p rootflags=trans=virtio,cache=loose ' +
    'modules=virtio_pci tsc=reliable init_on_free=on',
};

/** Upstream references for the default image. */
export const ALPINE_IMAGE_URLS = {
  dockerBase: 'https://hub.docker.com/r/i386/alpine/tags?name=3.21.0',
  v86BuildRecipe: 'https://github.com/copy/v86/tree/master/tools/docker/alpine',
  v86AlpineExample: 'https://github.com/copy/v86/blob/master/examples/alpine.html',
  v86Bios: 'https://copy.sh/v86/bios/seabios.bin',
  v86VgaBios: 'https://copy.sh/v86/bios/vgabios.bin',
} as const;

/** Probe for whether a boot artifact exists. */
export type ArtifactExists = (path: string) => boolean;

type NodeFsModule = { existsSync?: (candidate: string) => boolean };
type NodePathModule = {
  resolve(...parts: string[]): string;
  dirname(candidate: string): string;
};
type NodeUrlModule = { fileURLToPath?: (candidate: string) => string };

/**
 * Load a Node built-in without a static import.
 *
 * The browser bundle has no `node:*` modules; a static import would fail to
 * resolve there.
 */
function nodeBuiltin(id: string): unknown {
  const proc = (
    globalThis as {
      process?: { getBuiltinModule?: (id: string) => unknown } | undefined;
    }
  ).process;
  return proc?.getBuiltinModule?.(id);
}

/**
 * Absolute project root, derived from this module's source location.
 *
 * Artifact paths are recorded relative to the repository root (where
 * `scripts/build-image.sh` writes them), so probing them against
 * `process.cwd()` false-negatives when the app is started from another
 * directory.
 */
function projectRoot(): string | null {
  const path = nodeBuiltin('node:path') as NodePathModule | undefined;
  const url = nodeBuiltin('node:url') as NodeUrlModule | undefined;
  if (!path || !url?.fileURLToPath) return null;
  try {
    return path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../../..');
  } catch {
    return null;
  }
}

/** True when the runtime can probe artifacts on a local filesystem. */
export function hasFileSystem(): boolean {
  return typeof (nodeBuiltin('node:fs') as NodeFsModule | undefined)?.existsSync === 'function';
}

/**
 * Default artifact probe.
 *
 * Under Node this checks the filesystem, resolving artifact paths against the
 * project root. The browser cannot (the 9p manifest is fetched over HTTP), so
 * it assumes the artifact is present; `assertImageAvailableForBoot` probes the
 * URLs there instead.
 */
export function nodeArtifactExists(path: string): boolean {
  const fs = nodeBuiltin('node:fs') as NodeFsModule | undefined;
  if (!fs?.existsSync) return true;
  const root = projectRoot();
  if (root === null) return fs.existsSync(path);
  const nodePath = nodeBuiltin('node:path') as NodePathModule | undefined;
  return fs.existsSync(nodePath ? nodePath.resolve(root, path) : path);
}

/** A VM image plus the local artifacts required to boot it. */
export interface ManifestImage extends VMImage {
  /** Paths that must exist before this image can boot. */
  artifacts?: string[];
}

function missingArtifactsError(image: { id: string }, missing: string[]): Error {
  return new Error(
    `VM image "${image.id}" is missing required artifacts: ${missing.join(', ')}. ` +
      'Run `bun run image:build` (bash scripts/build-image.sh) to build the Alpine i386 rootfs.',
  );
}

/**
 * Fail with an actionable message when an image's artifacts are missing.
 *
 * Without this, a missing rootfs surfaces as an opaque v86 `download-error`
 * (or a hang) at boot time.
 */
export function assertImageAvailable(
  image: ManifestImage,
  exists: ArtifactExists = nodeArtifactExists,
): void {
  const missing = (image.artifacts ?? []).filter((path) => !exists(path));
  if (missing.length === 0) return;
  throw missingArtifactsError(image, missing);
}

/** Artifacts that are files and can be fetched directly (not directories). */
function isFileArtifact(path: string): boolean {
  return /\.[^./]+$/.test(path);
}

async function probeArtifactUrl(
  artifact: string,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  try {
    const response = await fetchImpl(artifact, { method: 'HEAD' });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Verify an image's artifacts before booting.
 *
 * Node/Bun already ran the synchronous filesystem probe in `getImage`, so
 * this is a no-op there. The browser has no filesystem to probe — it fetches
 * artifacts over HTTP — so probe the file artifacts (the 9p manifest) before
 * v86 boots. A missing artifact fails with an actionable message instead of
 * an opaque emulator timeout.
 */
export async function assertImageAvailableForBoot(
  image: VMImage,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (hasFileSystem()) return;
  const artifacts = (image as ManifestImage).artifacts ?? [];
  const missing: string[] = [];
  for (const artifact of artifacts.filter(isFileArtifact)) {
    if (!(await probeArtifactUrl(artifact, fetchImpl))) missing.push(artifact);
  }
  if (missing.length > 0) throw missingArtifactsError(image, missing);
}

export const DEFAULT_IMAGE: ManifestImage = {
  id: VM_CONSTRAINTS.bootImage,
  name: 'Alpine 3.21 i386 (pre-baked)',
  arch: 'ia32',
  // Recorded by scripts/build-image.sh once the rootfs is vendored.
  sizeBytes: 0,
  url: ALPINE_IMAGE_URLS.dockerBase,
  artifacts: [ALPINE_BOOT.rootfsFsJson, ALPINE_BOOT.rootfsBaseUrl],
  prebaked: [
    'alpine-base',
    'git',
    'python3',
    'py3-pip',
    'nodejs',
    'npm',
    'ripgrep',
    'bash',
    'coreutils',
    'curl',
    'openssh-client',
    'ca-certificates',
  ],
};

export const IMAGES: ManifestImage[] = [DEFAULT_IMAGE];

export function getImage(id: string, exists: ArtifactExists = nodeArtifactExists): VMImage {
  const image = IMAGES.find((i) => i.id === id);
  if (!image) throw new Error(`Unknown VM image: ${id}`);
  assertImageAvailable(image, exists);
  return image;
}

/** URL for the image's upstream source. Override with ?image_url=... for testing. */
export function imageUrl(image: VMImage): string | undefined {
  return image.url;
}
