import type { VMImage } from '@/types/index.js';
import { VM_CONSTRAINTS } from '@/config.js';

/**
 * VM image manifest.
 *
 * v86 is 32-bit, so every image must be ia32. The default image is Alpine
 * 3.21 i386 with git, python3, node (32-bit), ripgrep, and a pre-warmed
 * package cache. Images are built by scripts/build-image.sh.
 */

export const DEFAULT_IMAGE: VMImage = {
  id: VM_CONSTRAINTS.bootImage,
  name: 'Alpine 3.21 i386 (pre-baked)',
  arch: 'ia32',
  sizeBytes: 0,
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

/** URL for the image's boot media. Override with ?image_url=... for testing. */
export function imageUrl(image: VMImage): string | undefined {
  return image.url;
}
