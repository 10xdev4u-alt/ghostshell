# 👻 GhostShell

> A single static HTML file that runs an AI coding agent entirely in your browser.
> Real Linux VM. Local LLM. No server. No account. $0.

[![CI](https://github.com/10xdev4u-alt/ghostshell/actions/workflows/ci.yml/badge.svg)](https://github.com/10xdev4u-alt/ghostshell/actions/workflows/ci.yml)
[![Coverage: >= 80% policy](https://img.shields.io/badge/coverage-%3E%3D80%25-green)](https://github.com/10xdev4u-alt/ghostshell/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

<!-- The coverage badge above states the project policy (>= 80%), not a
     measured number: publishing real coverage needs a Codecov token. To
     regenerate the real number locally, run `bun run coverage:report`; the
     gated run that CI enforces is `bun run test -- --coverage` (see the Test
     job in .github/workflows/ci.yml). -->

---

## What is GhostShell?

Open one HTML file. Get a chat with an AI that runs **real commands in a real
(emulated) Linux box**, with the model running **on your machine**.

- 🖥️ **Real Linux VM** — [v86](https://copy.sh/v86/) x86 emulator, Alpine 3.21 i386
- 🧠 **Local LLM** — [Transformers.js](https://huggingface.co/docs/transformers.js) / [WebLLM](https://webllm.mlc.ai), 1.5B–3B quantized
- 🔒 **No server, no account, no telemetry** — the only network calls are the app's own boot and model assets
- 📦 **One file** — the whole app, including the v86 WASM, inlines into a single `index.html`

### Why?

| Cloud agents | GhostShell |
|---|---|
| $20/mo subscription | $0 |
| Code leaves your machine | Code never leaves |
| Requires install / account | One file, any browser |
| Opaque privacy policy | Verifiable egress log + signed report |

## Quick start

```bash
git clone https://github.com/10xdev4u-alt/ghostshell
cd ghostshell
bun install
bun run dev          # http://localhost:5173
```

Build the single file:

```bash
bun run build:single # dist/single/index.html (~59 MB with inlined assets)
```

Host it anywhere static (Netlify, Cloudflare Pages, GitHub Pages). For threaded
WASM, the host must send `COOP: same-origin` and `COEP: require-corp`.

### Network lockdown

Airplane mode (the default) patches `fetch`, `WebSocket`, `XMLHttpRequest`,
`EventSource`, and `sendBeacon`. Every request is logged to the privacy report;
anything that is not one of the app's own boot or model assets is blocked.
The allowlist exists because GhostShell cannot boot or load a model without
it: `copy.sh` (v86 BIOS and VGA BIOS), `huggingface.co` and `*.hf.co` (model
weights and the HF Xet CDN), `cdn.jsdelivr.net` (the ONNX runtime), and
`data:` (the inlined v86 WASM). Lockdown blocks application egress, not the
app booting itself. The list mirrors the CSP `connect-src` and lives in
`BOOT_EGRESS_ALLOWLIST` (`src/core/security/egress.ts`).

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│ Browser (one tab)                                        │
│                                                          │
│  ┌──────────────┐   events   ┌────────────────────────┐  │
│  │ UI           │◄──────────►│ Agent loop             │  │
│  │ chat/terminal│            │ observe→think→act      │  │
│  │ filetree/diff│            └──────────┬─────────────┘  │
│  └──────────────┘                       │                │
│  ┌──────────────┐             ┌─────────▼──────────┐     │
│  │ Persistence  │             │ LLM engine         │     │
│  │ IndexedDB/   │             │ Transformers.js /  │     │
│  │ OPFS         │             │ WebLLM             │     │
│  └──────────────┘             └─────────▲──────────┘     │
│                                        │                │
│                             ┌──────────┴──────────┐     │
│                             │ v86 VM             │     │
│                             │ Alpine i386         │     │
│                             │ bash/git/node/rg   │     │
│                             └─────────────────────┘     │
└──────────────────────────────────────────────────────────┘
```

See [`docs/ENGINEERING_PLAN.md`](docs/ENGINEERING_PLAN.md) for the full spec and
[`docs/CREATIVE_INNOVATION.md`](docs/CREATIVE_INNOVATION.md) for the roadmap.

## Status

**v0.1 (in progress).** The scaffold, domain model, and CI are in place. The
agent loop, v86 integration, and LLM engine are being implemented in the open,
one PR at a time. See [issues](https://github.com/10xdev4u-alt/ghostshell/issues).

| Capability | v0.1 | v1.0 |
|---|---|---|
| VM | Alpine, pre-baked, no network | opt-in network, offline package cache |
| LLM | 1.5B–3B, WASM | 3B–8B, WebGPU fast path |
| Tools | bash, read_file, write_file, list_dir, search | + edit_file, ask_user |
| Persistence | conversations + VM snapshot | export/import, per-session snapshots |
| UI | chat, terminal, settings | + diff, file browser, multi-session |

## Contributing

We build in the open, the agentic way: every change is an issue → branch → PR →
review → merge. See [CONTRIBUTING.md](CONTRIBUTING.md).

```bash
bun run typecheck   # tsc --noEmit
bun run test        # vitest
bun run build       # vite build
```

### End-to-end VM test

`tests/e2e/vm-boot.spec.ts` boots the real v86 emulator in headless Chromium
and runs `echo hello` through the app's serial command path.

```bash
bun run image:build # build images/alpine-fs.json (requires Docker)
bun run test:e2e
```

The test needs the Alpine 9p rootfs, the v86 WASM, and reachability of
`copy.sh` for the BIOS. If any of those is absent it skips with a message;
a boot failure with all prerequisites present is a real test failure. CI runs
the suite headless in a separate job, so a slow VM boot cannot fail the fast
unit-test gate.

## License

[MIT](LICENSE).
