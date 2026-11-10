# GhostShell — Creative Innovation & 10x Directions

> A brainstorm + research report on top of `GhostShell-Engineering-Plan.md`.
> Goal: find directions that make GhostShell 10x more valuable and delightful, without losing the thing that makes it special — one static file, real Linux, local model, no account, $0.

**Reading guide**

- **[VERIFIED]** — confirmed against primary sources fetched for this report (v86 docs/README, WebLLM README, Transformers.js docs, MCP docs, WISP protocol README).
- **[SPECULATIVE]** — plausible but unproven; needs a spike or is a bet on a trend.
- **[UNVERIFIED]** — asserted by the plan but not yet tested.

---

## 0. Research Findings That Should Change the Plan

These are not ideas; they are corrections and upgrades to the engineering plan, grounded in current upstream docs.

### 0.1 v86 networking is not "relay or nothing"

The plan says v86 networking needs a third-party WebSocket relay. Current v86 ships **four** backends (`copy/v86` → `docs/networking.md`) **[VERIFIED]**:

| Backend | Transport | External internet? | Server required? |
|---|---|---|---|
| `inbrowser` | `BroadcastChannel` between tabs/windows | **No** | **None** |
| `fetch` | Browser `fetch()` | Yes (HTTP only) | No relay; a CORS proxy for arbitrary hosts |
| `wisp` | WISP protocol over WebSocket | Yes (TCP) | WISP proxy (self-hostable, incl. Cloudflare Workers) |
| `wsproxy` | Raw Ethernet over WebSocket | Yes (full L2) | Proxy (self-hostable, Docker) |

**Why this matters**

- A **truly serverless** mode exists: `inbrowser` gives multi-VM networking with zero external network and zero servers. `fetch` gives the VM HTTP access with no relay, and can even reach the host's `localhost` via `http://<port>.external` **[VERIFIED]**.
- The "no server" promise can be **honest and functional**: network off by default, with an opt-in mode that either (a) uses `fetch` for package installs against CORS-friendly mirrors, or (b) uses a **self-hosted** `wisp`/`wsproxy` relay the user runs themselves. The third-party relay becomes an explicitly labelled convenience, not a hidden dependency.
- This also unlocks "the VM can talk to your host dev server" — huge for real work.

### 0.2 v86 is 32-bit only and single-core — a bigger constraint than the plan admits

v86's README is explicit **[VERIFIED]**:

- CPU is ~Pentium 4 level with SSE3.
- **No 64-bit extensions.**
- **No multicore.**

The official Alpine image is built from `i386/alpine:3.21.0` with `nodejs` from Alpine's 32-bit repos **[VERIFIED]**. So `nodejs` is available, but:

- npm packages with native 64-bit binaries (esbuild, swc, sharp, Prisma engines, etc.) **will not run**.
- Pure-JS and WASM packages work fine.
- `make -j` is pointless; compiles are single-threaded and slow.
- Modern distros are dropping 32-bit; you are pinned to Alpine x86 / Buildroot / Debian i386 era.

**Why this matters:** "pre-bake everything" is not just a size optimization, it is a **correctness requirement**. The plan should say so, and should treat WASM-first tooling (ripgrep, esbuild-wasm, quickjs, tcc) as the escape hatch for speed.

### 0.3 v86 has a programmable 9p filesystem — persistence can be dramatically better

`docs/filesystem.md` **[VERIFIED]** describes three 9p modes:

1. **JSON/HTTP filesystem** — files loaded on demand from a base URL into an in-memory JS filesystem.
2. **Function handler** (`handle9p`) — a custom 9p server implemented in JavaScript.
3. **WebSocket proxy** — back 9p with any WS server.

**Why this matters:** the plan's persistence fallback is `tar czf | base64` over serial — slow and all-or-nothing. A custom 9p backend over **OPFS/IndexedDB** gives structured, incremental, copy-on-write persistence. It also enables a **host-directory bridge**: expose a directory the user picks with the File System Access API, mounted into the VM at `/mnt/host`, so the agent edits the user's real repo without a copy step. This is the single highest-leverage infrastructure upgrade available.

### 0.4 WebLLM already supports the two things the plan marks "nice-to-have"

WebLLM's README **[VERIFIED]**:

- **SRI integrity verification** for model artifacts (config, WASM, tokenizer) — so "pin sha256" is available today, not a maybe.
- **Cache backends**: `cache`, `indexeddb`, `opfs` — OPFS is faster for large blobs.
- **JSON mode** structured generation, implemented in WASM.
- **Function calling** (WIP) and manual function calling.
- **Web Worker and Service Worker** engines.

**Why this matters:** the plan's Risk #1 is "small models cannot reliably emit valid tool calls." The strongest fix is not better prompting — it is **grammar-constrained decoding**. WebLLM's JSON mode, llama.cpp's GBNF grammars, and libraries like Outlines/XGrammar can force the model to emit a valid tool-call object. That converts a probabilistic parse into a guaranteed parse. This should be the default v0.1 tool-call strategy, with Hermes XML as a fallback.

### 0.5 MCP is a live, open plugin standard — the obvious ecosystem play

`modelcontextprotocol.io` (docs dated 2026-07-28) **[VERIFIED]** describes MCP as a "USB-C port for AI applications," supported by Claude, ChatGPT, VS Code, and Cursor, with **MCP Apps** (interactive apps inside AI clients) and a security guide.

**Why this matters:** GhostShell should be an **MCP client**. Community tool servers become GhostShell plugins with almost no wrapper work. MCP is to agents what npm is to JavaScript — riding it is better than inventing a parallel plugin format.

### 0.6 The WISP ecosystem is a ready-made browser-networking community

WISP v2 proxies TCP/UDP over a single WebSocket **[VERIFIED]**. Implementations include `wisp-js`, `epoxy-tls` (Rust), `wisp-server-python`, and `wisp-server-workers` (Cloudflare Workers). Users include **v86, Puter, libcurl.js, Wasmer SDK, Scramjet, Whisper, Wispcraft**.

**Why this matters:** GhostShell can offer "self-host a relay in a Worker" or "run a local wisp-js relay" as a privacy-respecting network option. Puter (open-source browser OS) is the closest spiritual cousin and a useful playbook — it uses v86 + WISP for exactly this kind of in-browser computing.

---

## 1. Wild Feature Ideas (20)

Each entry: concept, why it's unique, feasibility, inspiration.

### 1.1 Twin-View: Agent and Raw VM, Synchronized

**Concept.** Two panes, one source of truth. The left pane is the chat/tool-call view; the right is a live serial terminal. Every tool call highlights the exact serial bytes that produced it; clicking a terminal line jumps to the originating tool card. A shared cursor and a "you are here" marker keep them in lockstep.

**Why it's unique.** Every coding agent hides the terminal; every terminal hides the agent. Twin-View makes the agent's actions *legible* and debuggable, which is the difference between "trust me" and "verify me." It also turns the raw terminal into a first-class artifact instead of a hidden log.

**Feasibility. High.** xterm.js + a serial event log + a small sync layer. No model work.

**Inspiration.** Time-travel debuggers (Redux DevTools, rr), Chrome DevTools' Sources/Network linking, `asciinema` + commentary.

### 1.2 Time-Travel VM: Fork Any Moment

**Concept.** Every tool call (or every N seconds) captures a lightweight VM snapshot and a filesystem diff. A timeline slider lets you scrub backward, replay the session, and **fork** from any point to try a different approach — like git branches for the whole machine.

**Why it's unique.** Agents are fundamentally non-deterministic and often wrong. "Undo the last 3 steps" is table stakes; "branch the entire VM at step 7 and try the other fix" is not something Claude Code or Cursor offer. It turns failure into exploration.

**Feasibility. Medium.** Needs cheap incremental snapshots (see 1.3 / 6.4) and a UI. Full RAM state images are heavy; filesystem-level CoW is the way.

**Inspiration.** Git, `rr` record/replay, Redux DevTools time travel, Claude Code's fork session, asciinema.

### 1.3 Multi-VM Mesh: A Cluster in One Tab

**Concept.** Spawn N Alpine VMs that talk to each other over a virtual Ethernet using v86's `inbrowser` backend (BroadcastChannel). One VM runs the app, one runs Postgres/Redis, one is a "red team" attacker, one is a client load generator. The agent orchestrates the whole mini-datacenter.

**Why it's unique.** Nobody ships a multi-node distributed system in a browser tab. It makes GhostShell a lab for networking, distributed systems, security, and infra — not just a code editor. And it needs **no servers at all** **[VERIFIED]**.

**Feasibility. Medium-High.** v86 already supports two-instance networking; the work is lifecycle, UI, and serial routing for N VMs.

**Inspiration.** v86 `examples/two_instances.html`, `env86`, minikube/k3s, GNS3/Packet Tracer, Docker Compose.

### 1.4 Host Bridge: Edit the Real Repo, Preview the Real Dev Server

**Concept.** Two bridges. (a) A host directory chosen via the File System Access API is mounted into the VM through a custom 9p backend at `/mnt/host`; the agent edits your actual files. (b) The VM reaches your host's `localhost` dev server via v86's `fetch` backend (`http://<port>.external`). Round trip: edit real files → run real dev server → see real result.

**Why it's unique.** Most browser agents are sandboxes you copy code into and out of. GhostShell becomes a *shell over your actual workstation* while keeping the VM as the security boundary.

**Feasibility. Medium.** Custom 9p handler + File System Access API; v86 `fetch` backend already supports host localhost **[VERIFIED]**. Watch out for write coherence and symlinks.

**Inspiration.** WSL2, Docker Desktop file sharing, VS Code Remote, QEMU 9p/virtfs, `sshfs`.

### 1.5 Explain-This / Socratic Mode

**Concept.** Every command output, error, and diff gets an "Explain" button that sends the command + output to the model and returns a plain-language explanation: what it did, why it failed, what to try next. A "Teach me" mode turns the whole session into a lesson plan with quizzes.

**Why it's unique.** The plan lists "learner" as a user story but ships no learning mechanics. This turns every debugging session into a tutoring session — and it is the same model, so it costs almost nothing.

**Feasibility. High.** One more LLM call with a focused prompt and the current context.

**Inspiration.** Socratic tutoring apps, "rubber duck debugging," ExplainGPT, Feynmann technique, Duolingo tips.

### 1.6 Artifact Panel: Render What the Agent Builds

**Concept.** The agent can emit HTML/SVG/Canvas/Three.js/Markdown artifacts that render in a sandboxed side panel. Charts, UI mockups, games, diagrams, and data visualizations appear next to the chat, live.

**Why it's unique.** Code agents output text; GhostShell can output *running things*. This unlocks data science, game dev, education, and design — and makes the agent feel magical ("it built me a thing I can touch").

**Feasibility. High.** Sandboxed iframe + a tiny artifact protocol + a "Preview" tab. Security: no `allow-same-origin`, strict CSP, no network unless opted in.

**Inspiration.** Claude Artifacts, ChatGPT Canvas, Observable, Jupyter widgets, IPython.display, StackBlitz previews.

### 1.7 Skill / Recipe Packages

**Concept.** Shareable, versioned packages that bundle a system-prompt fragment, tool definitions, few-shot examples, a VM setup script, and an eval suite. Examples: "Django debugging recipe," "React + Vite scaffold," "Postgres query tuner," "CTF pwn starter."

**Why it's unique.** Prompts are the new code, and they are currently copy-pasted as text. Packaging them — with setup and tests — makes agent capability a community artifact, not a private trick.

**Feasibility. High.** A manifest (JSON) + prompt (Markdown) + setup script (bash) + optional tools (JSON Schema). Install = download + run setup in VM + merge prompt.

**Inspiration.** MCP servers, GPTs, Claude Projects, Cursor rules, Aider conventions, Homebrew formulas, npm packages.

### 1.8 Native MCP Client

**Concept.** Implement the Model Context Protocol in GhostShell. Browse an MCP marketplace, install servers, and run them either in a Web Worker or inside the VM (Node). MCP Apps render inside the artifact panel.

**Why it's unique.** It plugs GhostShell into the fastest-growing agent tool ecosystem instead of reinventing it. "USB-C for AI" is a genuine standard now **[VERIFIED]**.

**Feasibility. Medium-High.** MCP is JSON-RPC over stdio/SSE/HTTP; tunneling over serial or in-worker is straightforward. Permissions and sandboxing are the hard part.

**Inspiration.** MCP, Claude Code, Cursor, VS Code, Playwright MCP, MCPJam.

### 1.9 Red-Team / Adversarial Review Mode

**Concept.** A second agent (same model, different prompt, or a separate "verifier" pass) attacks the first agent's work: finds bugs, security holes, edge cases, missing tests, and accessibility problems. It produces a prioritized report and can auto-fix.

**Why it's unique.** Most agents are single-threaded and sycophantic. A built-in adversary makes the output better and gives users a "what could go wrong" briefing — a genuine safety feature.

**Feasibility. High.** Prompt + tools + the existing diff/artifact views. Runs best after a change lands.

**Inspiration.** Red-teaming, fuzzing, CodeQL, OWASP, adversarial multi-agent research, "pre-mortems."

### 1.10 Model Council / Ensemble with Confidence

**Concept.** Load two or three small models (Qwen2.5-1.5B, SmolLM2-1.7B, Phi-3-mini, Mistral-7B on strong GPUs). For important steps, have them vote or debate; show a confidence meter; route tasks by measured competency.

**Why it's unique.** Local models are weak individually; a council is often much stronger, and the confidence signal is something cloud agents hide from you. It also gives GhostShell a research identity: "the ensemble agent."

**Feasibility. Medium.** Memory is the constraint; models can be swapped, not all resident. A "debate" can be sequential with hidden intermediate answers.

**Inspiration.** LLM juries/debate (Du et al.), mixture-of-experts, LangGraph multi-agent, ensemble methods.

### 1.11 Speculative Tool Execution

**Concept.** A cheap "draft" model proposes the next several tool calls; a larger "verifier" model (or the same model with a checker prompt) validates them before execution. Or: run multiple candidate commands in parallel in cloned VM states and let the model pick the winner.

**Why it's unique.** Speculative decoding is a server-side technique; applying it to *tool calls* — where a bad call costs a VM round-trip — is a genuine twist. It directly attacks latency and reliability at once.

**Feasibility. Medium-Low.** [SPECULATIVE] for the parallel-clone version; the draft/verify version is just prompt engineering and is feasible now.

**Inspiration.** Speculative decoding (DeepMind), speculative execution in CPUs, tree-of-thoughts, parallel test runners.

### 1.12 Commit Coach

**Concept.** At any point, the agent can generate a conventional commit, a PR title/body, a changelog entry, and a release note from the session log — then commit in the VM with one click. It learns the user's commit style over time.

**Why it's unique.** The gap between "agent did work" and "work is documented" is where good engineering goes to die. This is a small feature with outsized daily value.

**Feasibility. High.** Prompt + `git` in the VM + a UI button.

**Inspiration.** Conventional Commits, semantic-release, PR bots, `git commit` templates.

### 1.13 Voice Mode (In-Browser ASR + TTS)

**Concept.** Push-to-talk input via Whisper.cpp WASM or Transformers.js ASR; spoken summaries via TTS. "Walk me through what you just did." Hands-free operation while reading code or debugging hardware.

**Why it's unique.** Voice is table stakes in consumer AI but absent from coding agents, which are intensely visual. A privacy-first, offline voice layer is a genuine differentiator.

**Feasibility. Medium.** Both ASR and TTS pipelines exist in Transformers.js **[VERIFIED]**; whisper.cpp has WASM builds. Latency and model size are the constraints.

**Inspiration.** Whisper, voice assistants, push-to-talk in Discord/Tesla, Transformers.js ASR/TTS pipelines.

### 1.14 Gesture Mode

**Concept.** MediaPipe Hands / TensorFlow.js handpose: pinch to run, swipe left to undo, point at a line to select it, "air draw" a UI sketch that the agent implements. Optional and clearly labelled.

**Why it's unique.** No coding agent ships gesture control. It is a wow demo and genuinely useful for presentations, teaching, and accessibility.

**Feasibility. Medium.** Camera + WASM hand tracking; privacy-sensitive, so opt-in with a visible indicator.

**Inspiration.** MediaPipe Hands, Vision Pro gestures, Leap Motion, Minority Report interfaces.

### 1.15 Ambient / Background Agent

**Concept.** The VM and agent keep running when the tab is backgrounded (Service Worker + notifications). Schedule tasks ("run the test suite every 30 minutes", "watch this log and alert me"), get notified on completion or failure.

**Why it's unique.** Coding agents are synchronous and attention-hungry. An ambient agent that does chores while you do something else is a different product category — closer to a junior teammate than a chat box.

**Feasibility. Medium.** Browser throttling and service worker lifecycles are the constraints; notifications and periodic background sync help. [SPECULATIVE] on reliability.

**Inspiration.** cron, GitHub Actions, IFTTT/Zapier, always-on assistants, n8n.

### 1.16 Multiplayer Sessions

**Concept.** Two or more humans plus agents in the same VM/session: presence avatars, shared cursors, a shared chat, and per-person permissions. One person drives, another reviews, the agent executes.

**Why it's unique.** Pair programming exists; *pair agent programming* with live presence does not. It also makes GhostShell a teaching and interview tool.

**Feasibility. Medium.** CRDTs (Yjs/Automerge) + WebRTC/PartyKit/Liveblocks, or a tiny relay. Local-first sync keeps it privacy-respecting.

**Inspiration.** Figma multiplayer, tldraw, Excalidraw, Liveblocks, Yjs, PartyKit.

### 1.17 Gamified Quests & Repo Dungeon

**Concept.** Turn tasks into quests with XP, streaks, achievements, and a map of the codebase as a dungeon that fills in as you explore and fix it. The agent levels up "skills" as it successfully uses tools; share achievements.

**Why it's unique.** It makes the *process* of coding with an agent rewarding, not just the output. It is also a great onboarding mechanic and a gentle way to teach tool use.

**Feasibility. High.** UI + local stats + a quest definition format. Pure delight, no research risk.

**Inspiration.** Duolingo, GitHub contribution graph, Habitica, Codewars, habit trackers.

### 1.18 Deterministic Replay

**Concept.** Expose a seed for the model and a checkpoint for the VM. Any session can be replayed byte-for-byte: same tokens, same commands, same outputs. "Replay this session" becomes a debugging and auditing primitive.

**Why it's unique.** Reproducibility is a superpower for agents: bug reports become replays, not descriptions. Cloud agents cannot offer this because you don't control the stack.

**Feasibility. Medium.** Model seeding is supported in some engines; VM state is checkpointable; timing and tokenizer nondeterminism are the hard parts. [SPECULATIVE] for full determinism.

**Inspiration.** Seedrandom, deterministic testing, replay debugging, Nix reproducibility, `git bisect`.

### 1.19 Privacy Attestation: "0 Bytes Left Your Machine"

**Concept.** A lockdown mode that disables all egress, logs every network attempt, and produces a signed report: HTML hash, model hash, VM image hash, dependency list, network log, timestamp. A visible "airplane mode" indicator. Export the report as evidence.

**Why it's unique.** Privacy claims are usually marketing. A *verifiable, signed, inspectable* privacy report is a trust artifact — useful for enterprises, journalists, lawyers, and regulators.

**Feasibility. High.** CSP + no relay + an egress log + WebCrypto signing. The report format is the main design work.

**Inspiration.** Reproducible builds, Sigstore/SLSA provenance, Apple App Attest, network inspectors, audit logs.

### 1.10 On-Device Personalization [SPECULATIVE]

**Concept.** Collect the user's corrections, preferences, and accepted/rejected suggestions. Use them to build a preference memory, rank skills, and eventually fine-tune a LoRA adapter on-device (or export a dataset for offline fine-tuning). "The more you use it, the more it's yours."

**Why it's unique.** Cloud agents learn about you opaquely and share it across users. A local agent that visibly improves *for you alone* — with the data never leaving — is the local-first AI pitch taken seriously.

**Feasibility. Low-Medium.** Preference memory is easy; on-device LoRA for a 1.5B model in a browser is heavy but not impossible with WebGPU. Start with memory + ranking; fine-tuning is a v2 bet.

**Inspiration.** Federated learning, on-device personalization (Apple), local-first software (Ink & Switch), RLHF/RLAIF.

### Rapid-fire: 10 more

- **WebUSB / WebSerial / WebHID Bridge** — the VM can't do USB, but the host browser can; let the agent flash an Arduino or debug a sensor. [SPECULATIVE] **Feasibility: Medium.**
- **Accessibility Auditor** — the agent builds a page, then runs axe-core inside the artifact iframe and fixes its own violations. **Feasibility: High.**
- **Field Kit** — pre-download a model + curated package cache; work fully offline on a plane; sync when back. **Feasibility: High.**
- **Digital Twin Dev Environment** — import dotfiles, shell history, and editor settings to bootstrap a VM that feels like your machine. **Feasibility: Medium.**
- **Agent-Generated Tests as First-Class Output** — every change ships with generated tests, run in the VM, with coverage. **Feasibility: High.**
- **Multi-Audience Explanations** — one answer at ELI5 / junior / senior / exec levels. **Feasibility: High.**
- **Session Replay Sharing** — export a session as a self-contained HTML replay (asciinema-style) to share. **Feasibility: High.**
- **Cost-Saved Meter** — "you saved $X vs. an API" + token budget UI. **Feasibility: High.**
- **"What Would Go Wrong?" Briefing** — a pre-flight risk report before executing a plan. **Feasibility: High.**
- **Agent-Designed UI Sketches** — point at a rough camera sketch; the agent turns it into HTML/CSS in the artifact panel. **Feasibility: Medium.**

---

## 2. UX Innovations: Making the Agent Feel Magical

The goal is not "more features" but *felt quality*: legible, responsive, trustworthy, and occasionally delightful.

### 2.1 Interaction modalities

| Pattern | What it feels like | Feasibility | Notes |
|---|---|---|---|
| **Twin-View sync** (1.1) | "I can see exactly what it did." | High | The single biggest trust win. |
| **Voice push-to-talk** (1.13) | "It hears me and talks back." | Medium | Whisper.cpp WASM / Transformers.js ASR. |
| **Gestures** (1.14) | "I can conduct it." | Medium | Opt-in camera; visible indicator. |
| **Ambient + notifications** (1.15) | "It works while I live." | Medium | Service Worker limits apply. |
| **Multiplayer presence** (1.16) | "We're in the machine together." | Medium | CRDT + WebRTC. |
| **Gamified quests** (1.17) | "I want to keep going." | High | Pure UI. |
| **Command palette** | "I can ask in my own words." | High | Slash commands + natural language mapping. |
| **Persona picker** | "It matches my mood." | High | Concise / verbose / Socratic / exec. |

### 2.2 Micro-interactions that signal competence

- **Confidence heat-map** on tool calls: green = verified by a test/diff, yellow = executed, red = failed/retried. Users learn to read the agent's certainty at a glance.
- **Live token and cost counters**: tokens in flight, tokens this session, estimated API cost saved. Turns "free" into a felt benefit.
- **Step-level undo**: undo a single file write or command, not just the whole turn.
- **"Narrating the diff"**: the agent tells a story of the change ("I moved the fetch into a hook because the component re-rendered 4×"). Diff as narrative.
- **Silent mode / focus mode**: hide the terminal, show only a spinner and a final summary. For users who want the answer, not the show.
- **Ambient sound** (optional, accessible): a soft tick on tool completion, a chime on success. Off by default, with a mute.
- **Reduced-motion support**: honor `prefers-reduced-motion` for all animations.
- **Keyboard-first**: every action reachable by keyboard; `/` opens the palette; `Ctrl+.` explains the last output.
- **"You are here" scroll marker**: the view auto-scrolls during generation but yields when the user scrolls up.

### 2.3 Trust UX

- **Permission prompts** for new capabilities (network, camera, host directory), with "allow once / always / never" and a permission log.
- **Egress indicator**: a persistent "network: off" badge; when on, a live counter of bytes sent/received.
- **Verify button**: re-hash the running HTML against the published sha256 and show "this is the code we published."
- **Audit log view**: a hash-chained, exportable list of every command and tool call.
- **Ephemeral mode**: "leave no trace" — no persistence, wipe on close, like a private browsing session for agents.

### 2.4 Onboarding that teaches

- A 60-second interactive tour: "This is a real Linux VM. This is a real model. This is what 'no server' means."
- A **first-run quest**: "Fix the intentionally broken test in `/root/workspace/demo`" — a guaranteed win that exercises bash, read, write, and tests.
- A **model picker with honest labels**: "Fast & good (1.5B)", "Smarter & slower (3B)", "Best on GPU (7B)" — with local eval scores, not vibes.

---

## 3. Ecosystem / Plugin Ideas

### 3.1 The three marketplaces

1. **Recipes (skills)** — prompt + tools + setup + evals. The lightweight, community-driven layer.
2. **MCP servers** — the standard tool protocol. GhostShell is a client; servers run in a Worker or in the VM.
3. **Images / profiles** — pre-baked VM images for domains (minimal, full, data science, security, game dev, education).

Optionally: **models** (model cards + eval scores + one-click download) and **worlds** (shareable, signed VM snapshots).

### 3.2 Recipe format (sketch)

```json
{
  "name": "django-debugger",
  "version": "1.2.0",
  "description": "Debug Django apps with logging, shell, and test isolation.",
  "license": "MIT",
  "author": "...",
  "prompt": "prompt.md",
  "tools": ["bash", "read_file", "write_file", "search"],
  "fewShot": "examples.json",
  "setup": "setup.sh",
  "evals": "evals.json",
  "integrity": { "sha256": "..." }
}
```

Install = verify hash → run `setup.sh` in the VM → merge `prompt.md` into the system prompt → register tools. Uninstall = reverse. Everything is inspectable.

### 3.3 MCP integration

- **Transports**: in-VM stdio over serial (Node MCP server), in-Worker (Web Worker), or HTTP/SSE (opt-in network).
- **Marketplace**: browse, install, enable per-session, with permission prompts.
- **MCP Apps**: render interactive UI inside the artifact panel.
- **GhostShell as an MCP server**: expose the VM's bash/file tools to *other* agents (Claude Code, Cursor) — "use my local VM from your agent." This is a clever inversion and a growth channel.

### 3.4 Plugin SDK and sandbox

- Plugins run in a **Web Worker** with a capability token (e.g., `fs:/root/workspace`, `net:off`, `camera`).
- A typed `ToolDefinition` API: name, description, JSON Schema, `execute(ctx, args)`.
- Permission prompts are explicit and logged.
- Signed plugins: SRI hash + optional maintainer signature.
- No `eval`; no dynamic script injection; no host access without a bridge.

### 3.5 Host bridges (the unique ecosystem angle)

| Bridge | What it enables | API |
|---|---|---|
| File System Access | Mount a real host directory in the VM | Custom 9p backend |
| WebSerial / WebUSB / WebHID | Flash microcontrollers, debug sensors, drive lab equipment | Serial/USB bridges into the VM |
| Localhost fetch | VM talks to host dev servers | v86 `fetch` backend |
| WebGPU | Share the GPU with the LLM and artifacts | Browser-native |

This is what turns GhostShell from "a sandbox" into "a shell over your machine."

### 3.6 Community and governance

- **Recipe/VM registries**: community-run, with ratings, hashes, and reproduction steps.
- **Certification**: "GhostShell Certified" images and plugins that pass an eval suite and security review.
- **Bounties**: paid bounties for recipes, bug fixes, and audits.
- **Foundation**: a non-profit to hold trademarks, funds, and the eval suite (Blender/GNOME model).
- **Upstream-first**: sponsor/contribute to v86, WebLLM, Transformers.js, WISP — GhostShell is built on them.
- **Annual report**: public finances, public roadmap, public eval leaderboard.

---

## 4. Use-Case Expansions

GhostShell's core is "a local agent in a real Linux box." That core generalizes further than coding.

| Domain | What GhostShell becomes | What changes | Example recipes |
|---|---|---|---|
| **Education** | A patient, offline coding tutor | Socratic mode, quizzes, curriculum metadata, auto-grading, "explain this concept," safe sandbox | `python-basics`, `algo-visualizer`, `cs50-lab` |
| **Data science** | A local Jupyter that can *do* things | Pre-bake pandas/numpy/scipy; artifact panel for charts; CSV upload via host bridge; notebook export | `eda-starter`, `stats-tests`, `duckdb-wasm` |
| **Sysadmin / DevOps** | A disposable infra lab | Multi-VM mesh, log analysis, config linting, "diagnose this server," cron/ambient mode | `nginx-tuning`, `postgres-recovery`, `ansible-lint` |
| **Security research** | A safe, disposable malware/range lab | Radare2/gdb/pwntools pre-baked; disposable snapshots; red-team mode; network isolation; CTF quests | `pwn-starter`, `web-ctf`, `malware-sandbox` |
| **Game dev** | A tiny game studio | TIC-80/PICO-8/LÖVE/p5.js; artifact panel as the play window; asset pipeline; "make a game" quests | `pico8-platformer`, `pygame-shooter`, `webgl-demo` |
| **Creative writing** | A distraction-free writing buddy | Minimal tools, markdown/EPUB export, outlining, character sheets, "write in the style of" | `novel-outline`, `poetry-workshop`, `epub-export` |
| **IoT / embedded** | A hardware workbench | WebSerial/WebUSB bridge; MicroPython/Arduino; "blink an LED," "log sensor data" | `arduino-blink`, `esp32-logger`, `sensor-dashboard` |
| **Science / bio** | A local lab notebook | Biopython, sequence analysis, plotting; reproducible runs | `biopython-101`, `pcr-primer-check` |
| **Music / art** | A creative coder | p5.js, Sonic Pi (if 32-bit), shader toys; artifact panel as the canvas | `generative-art`, `shader-toy`, `chiptune` |
| **Accessibility** | An audit-and-fix tool | axe-core in the artifact iframe; the agent audits and repairs its own UI | `a11y-audit`, `wcag-fix` |

**Cross-cutting principle:** each domain is mostly a **profile** (image + tools + recipes + UI defaults), not a fork. One core, many hats.

---

## 5. Privacy / Trust Innovations

Privacy is GhostShell's sharpest differentiator. The opportunity is to make it *verifiable*, not just claimed.

### 5.1 The "Zero-Leak" stack

1. **Lockdown mode**: all egress disabled at the app layer; CSP blocks unexpected connects; v86 NIC off; no relay.
2. **Egress audit log**: every attempted fetch/WebSocket/DNS is logged with timestamp and blocked/allowed status.
3. **Runtime privacy report**: model hash, VM image hash, HTML hash, dependency list, network log, timestamp — signed with WebCrypto and exportable.
4. **Airplane-mode test**: a documented way to verify ("turn on OS firewall / unplug network and show it still works").
5. **Ephemeral mode**: no persistence at all; wipe on close.

### 5.2 Supply-chain trust

- **Reproducible build**: publish a Dockerfile + build script; anyone can rebuild and compare hashes.
- **SRI for model artifacts**: WebLLM supports this today **[VERIFIED]**; use it for config/WASM/tokenizer and pin weights where possible.
- **Signed releases**: Sigstore-style keyless signing; SLSA provenance.
- **Vendored dependencies**: no CDN dependency at runtime.
- **Third-party audit** + bug bounty.

### 5.3 Data lifecycle

- **Local-first by default**: all data in IndexedDB/OPFS; export/import is one click.
- **E2E-encrypted sync** (v1.0, optional): user-held keys; even a hosted sync cannot read your sessions. [SPECULATIVE]
- **PII redaction**: optional scanning of outputs before display/export.
- **No accounts, no telemetry, no analytics**: state it in the README and prove it with the egress log.
- **Hash-chained audit log**: an append-only, tamper-evident record of every agent action — useful for compliance and incident review.

### 5.4 The trust narrative

Position GhostShell as **"the audit-friendly agent."** Not "we promise privacy" but "here is the signed report; verify it yourself." That is a category of one.

---

## 6. Performance / Tech Innovations

### 6.1 Tool-call reliability: grammar-constrained decoding (top priority)

- Use **JSON mode / constrained decoding** to guarantee valid tool calls. WebLLM supports JSON mode; llama.cpp supports GBNF grammars; Outlines/XGrammar are browser-compatible.
- Fallback chain: constrained JSON → Hermes XML → corrective retry.
- Expected effect: parse failures drop from "common with 1.5B" to near zero; retries drop; latency drops.
- This is the highest-impact technical change in the report.

### 6.2 Persistence: 9p + OPFS + copy-on-write

- Custom 9p backend over OPFS (fast, structured) with IndexedDB fallback.
- Copy-on-write snapshots: store only changed blocks/deltas, not 40–80 MB tarballs.
- zstd compression (v86 state images already use zstd **[VERIFIED]**).
- Result: snapshots in milliseconds, not seconds; enables time-travel and host bridge.

### 6.3 Inference speed

| Technique | What it does | Status |
|---|---|---|
| WebGPU + warmup | 3–6× over WASM; hide shader compile behind a splash warmup | [VERIFIED] WebLLM/Transformers.js |
| Prefix / KV cache reuse | Reuse system prompt + tool schema KV across turns and sessions | [SPECULATIVE] in browser runtimes |
| Speculative decoding | Draft model proposes tokens; target verifies | [SPECULATIVE] for browser |
| Persistent KV in OPFS | Don't re-prefill when switching conversations | [SPECULATIVE] |
| Quantization (q4/q3) | Smaller, faster weights | [VERIFIED] supported |
| WebNN backend | New browser neural API | [SPECULATIVE] |
| Worker / Service Worker | Keep UI at 60 fps; keep model alive across visits | [VERIFIED] WebLLM |
| Streaming WASM compile | `instantiateStreaming` with correct MIME | [VERIFIED] standard |
| Model router | Pick the best model per task from local evals | Feasible now |
| Sleep/wake | Suspend VM + release KV when idle; fast resume | Feasible |

### 6.4 VM speed

- **WASM-first tools**: ripgrep-wasm, esbuild-wasm, quickjs, tcc — avoid emulated x86 for hot paths.
- **Pre-baked toolchains**: accept that compiles are slow; set expectations in the UI.
- **Incremental package cache**: offline `.apk`/wheel cache so `pip install --no-index` works.
- **32-bit discipline**: document which npm packages work; prefer pure JS.

### 6.5 Public benchmark harness

Publish `bench/` results as a **local-model leaderboard**: tok/s, first-token latency, memory, tool-call success, task success — per model, per machine tier. This is a community good and a moat: GhostShell becomes the place to find out which local model is actually good at agent work.

---

## 7. Business / Sustainability

OSS with a 1–2 GB model download and a 60 MB HTML file has real costs (bandwidth, storage, CI, support). Options, roughly in order of fit:

| Model | Pros | Cons |
|---|---|---|
| **GitHub Sponsors / Open Collective** | Simple, familiar, recurring | Unpredictable; needs audience |
| **Sovereign Tech Fund / NLnet / MOSS grants** | Funds open digital infrastructure; realistic for this kind of project | Project-based, not salary |
| **Model/CDN sponsorship** | Hugging Face hosts weights; Cloudflare R2 zero egress; a sponsor covers bandwidth | Requires negotiation |
| **Hosted premium** | Sync, multi-session, team features, custom images; revenue funds OSS core | Must not undermine "no server" |
| **Enterprise support / audits** | High margin; privacy audits, custom images, SLAs | Needs reputation |
| **Recipe/plugin marketplace** | Revenue share funds maintainers; network effects | Takes a cut; governance complexity |
| **Certified images** | Paid, pre-built domain images for enterprises | Support burden |
| **Bounties** | Aligns funding with features | Lumpy |
| **Foundation** | Holds assets, funds, trademark; long-term stability | Overhead |
| **Courses / "GhostShell Academy"** | Monetizes education use case | Off-core |

**Recommendations**

1. **Upstream-first sponsorship**: GhostShell depends on v86, WebLLM, Transformers.js, WISP. Sponsor them; it is cheap insurance and good karma.
2. **Transparent finances**: publish income/expenses (Signal/Wikipedia model). Trust is the product.
3. **License deliberately**: MIT/BSD for the core; consider AGPL/SSPL for hosted sync to prevent a cloud provider from offering GhostShell-as-a-service without contributing back.
4. **No VC, no growth-at-all-costs**: the value is trust; a slow, sustainable project is the point.
5. **Hosted premium is the only "server" you should build** — and only after the local product is loved.

---

## 8. "What If" Scenarios

Ten provocations that could redefine the product.

1. **What if the browser becomes the OS?** Chromebooks, Puter, WebVM, and arc are pushing this. GhostShell becomes the default shell for a generation that never installs an IDE.
2. **What if a 3B local model reaches GPT-4-level tool calling?** Distillation + RL + better prompts are closing the gap. GhostShell becomes a free Claude Code — and the privacy story becomes a mass-market story.
3. **What if 16 GB unified memory and WebGPU become baseline?** Then 7B–14B models run comfortably in-browser. The local/cloud quality gap collapses for most tasks.
4. **What if MCP becomes the universal agent plugin standard?** GhostShell rides it as a first-class client and becomes the privacy-first MCP host.
5. **What if regulators mandate AI data provenance?** GDPR/HIPAA/SOX pressure makes "your code never leaves" a compliance feature, not a nicety. GhostShell is the compliant option.
6. **What if a browser vendor ships a built-in LLM API?** WebNN + a platform model. GhostShell either shells over it or is outcompeted on quality — but wins on auditability and openness.
7. **What if the single HTML file becomes the distribution unit for all software?** A portable, auditable, offline app format. GhostShell is the "app store" for agent-native software.
8. **What if TPM/WebAuthn attestation lets you prove code ran locally?** Remote work, legal discovery, and compliance change. GhostShell's signed reports become evidence.
9. **What if agents go multiplayer?** GhostShell's shared sessions and presence become the "Figma for coding agents" — a social product, not a tool.
10. **What if v86 gains 64-bit and multicore?** The VM becomes a real workstation; the "pre-bake everything" constraint evaporates; GhostShell's addressable market doubles overnight.

---

## 9. Competitive Moat

### 9.1 Versus the field

| Competitor | Strength | GhostShell's counter |
|---|---|---|
| **Claude Code** | Best model, best loop | $0, offline, no account, auditable, local-first |
| **Cursor** | Polished IDE | No install, no vendor lock-in, works on any machine with a browser |
| **GitHub Copilot** | Distribution | No telemetry, no subscription, no cloud dependency |
| **WebContainers (StackBlitz)** | Fast Node runtime, polished API | Real Linux (any language/tool), open source, no proprietary runtime |
| **Puter / WebVM** | Browser OS demos | Agent-first, local model, extensible, privacy-verifiable |
| **E2B / Daytona / Modal** | Cloud sandboxes | No servers, no per-hour cost, no data egress |
| **Replit / CodeSandbox** | Hosted IDEs | Offline, portable, reproducible, yours |

### 9.2 Moat pillars

1. **Verifiable privacy** — signed reports, egress logs, reproducible builds. Not a promise; a proof.
2. **Zero-cost, zero-infrastructure** — one file, $0, no account. The barrier to trying is nil.
3. **Real Linux, not a Node shim** — any language, any tool (within 32-bit limits).
4. **Openness** — OSS core, open recipe format, MCP, reproducible builds. No lock-in.
5. **Community network effects** — recipes, images, worlds, and a public eval leaderboard that improves as the community contributes.
6. **Novel capabilities** — multi-VM mesh, host bridge, time-travel, hardware bridges. Things cloud agents structurally cannot do.

### 9.3 Moat risks

- **Model quality**: small local models may stay mediocre; a hosted "escape hatch" may be needed (product tension).
- **Browser performance**: WebGPU/driver quirks; memory limits.
- **v86 maintenance**: single-maintainer upstream; 32-bit ceiling.
- **MCP governance**: if MCP fragments or gets captured by a vendor.
- **Platform risk**: a browser vendor could ship a competing built-in agent.
- **Distribution**: being "just a file" means no app-store presence; community and content matter.

### 9.4 Defensible actions

- Publish the **eval leaderboard** (community good + moat).
- Build the **recipe/MCP ecosystem** (switching costs).
- Ship the **privacy attestation** (trust moat).
- Keep the **single-file promise** (portability moat).
- Stay **upstream-first** (ecosystem goodwill).

---

## 10. Top 10 "Ship This First" Recommendations

Ranked by impact ÷ effort. "Impact" = effect on the core product's value and survival; "Effort" = engineering cost for a solo/small team.

| # | Recommendation | Impact | Effort | Rationale |
|---|---|---|---|---|
| 1 | **Grammar-constrained tool calls** (JSON mode / GBNF) instead of hoping for valid Hermes XML | Very High | Low-Med | Fixes Risk #1, the biggest killer. Guarantees parse success; cuts retries and latency. WebLLM JSON mode exists today. |
| 2 | **9p-backed persistence over OPFS** (replace tar-over-serial) | Very High | Medium | Millisecond snapshots; enables time-travel, host bridge, and CoW. Removes the biggest infrastructure risk. |
| 3 | **Honest opt-in networking** via v86 `fetch`/`wisp` + egress audit log | High | Low-Med | Unlocks `pip install`, git clone, host dev server; resolves the "no server" contradiction with a real, labelled choice. |
| 4 | **Twin-View synchronized terminal** | High | Low | Trust and debuggability; makes the agent legible; cheap to build on xterm.js. |
| 5 | **Recipe/Skill system** (manifest + prompt + setup + evals) | High | Low-Med | Seeds the ecosystem; multiplies capabilities without core code changes. |
| 6 | **Artifact panel** (sandboxed iframe for HTML/SVG/Canvas/Three.js) | High | Low-Med | Delight + new use cases (data viz, games, education); makes the agent feel magical. |
| 7 | **Privacy report + reproducible build + signed release** | High | Medium | Turns privacy from marketing into a verifiable artifact; the strongest enterprise/journalism pitch. |
| 8 | **Fork / time-travel sessions** (CoW snapshots + timeline UI) | Medium-High | Medium-High | A genuine UX differentiator; turns failure into exploration. |
| 9 | **Multi-VM mesh** via v86 `inbrowser` | Medium-High | Medium | Unique capability; enables distributed systems, security ranges, and multi-agent scenarios with no servers. |
| 10 | **Commit Coach + Explain-This** | Medium-High | Low | Daily utility + learning value; tiny implementation cost. |

### Also strong (next wave)

- **MCP client** — ecosystem integration; medium effort, high leverage.
- **Model eval leaderboard** — community good + moat; medium effort.
- **Host directory bridge** — unlocks real work; medium effort.
- **Voice mode** — delight + accessibility; medium effort.
- **Gamified quests** — onboarding/retention; low effort.
- **Ambient mode** — new category; medium effort, browser limits.
- **WebUSB/WebSerial bridge** — unique hardware angle; medium-high effort.

### Suggested sequence

**Now → v0.1 (6 weeks):** #1, #2, #3, #4, #10. These are correctness and trust fixes; they make the core product credible.
**v0.2 (next 6–8 weeks):** #5, #6, #7. Ecosystem seeding + delight + verifiable privacy.
**v1.0 (3–6 months):** #8, #9, MCP, eval leaderboard, host bridge, voice.
**v1.1+:** personalization, hardware bridges, multiplayer, ambient, E2E sync.

### What not to do first

- Don't build a hosted sync before the local product is loved.
- Don't add a model marketplace before you have an eval leaderboard (you'd be curating blind).
- Don't build multiplayer before single-user sessions are rock solid.
- Don't add voice/gesture before the core loop is reliable; they amplify a shaky core.
- Don't chase 64-bit VM dreams; design within v86's 32-bit, single-core reality.

---

## Appendix: References

**Core dependencies**

- v86 — https://copy.sh/v86/ · https://github.com/copy/v86 · [networking docs](https://github.com/copy/v86/blob/master/docs/networking.md) · [filesystem/9p docs](https://github.com/copy/v86/blob/master/docs/filesystem.md) · [Alpine Dockerfile](https://github.com/copy/v86/blob/master/tools/docker/alpine/Dockerfile)
- WebLLM — https://github.com/mlc-ai/web-llm · https://webllm.mlc.ai
- Transformers.js — https://huggingface.co/docs/transformers.js
- ONNX Runtime Web — https://onnxruntime.ai/docs/tutorials/web/
- llama.cpp — https://github.com/ggerganov/llama.cpp
- whisper.cpp — https://github.com/ggerganov/whisper.cpp

**Standards & protocols**

- Model Context Protocol — https://modelcontextprotocol.io
- WISP protocol — https://github.com/MercuryWorkshop/wisp-protocol
- WebGPU — https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API
- File System Access API — https://developer.mozilla.org/en-US/docs/Web/API/File_System_Access_API
- WebUSB — https://developer.mozilla.org/en-US/docs/Web/API/USB
- WebSerial — https://developer.mozilla.org/en-US/docs/Web/API/Serial
- WebAuthn — https://developer.mozilla.org/en-US/docs/Web/API/Web_Authentication_API
- Sigstore — https://sigstore.dev · SLSA — https://slsa.dev

**Constrained decoding**

- Outlines — https://github.com/dottxt-ai/outlines
- XGrammar — https://github.com/mlc-ai/xgrammar
- Guidance — https://github.com/guidance-ai/guidance
- llama.cpp GBNF grammars — https://github.com/ggerganov/llama.cpp/blob/master/grammars/README.md

**Competitors / cousins**

- WebContainers — https://webcontainers.io
- Puter — https://github.com/HeyPuter/puter
- WebVM — https://webvm.io
- JSLinux — https://bellard.org/jslinux/
- TinyEMU — https://bellard.org/tinyemu/
- E2B — https://e2b.dev · Daytona — https://daytona.io · Modal — https://modal.com
- OpenHands — https://github.com/All-Hands-AI/OpenHands · Aider — https://aider.chat
- Continue — https://continue.dev · Cline — https://cline.bot · Roo Code — https://github.com/RooCodeInc/Roo-Code
- Browser Use — https://github.com/browser-use/browser-use · Playwright MCP — https://github.com/microsoft/playwright-mcp

**Ecosystem & community**

- Local-first software (Ink & Switch) — https://inkandswitch.com/local-first/
- Sovereign Tech Fund — https://sovereigntechfund.de · NLnet — https://nlnet.nl
- GitHub Sponsors — https://github.com/sponsors · Open Collective — https://opencollective.com
- Yjs — https://github.com/yjs/yjs · Automerge — https://automerge.org · Liveblocks — https://liveblocks.io · PartyKit — https://www.partykit.io
- asciinema — https://asciinema.com
- JupyterLite — https://jupyterlite.readthedocs.io · Pyodide — https://pyodide.org · DuckDB-WASM — https://github.com/duckdb/duckdb-wasm
- PICO-8 — https://www.lexaloffle.com/pico-8.php · TIC-80 — https://tic80.com · LÖVE — https://love2d.org · p5.js — https://p5js.org · Three.js — https://threejs.org
- MediaPipe Hands — https://developers.google.com/mediapipe/solutions/vision/hand_tracker
- axe-core — https://github.com/dequelabs/axe-core · Lighthouse — https://developer.chrome.com/docs/lighthouse/overview
- SWE-bench — https://www.swebench.com
- fflate — https://github.com/101arrowz/fflate · idb — https://github.com/jakearchibald/idb · jsdiff — https://github.com/kpdecker/jsdiff · xterm.js — https://xtermjs.org · DOMPurify — https://github.com/cure53/DOMPurify

---

*End of report. The through-line: GhostShell wins not by matching cloud agents on model quality, but by being **free, offline, auditable, extensible, and genuinely yours** — and by shipping the few capabilities (multi-VM, host bridge, time-travel, hardware) that cloud agents structurally cannot.*
