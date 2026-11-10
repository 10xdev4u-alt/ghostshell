# ADR 0001: Choose v86 as the VM backend

- **Status:** Accepted
- **Date:** 2026-11-10
- **Deciders:** GhostShell core team
- **Related:** `docs/ENGINEERING_PLAN.md` §3.1, `docs/CREATIVE_INNOVATION.md` §0.2 and §9.3, `src/core/vm/v86.ts`, `src/types/index.ts` (`VMHandle`)

## Context

GhostShell's product premise is a coding agent that runs **real commands in a real Linux
environment**, entirely inside a browser tab, delivered as one static HTML file with no
backend. The agent must be able to:

- run `bash`, `git`, `python3`, and `nodejs`;
- read, write, and search a persistent filesystem;
- install and use packages from a Linux distribution;
- boot in seconds and fit inside a guest RAM budget of 256–512 MB;
- persist its filesystem across sessions (snapshot save/restore);
- run offline (no VM network in v0.1), with networking as an explicit v1.0 opt-in.

The VM runtime must be embeddable in a browser, licensed for redistribution, and small
enough to inline into the single-file build (the v0.1 budget is < 100 MB total).

## Decision

Use **copy.sh v86** as the VM backend, pinned to `v86@0.5.473`.

- v86 is a WASM build of a QEMU-derived x86 emulator (TCG) that boots a full Linux
  kernel in the browser.
- Boot **Alpine 3.21 i386** as the default image, with `git`, `python3`, `py3-pip`,
  `nodejs`, `npm`, and `ripgrep` pre-baked at image build time.
- Wrap it in `V86VMHandle`, which implements the backend-agnostic `VMHandle` interface
  so the agent layer never depends on v86 directly.
- Freeze the image in v0.1: no runtime `apk add`, no VM network. Package installs become
  an opt-in v1.0 feature.
- Persist the guest with v86's snapshot API (`save_state()` / `restore_state()`), with a
  tar-over-serial fallback if the API proves unreliable.

## Alternatives considered

| Alternative | Verdict |
|---|---|
| **WebContainers (StackBlitz)** | Not a Linux VM. It is a Node.js runtime in the browser: no `bash`, no `git`, no general POSIX userland, and a proprietary runtime we do not control. It cannot satisfy "real Linux" or the package-manager requirement. |
| **Pyodide + Emscripten** | Runs Python in WASM, but it is not a general Linux environment. No native toolchain, no `apk`/package manager, no persistent POSIX filesystem, and no path to running arbitrary Linux binaries. It is a Python interpreter, not a VM. |
| **QEMU compiled to WASM** | The right idea, but there is no maintained browser build, no npm package, and no integration story (screen, serial, filesystem, snapshots). Building and maintaining a QEMU-WASM toolchain is out of scope for a solo team. |
| **JSLinux (Fabrice Bellard)** | The reference browser Linux emulator, but it is not embeddable as a library and is not licensable for this use. There is no maintained package or documented API for snapshots, serial control, or custom images. |
| **TinyEMU (RISC-V)** | Not x86. There is no mature 32-bit x86 toolchain or package ecosystem for it, and it is a niche research project. |

## Consequences

### Positive

- **Real Linux, not a shim.** Any i386 userspace that runs on Alpine works: `bash`, `git`,
  `python3`, `nodejs`, and the Alpine package ecosystem.
- **Runs anywhere.** Pure WASM + JS, no plugins, no host installation.
- **Persistence is solved.** v86 exposes `save_state()` / `restore_state()`, so VM
  snapshots fit the IndexedDB persistence layer directly.
- **Size fits the budget.** The Alpine image with pre-baked tooling is ~40–60 MB
  compressed, inside the < 100 MB single-file target.

### Negative (accepted constraints)

- **32-bit only.** v86 emulates a ~Pentium 4-class CPU with **no x86-64 extensions**.
  Native 64-bit binaries (esbuild, swc, sharp, Prisma engines) will not run. Pure-JS
  and WASM packages work. This is recorded in `VM_CONSTRAINTS` (`arch: 'ia32'`,
  `bits: 32`) and enforced by the `VMImage.arch` type.
- **Single-core.** There is **no multicore**; `make -j` is pointless and compiles are
  single-threaded and slow (TCG is ~5–20× slower than native). The constraint is recorded
  in `VM_CONSTRAINTS` (`cores: 1`).
- **Pre-baking is a correctness requirement, not just a size optimization.** Because there
  is no runtime network in v0.1 and no 64-bit fallback, every tool the agent needs must be
  present in the image before it ships.
- **Upstream maintenance risk.** v86 is a single-maintainer project. A stall or a
  security issue in the emulator directly affects GhostShell.
- **Shrinking 32-bit ecosystem.** Modern distributions are dropping 32-bit support, so
  the project is pinned to the Alpine x86 / Debian i386 era.

### Mitigations

- **WASM-first tooling.** Prefer `ripgrep-wasm`, `esbuild-wasm`, `quickjs`, and `tcc`
  for hot paths so the emulated CPU is not the bottleneck.
- **Pin and vendor.** Pin the exact v86 version, vendor the WASM and build files, and
  monitor upstream security issues.
- **Keep the seam.** `VMHandle` isolates the agent from v86. If a 64-bit or multicore
  browser VM becomes viable, it can be added as a second implementation without touching
  the agent loop, tools, or UI.
- **Design inside the box.** Do not plan features that assume 64-bit or parallel builds;
  scope v0.1 to scripting tasks and set user expectations in the UI.

## Status

**Accepted.** v86 is the only embeddable, licensable, maintained full-system browser
emulator that meets the "real Linux in one file" premise. The 32-bit, single-core, and
single-maintainer constraints are accepted and documented rather than deferred.
