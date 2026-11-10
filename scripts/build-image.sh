#!/usr/bin/env bash
#
# Build the Alpine i386 9p rootfs used by the default GhostShell VM image.
#
# Produces (both gitignored):
#   images/alpine-fs.json         v86 filesystem manifest (format version 3)
#   images/alpine-rootfs-flat/    file contents named by 10-char sha256
#
# Requires: docker (with linux/386 support) and python3.
# Usage: bun run image:build   (or bash scripts/build-image.sh)
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGES="$ROOT/images"
FLAT_DIR="$IMAGES/alpine-rootfs-flat"
FS_JSON="$IMAGES/alpine-fs.json"
BUILD_DIR="$IMAGES/build"
ROOTFS_TAR="$BUILD_DIR/alpine-rootfs.tar"

ALPINE_TAG="${ALPINE_TAG:-3.21.0}"
IMAGE_NAME="${IMAGE_NAME:-ghostshell-alpine-v86}"
CONTAINER_NAME="${CONTAINER_NAME:-ghostshell-alpine-v86}"

for bin in docker python3 tar; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "error: $bin is required to build the VM image" >&2
    exit 1
  fi
done

mkdir -p "$BUILD_DIR" "$FLAT_DIR"

echo "Building i386/alpine:$ALPINE_TAG rootfs..."
docker build \
  --platform linux/386 \
  --rm \
  --tag "$IMAGE_NAME" \
  - <<DOCKERFILE
FROM docker.io/i386/alpine:$ALPINE_TAG

ENV KERNEL=virt

# Match DEFAULT_IMAGE.prebaked in src/core/vm/image.ts.
RUN apk add --no-cache \\
      openrc alpine-base agetty alpine-conf \\
      linux-virt linux-firmware-none \\
      nodejs npm git python3 py3-pip ripgrep bash coreutils \\
      curl openssh-client ca-certificates

# Autologin root on the serial console (v86 serial0 -> guest ttyS0).
RUN sed -i 's/getty 38400 tty1/agetty --autologin root tty1 linux/' /etc/inittab
RUN echo 'ttyS0::respawn:/sbin/agetty --autologin root -s ttyS0 115200 vt100' >> /etc/inittab
RUN echo "root:" | chpasswd

RUN setup-hostname localhost

# Minimal openrc boot set (same as the v86 Alpine recipe).
RUN for i in devfs dmesg mdev hwdrivers; do rc-update add \$i sysinit; done
RUN for i in hwclock modules sysctl hostname syslog bootmisc; do rc-update add \$i boot; done
RUN rc-update add killprocs shutdown

# Initramfs with the 9p client modules needed to mount root over virtio-9p.
RUN mkinitfs -F "base virtio 9p" \$(cat /usr/share/kernel/\$KERNEL/kernel.release)
DOCKERFILE

echo "Exporting rootfs tar..."
docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
docker create --platform linux/386 -t -i --name "$CONTAINER_NAME" "$IMAGE_NAME"
docker export "$CONTAINER_NAME" -o "$ROOTFS_TAR"
docker rm -f "$CONTAINER_NAME" >/dev/null

# docker export includes the container marker; the v86 filesystem does not.
tar -f "$ROOTFS_TAR" --delete ".dockerenv" >/dev/null 2>&1 || true

echo "Writing $FS_JSON and $FLAT_DIR..."
python3 - "$ROOTFS_TAR" "$FS_JSON" "$FLAT_DIR" <<'PY'
import hashlib
import json
import os
import stat
import sys
import tarfile

VERSION = 3
HASH_LENGTH = 10
S_IFLNK = 0o120000
S_IFREG = 0o100000
S_IFDIR = 0o040000

tar_path, fs_json, flat_dir = sys.argv[1], sys.argv[2], sys.argv[3]


def parts_of(name):
    # Normalise "./bin/busybox", "bin//busybox", "/bin/busybox".
    return [p for p in name.split("/") if p not in ("", ".")]


def new_dir(name, mode, mtime):
    return {
        "name": name,
        "kind": "dir",
        "mode": mode | S_IFDIR,
        "mtime": mtime,
        "children": [],
    }


def find_child(node, name, kind):
    for child in node["children"]:
        if child["name"] == name and child["kind"] == kind:
            return child
    return None


def main():
    os.makedirs(flat_dir, exist_ok=True)
    root = new_dir("", 0o40755, 0)
    seen_hashes = {}
    total_size = 0

    with tarfile.open(tar_path, "r:*") as tar:
        for member in tar.getmembers():
            parts = parts_of(member.name)
            if not parts:
                continue

            parent = root
            for part in parts[:-1]:
                child = find_child(parent, part, "dir")
                if child is None:
                    child = new_dir(part, 0o40755, 0)
                    parent["children"].append(child)
                parent = child

            name = parts[-1]
            mode = member.mode
            mtime = int(member.mtime)

            if member.isdir():
                if find_child(parent, name, "dir") is None:
                    parent["children"].append(new_dir(name, mode, mtime))
            elif member.issym():
                parent["children"].append(
                    {
                        "name": name,
                        "kind": "symlink",
                        "mode": mode | S_IFLNK,
                        "mtime": mtime,
                        "target": member.linkname,
                    }
                )
            elif member.isfile() or member.islnk():
                extracted = tar.extractfile(member)
                data = extracted.read() if extracted is not None else b""
                digest = hashlib.sha256(data).hexdigest()
                filename = digest[:HASH_LENGTH] + ".bin"
                if filename not in seen_hashes:
                    with open(os.path.join(flat_dir, filename), "wb") as out:
                        out.write(data)
                seen_hashes[filename] = digest
                size = len(data) if member.islnk() else member.size
                parent["children"].append(
                    {
                        "name": name,
                        "kind": "file",
                        "mode": mode | S_IFREG,
                        "mtime": mtime,
                        "size": size,
                        "filename": filename,
                    }
                )
                total_size += size
            # Device nodes, FIFOs and sockets are not supported by the 9p
            # filesystem and are skipped.

    def encode(node):
        if node["kind"] == "dir":
            return [
                node["name"],
                0,
                node["mtime"],
                node["mode"],
                0,
                0,
                [encode(child) for child in node["children"]],
            ]
        if node["kind"] == "symlink":
            return [
                node["name"],
                0,
                node["mtime"],
                node["mode"],
                0,
                0,
                node["target"],
            ]
        return [
            node["name"],
            node["size"],
            node["mtime"],
            node["mode"],
            0,
            0,
            node["filename"],
        ]

    result = {
        "fsroot": [encode(child) for child in root["children"]],
        "version": VERSION,
        "size": total_size,
    }
    with open(fs_json, "w") as out:
        json.dump(result, out, separators=(",", ":"))


main()
PY

echo "Done: $FS_JSON and $FLAT_DIR"
echo "Boot with: bun run dev"
