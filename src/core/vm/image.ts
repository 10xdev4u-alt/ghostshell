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

export const DEFAULT_IMAGE: VMImage = {
  id: VM_CONSTRAINTS.bootImage,
  name: 'Alpine 3.21 i386 (pre-baked)',
  arch: 'ia32',
  // Recorded by scripts/build-image.sh once the rootfs is vendored.
  sizeBytes: 0,
  url: ALPINE_IMAGE_URLS.dockerBase,
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

export const IMAGES: VMImage[] = [DEFAULT_IMAGE];

export function getImage(id: string): VMImage {
  const image = IMAGES.find((i) => i.id === id);
  if (!image) throw new Error(`Unknown VM image: ${id}`);
  return image;
}

/** URL for the image's upstream source. Override with ?image_url=... for testing. */
export function imageUrl(image: VMImage): string | undefined {
  return image.url;
}
