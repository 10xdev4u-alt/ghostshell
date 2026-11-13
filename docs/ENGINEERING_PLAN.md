# GhostShell — Engineering Plan

> Draft for review. **[UNVERIFIED]** marks claims that need a spike before committing.

## 0. TL;DR

GhostShell is one static HTML file that runs a coding agent entirely in the browser:

- **Emulated Linux VM** — copy.sh v86 (WASM x86 emulator), Alpine, pre-baked git/python3/node.
- **Local LLM** — Transformers.js / WebLLM (WASM + WebGPU), 1.5B–3B quantized instruct model, cached in IndexedDB.
- **Agent loop** — TypeScript, observe → think → act → observe, 5 tools, delimited tool calls, retries.
- **UI** — chat, terminal, file tree, diff, settings.
- **No backend, no API keys.** The only network call is the one-time model download from a CDN.

Hard tensions to accept up front:

1. **"Single HTML file" vs "apt-get install at runtime":** VM networking is opt-in. `off` (no network backend) is the default; `inbrowser` and `fetch` need no relay, and only `wisp` sends VM traffic through a third-party proxy the user supplies. v0.1 ships a **frozen image** with packages pre-baked; runtime installs are a v1.0 opt-in.
2. **"No server" means no GhostShell backend, not no network:** model weights (~1–2 GB) are fetched from a CDN on first run and cached. A truly offline file would need the weights bundled, which is incompatible with a <100 MB HTML file.
3. **1.5B–3B local models are mediocre at tool calling.** The agent loop must be engineered around that: delimited XML/JSON syntax, corrective retries, eval-driven model choice.

## 1. Vision & Scope

### 1.1 What GhostShell is

A zero-infrastructure coding agent. Open the file, get a chat with an AI that runs real commands in a real (emulated) Linux box, with the model running on your GPU/CPU. Privacy: code and conversation never leave the machine except the one-time model download. Cost: $0.

### 1.2 v0.1 vs v1.0

| Capability | v0.1 | v1.0 |
|---|---|---|
| Delivery | Single HTML, all assets inlined | Single HTML + optional CDN assets |
| VM | Alpine, pre-baked packages, no network | Debian/custom image, opt-in network, offline package cache |
| LLM | 1.5B–3B, WASM backend | 3B–8B, WebGPU fast path, model picker |
| Context | 4k | 8k–32k with compaction |
| Tools | bash, read_file, write_file, list_dir, search | + edit_file, ask_user, web_fetch (if network) |
| UI | Chat, terminal, settings, status bar | + diff viewer, file browser, multi-session |
| Persistence | Conversations + VM snapshot in IndexedDB | + export/import, per-conversation snapshots |
| Mobile | Unsupported (warning) | Responsive, 8 GB+ devices |
| Eval | 20-task internal suite | 100-task suite, model leaderboard |

### 1.3 In scope / out of scope

**In (v0.1):** everything in the v0.1 column.
**Out (v0.1):** WebGPU-specific tuning, runtime model switching without re-download, voice/images, accounts, telemetry (none, ever), native wrapper, mobile.
**Out (v1.0):** hosted sync, fine-tuning, web RAG, multi-agent orchestration (v1.1+).

### 1.4 User stories

- As a developer, I want to say "fix the failing test in `/root/workspace/myapp`" and have the agent run tests, edit files, and rerun them, so I don't copy-paste between chat and terminal.
- As a privacy-conscious user, I want the model local so my code never leaves my machine.
- As a learner, I want to watch each command and its output, so I understand what the agent did.
- As a traveler, I want to load once and keep working offline (model cached).
- As a low-end-laptop user, I want a smaller model that still works.

## 2. Architecture Overview

### 2.1 Component diagram

```text
+-----------------------------------------------------------------------+
|                         Browser (one tab)                             |
|                                                                       |
|  +----------------+        +------------------+                       |
|  | UI layer       |        | Persistence      |                       |
|  | Chat/Terminal  |<------>| IndexedDB        |                       |
|  | FileTree/Diff  |        | conversations    |                       |
|  +-------+--------+        | snapshots        |                       |
|          |                 | settings         |                       |
|          | events          | model cache      |                       |
|          v                 +---------^--------+                       |
|  +-------+--------+                  |                                |
|  | Agent loop     |                  |                                |
|  | prompt builder |                  |                                |
|  | tool parser    |                  |                                |
|  | context mgr    |                  |                                |
|  +----+-------+---+                  |                                |
|       |       |                      | snapshots                      |
|       |       | text                 |                                |
|       v       v                      |                                |
|  +---------+ +-------------------+   |                                |
|  | LLM     | | VM (v86)          |---+                                |
|  | engine  | | Alpine Linux      |                                    |
|  | WASM/   | | bash/git/python3  |                                    |
|  | WebGPU  | | serial console    |                                    |
|  +---------+ +-------------------+                                    |
|                                                                       |
|  [WASM: v86 x86 emulator] [WASM: ONNX/MLC] [JS: agent loop]            |
+-----------------------------------------------------------------------+
```

### 2.2 Data flow

- User input → Agent loop → LLM stream → UI.
- LLM emits `<tool_call>` → ToolParser → ToolRegistry → `VM.run()` → serial output → tool result → Agent loop → next LLM call.
- Every state change → debounced Persistence → IndexedDB.
- VM filesystem changes → snapshot on idle → IndexedDB.

### 2.3 Threading model

- **Main thread:** UI, agent loop, IndexedDB.
- **LLM:** main thread in v0.1 (chunked streaming); move to a Web Worker in v1.0 if jank appears. Transformers.js and WebLLM both support workers.
- **v86:** main thread in v0.1; it yields internally with timers. Move to a worker if heavy commands freeze the UI.
- **WASM threads:** only when `crossOriginIsolated` (COOP/COEP headers). Otherwise single-threaded. Hosting constraint — see §3.7.

### 2.4 Trust boundaries

- **Untrusted:** LLM output, VM command output, file contents, downloaded model weights.
- **Trusted:** the GhostShell HTML file itself.
- **Rules:** never render untrusted text as HTML; never `eval`; never give the VM host filesystem or host network; treat the VM as disposable.

## 3. Component Breakdown

### 3.1 Emulated Linux (v86)

**What v86 is.** copy.sh v86 is a WASM build of a QEMU-derived x86 emulator (TCG) that boots a full Linux kernel in a browser tab. It emulates a PC: x86/x86-64 CPU, RAM, VGA framebuffer, IDE/virtio-blk disk, NIC (virtio-net/e1000/rtl8139; v86 picks the backend from `net_device.relay_url` — `inbrowser`, `fetch`, or a `wisp://`/`wisps://` proxy for its in-page TCP/IP stack), PS/2 input, serial ports, RTC. References: https://copy.sh/v86/, https://github.com/copy/v86.

**Why v86 over alternatives:**

| Alternative | Verdict |
|---|---|
| JSLinux (Bellard) | Not embeddable / not licensable |
| TinyEMU (RISC-V) | No x86 toolchain; niche |
| QEMU compiled to WASM | Too heavy; no maintained browser build |
| WebContainers (StackBlitz) | Node-only, not a Linux VM, proprietary |
| Pyodide + Emscripten | Not a general Linux environment |

**Boot image choice:**

| Image | Pros | Cons | Verdict |
|---|---|---|---|
| Alpine Linux (copy.sh image) | ~20–40 MB, musl, fast boot, `apk` | Smaller package ecosystem, musl quirks | **v0.1 default** |
| Debian (copy.sh image) | ~200–300 MB, glibc, full toolchain | Large, slower boot | v1.0 option |
| Custom Buildroot | ~5–15 MB, tailored, minimal | Build + maintenance effort | v1.0 goal |
| Stock v86 linux4 image | Smallest | No package manager, minimal tooling | Not useful for a coding agent |

**Memory.** v86 `memory_size` default 128 MB; Alpine needs ~128–256 MB to be comfortable. Recommend **256 MB for v0.1**, 512 MB for v1.0 with gcc/node. Guest RAM counts toward browser memory. [UNVERIFIED: whether guest RAM is a `WebAssembly.Memory` or a plain `ArrayBuffer`; check the pinned version.]

**Pre-installed tooling** (baked into the image at build time):

```bash
# pseudo-build steps on a host Alpine
apk add --no-cache git python3 py3-pip nodejs npm bash curl ca-certificates
# optional: gcc musl-dev make binutils   # +~150 MB
# optional: tcc                          # +~1 MB, fast C compiles
```

Size budget: git ~20 MB, python3 ~40 MB, nodejs ~50 MB, npm ~30 MB, gcc ~150 MB.
**v0.1 ships git + python3 + nodejs (no gcc)** → ~120 MB installed → ~40–60 MB compressed image. v1.0 "full" profile adds gcc/make → ~70–100 MB compressed. [Sizes approximate; measure.]

**Runtime package installs.** `apk add` needs network. v0.1 defaults to `off` (no VM network) → pre-bake everything. Runtime installs are opt-in: `fetch` reaches CORS-friendly mirrors and host `localhost`; `wisp` requires a user-supplied proxy. Alternatively bake an offline cache (`/var/cache/apk/*.apk`) or a pip wheelhouse so `pip install --no-index --find-links /opt/wheels` works offline.

**Filesystem persistence.**

- **Primary:** v86 filesystem serialization (`fs.save()` / `fs.load()` in recent versions [UNVERIFIED]) → `Blob` → IndexedDB.
- **Fallback (API-independent):** inside the VM run `tar czf - / --exclude=/proc --exclude=/sys --exclude=/dev | base64 -w0`, capture over serial, store the base64 in IndexedDB. Restore by piping base64 into `tar xzf -`. Slow for large images (serial throughput ~1–5 MB/s [UNVERIFIED]) but guaranteed to work.
- **Save policy:** debounce 5 s after the last VM command; also save on `visibilitychange` / `beforeunload`; show a "Saving VM…" indicator. Snapshots are versioned (`{version: 1, createdAt, data}`).
- **Quota:** request `navigator.storage.persist()`; show usage via `navigator.storage.estimate()`; warn at 80 %.

**Network.** `buildNetDevice` (`src/core/vm/network.ts`) builds v86's `net_device`; v86 selects the adapter from `relay_url`. GhostShell exposes four states:

| Mode | `relay_url` | Transport | Needs a third-party relay? |
|---|---|---|---|
| `off` (default) | — | no network backend (v86's default ne2k NIC stays, disconnected) | No |
| `inbrowser` | `"inbrowser"` | `BroadcastChannel` between tabs/windows | No |
| `fetch` | `"fetch"` | browser `fetch()` | No |
| `wisp` | `"wisp://…"` / `"wisps://…"` | WISP proxy (TCP over WebSocket) | Yes — user-supplied |

- **`off`** returns no `net_device`, so no network backend is attached; v86 still emulates its default ne2k NIC, which has nowhere to send frames. Every other mode is an explicit opt-in.
- **`inbrowser`** moves Ethernet frames between tabs over `BroadcastChannel`. No server, no external network.
- **`fetch`** runs its TCP/IP stack in the page and performs HTTP through the browser's `fetch()`. It reaches CORS-friendly mirrors and the host's `localhost` (`http://<port>.external`); it needs no relay or proxy.
- **`wisp`** is the only mode that needs a relay: it tunnels TCP through a user-supplied WISP proxy, which sees VM traffic. GhostShell accepts `ws://` and `wss://` and normalizes them to `wisp://` / `wisps://`; a missing or invalid URL throws instead of silently attaching a NIC.
- Optional fetch/wisp peer hints (`router_mac`, `router_ip`) and the shared network namespace `id` pass through to the device when set.

**How agent commands execute in the VM.**

1. Agent loop calls `VM.run(command, {timeout})`.
2. `VM.run` writes a sentinel-wrapped command to the serial port:
   ```bash
   PS1='__GS_PROMPT_<id>__'
   echo __GS_BEGIN_<id>__
   <command>
   echo __GS_DONE_<id>__ $?
   ```
   The begin/done pair brackets the command output; the prompt sentinel
   identifies guest prompts so they can be stripped from the body.
3. `v86.serial0.send(...)` pushes bytes to the guest UART.
4. Guest shell executes; output returns via `v86.serial0.on_receive`.
5. `VM.run` accumulates bytes until it sees `__GS_DONE_<id>__ <code>` or the timeout fires.
6. On timeout: send Ctrl-C (`\x03`), wait 200 ms, return `Command timed out after Ns (exit code -1)`.
7. Result: `{stdout, stderr, exitCode, durationMs}`.

Binary-safe reads/writes use `base64` inside the VM. Large writes (>64 KB) are chunked into multiple heredoc appends.

**v86 API cheat sheet** (verify against the pinned version):

```ts
const v86 = new V86({
  wasm_path: "v86.wasm",              // or a data: URL
  screen_container: document.getElementById("screen"),
  memory_size: 256 * 1024 * 1024,
  vga_memory_size: 8 * 1024 * 1024,
  filesystem: { base_url: "images/", base_fs: "alpine_fs.json" },
  net_device: undefined,              // default `off`: no network backend attached
  disable_keyboard: true,
  disable_mouse: true,
});
await v86.boot();
v86.serial0.send("uname -a\n");
v86.serial0.on_receive = (data: Uint8Array) => { /* bytes from guest */ };
const state = await v86.save();       // full VM state (RAM included) — large
await v86.restore(state);
v86.stop();
```

[UNVERIFIED: exact option names; whether `serial0.on_receive` is a property or an event. Check `src/serial.js` in the v86 repo.]

**Build the image.**

1. Start from the copy.sh Alpine image (or build a custom one with `buildroot` / `alpine-make-rootfs`).
2. Boot it in v86 on a host and run the package installs.
3. Save the filesystem image; host it or inline it.
4. Pre-create `/root/workspace` and a `README`.
5. Record the image sha256 for integrity.

### 3.2 WASM LLM Runtime

**Options compared:**

| Runtime | Backend | Format | Pros | Cons |
|---|---|---|---|---|
| Transformers.js v3 (`@huggingface/transformers`) | ONNX Runtime Web (WASM/WebGPU/WebNN) | ONNX q8/q4 | Huge HF hub; tokenizer + chat templates; works without WebGPU; familiar API | Slower than WebLLM on WebGPU; smaller model selection; no native tool calling |
| WebLLM (`@mlc-ai/web-llm`) | MLC TVM (WebGPU + WASM) | MLC GGUF | Best WebGPU performance; built-in chat API; IndexedDB cache; tool calling in newer versions | WebGPU needed for good perf; model set limited to MLC conversions; GPU driver quirks |
| Candle WASM | WASM + WebGPU | GGUF | HF ecosystem, Rust, GGUF | Demos, not a library; you write the glue |
| llama.cpp WASM | WASM SIMD/threads | GGUF | Best quantization support; active project | No official browser chat API; you write the glue; threads need COOP/COEP |
| ONNX Runtime Web direct | WASM/WebGPU | ONNX | Flexible | All glue is yours |

**Decision.** Define an `LLMEngine` interface and ship two implementations:

- `TransformersEngine` — default for v0.1. Works everywhere, pure WASM, no GPU required.
- `WebLLMEngine` — optional, v1.0. Faster on WebGPU machines; auto-selected when `navigator.gpu` exists.

This hedges the biggest unknown (which runtime is faster/more reliable in practice) behind one interface. Week 0 measures both.

**Engine interface:**

```ts
interface LLMEngine {
  readonly id: string;
  load(onProgress: (p: LoadProgress) => void): Promise<void>;
  countTokens(text: string): Promise<number>;
  chat(req: ChatRequest, onToken: (t: string) => void): Promise<ChatResponse>;
  dispose(): Promise<void>;
}
```

`ChatRequest`: `messages`, `tools`, `max_tokens`, `temperature`, `stop`, `signal`.
`ChatResponse`: `text`, `toolCalls`, `tokensUsed`, `finishReason`.

**Model choices:**

| Model | Params | Quant | Size (GB) | Context | License | Tool calling | Role |
|---|---|---|---|---|---|---|---|
| Qwen2.5-1.5B-Instruct | 1.5B | Q4_K_M | ~1.0 | 32k | Apache-2.0 | Good | **v0.1 default** |
| SmolLM2-1.7B-Instruct | 1.7B | Q4 | ~1.2 | 8k | Apache-2.0 | OK | alt |
| Qwen2.5-3B-Instruct | 3B | Q4_K_M | ~2.0 | 32k | Apache-2.0 | Good | v1.0 default |
| Llama-3.2-3B-Instruct | 3B | Q4_K_M | ~2.1 | 128k | Llama Community | Good | alt |
| Phi-3-mini-4k-instruct | 3.8B | Q4 | ~2.3 | 4k/128k | MIT | Good | alt |
| Mistral-7B-Instruct-v0.3 | 7B | Q4_K_M | ~4.1 | 32k | Apache-2.0 | Good | v1.0 fast path |
| Llama-3.1-8B-Instruct | 8B | Q4_K_M | ~4.9 | 128k | Llama Community | Good | v1.0 fast path |

[Sizes/IDs approximate and [UNVERIFIED]; verify on the model hub.]

**Recommendation.** Default to **Qwen2.5-1.5B-Instruct (Q4_K_M)** for v0.1 — best quality/size/speed ratio, Apache-2.0, 32k context — with **Qwen2.5-3B-Instruct** as the quality option. Both follow instructions well and have native tool-calling templates (though GhostShell uses its own delimited format for reliability).

**Weight loading.**

- First run: download shards from the HF Hub CDN (or a mirror) with a progress bar; cache in IndexedDB (Transformers.js) or the browser cache (WebLLM).
- Subsequent runs: load from cache; verify integrity (sha256 pin for the default model, if the runtime allows).
- Model picker in settings: switching models re-downloads or reuses cache.
- Download resumption: Transformers.js supports HTTP range requests; WebLLM uses its own fetcher. On failure, retry from the last shard. [UNVERIFIED: exact resumption behavior; test.]
- Hosting weights yourself is out of scope ("no server"), but the model URL is configurable so a user can point at a local file/mirror.

**WebGPU vs WASM.**

- **WebGPU:** 3–6× faster for 3B+ models; needs Chrome/Edge 113+, Safari 18+, recent Firefox; requires a working GPU driver.
- **WASM SIMD:** works everywhere; 3–10× slower than WebGPU; single-threaded unless COOP/COEP is set.
- Feature detection:
  ```ts
  const hasWebGPU = !!navigator.gpu;
  const hasSIMD = WebAssembly.validate(new Uint8Array([
    0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,10,1,8,0,65,0,253,15,253,98,11
  ]));
  const canThread = crossOriginIsolated;
  ```
- Use WebGPU when available; fall back to WASM SIMD; warn if neither is present.

**Performance expectations** ([UNVERIFIED] — measure with the benchmark harness):

| Machine | Model | Backend | Tok/s | First token | RAM |
|---|---|---|---|---|---|
| M1 Pro 16 GB | 1.5B q4 | WebGPU | 50–80 | 0.3–1.0 s | ~2 GB |
| M1 Pro 16 GB | 3B q4 | WebGPU | 30–45 | 0.5–1.5 s | ~3 GB |
| M1 Pro 16 GB | 3B q4 | WASM SIMD | 8–15 | 1–3 s | ~3 GB |
| i5-1240P 16 GB | 3B q4 | WebGPU | 12–25 | 1–2 s | ~3 GB |
| i5-1240P 16 GB | 3B q4 | WASM SIMD | 4–8 | 2–4 s | ~3 GB |
| RTX 4060 / M4 Pro | 7B q4 | WebGPU | 40–70 | 1–2 s | ~6 GB |
| Low-end 8 GB | 1.5B q4 | WASM | 8–15 | 1–3 s | ~2.5 GB |

KV cache estimate (Qwen2.5-3B, 4k ctx, fp16): ~150 MB; 8k: ~300 MB. Weights dominate (~2 GB).

**Context window.** v0.1 targets **4k tokens** (default model supports 32k, but 4k keeps KV cache ~150 MB and latency predictable). v1.0 offers 8k/16k with context compaction.

### 3.3 Agent Loop

**Loop structure** (observe → think → act → observe):

```text
messages = [system, ...history, user]
for i in 0..MAX_ITERS:
    response = llm.chat(messages, tools, {signal, max_tokens})
    messages.push(response.message)
    if response.toolCalls.length == 0:
        return response.text            // final answer
    for call in response.toolCalls:
        result = await tools.exec(call) // VM round-trip
        messages.push(toolResult(call, result))
    if wallClockExceeded(): break
    if repeatedCallDetected(): break
return "I hit the iteration/time limit. Here is what I found: ..."
```

**Constants (v0.1):**

| Constant | Value | Rationale |
|---|---|---|
| `MAX_ITERS` | 20 | Enough for a multi-step task; small models loop more |
| `MAX_TOKENS_PER_TURN` | 2048 | Limits a runaway generation |
| `WALL_CLOCK_LIMIT` | 300 s | Per user turn |
| `PER_COMMAND_TIMEOUT` | 60 s | `timeout 60 <cmd>` inside the VM + JS watchdog |
| `CONTEXT_BUDGET` | 0.8 × ctx_len | Leaves room for the next response |
| `RETRY_ON_PARSE_ERROR` | 2 | Then give up and ask the user |
| `LOOP_DETECT_THRESHOLD` | 3 identical calls | Break and report |

**Tool definitions:**

| Tool | Implementation | Notes |
|---|---|---|
| `bash` | `VM.run(command)` | Full shell; sentinel-wrapped; 60 s timeout |
| `read_file` | `base64 <path>` via VM | ASCII-safe; decode in JS |
| `write_file` | `base64 -d > <path> <<'EOF' … EOF` | Chunked >64 KB; creates parent dirs |
| `list_dir` | `ls -la <path>` | Parsed into a tree for the UI |
| `search` | `grep -rn <pattern> <path>` | Returns `file:line: text` |

All tools are thin wrappers over bash. The agent has full shell access anyway, so the tool layer exists for UX and validation, not security.

**Tool-call format** (Hermes-style, most robust for small models):

```xml
<tool_call>
{"name": "bash", "arguments": {"command": "ls -la /root/workspace"}}
</tool_call>
```

The prompt demands exactly one block per turn. Parsing strategies, in order:

1. `<tool_call>…</tool_call>` → `JSON.parse`.
2. Fenced ` ```json ` block with `{"name":…, "arguments":…}`.
3. Bare JSON object with `name` + `arguments` (last resort).
4. Native tool calls if the engine supports them (newer WebLLM).

If parsing fails: append a corrective message and retry (max 2). If the model emits prose + a tool call, render the prose as "thinking" and execute the call.

**Prompt engineering for small models.**

- Short system prompt (~200 words), explicit rules, 2 few-shot examples.
- Use the model's native chat template (ChatML for Qwen, Llama-3 format for Llama). Transformers.js `apply_chat_template` handles this; WebLLM does it internally.
- One tool call per turn; no multi-tool batches (small models fumble them).
- "Think step by step" is optional; test with and without (it can help or cause loops).
- Keep the tool list stable; do not reorder tools between turns.
- Include the current working directory and a short `pwd`/`ls` observation in the first user message so the model knows where it is.
- Temperature 0.7 for generation; 0.2 for tool-call turns if the engine supports per-call params. [Optional; test.]

**Context management.**

- Count tokens with the tokenizer (or `chars/4` fallback).
- When `tokens > 0.8 × ctx_len`: compact. Keep system + last 6 messages; summarize the middle with a cheap LLM call ("Summarize the conversation so far in <200 words, including file paths and command results"). Insert the summary as a system message.
- Trim tool outputs: cap at 8 KB per result (truncate with `…[truncated N bytes]`); store the full output in IndexedDB for the UI to expand.

**Error recovery:**

| Failure | Recovery |
|---|---|
| Malformed tool call | Corrective prompt, retry ×2 |
| Tool timeout | Kill (Ctrl-C), return "timed out", let the model adapt |
| VM command fails (non-zero exit) | Return stderr + exit code; model retries |
| LLM repeats identical call ×3 | Inject "you already tried that; try a different approach" |
| LLM emits no tool call and no final answer | Ask "please continue or give a final answer" |
| Wall clock / max iters | Return a partial summary + what was done |
| User hits Stop | `AbortSignal` cancels generation; kill VM command; keep history |

**Interrupt.** A Stop button calls `AbortController.abort()`; the engine stops streaming; the VM command is killed; the partial message is kept in history with a "stopped" marker.

### 3.4 Sandboxing & Security

**VM isolation.**

- v86 runs in WASM with no host filesystem, no host network (`off` default: no network backend; v86's default NIC stays disconnected), no clipboard, no USB. Guest root is not host root.
- The VM is disposable: a corrupted image is restored from the IndexedDB snapshot or re-initialized.
- Escape risk = a v86 emulator bug (CPU/virtio/9p). Mitigations: pin a known v86 version, minimize the attack surface (disable keyboard/mouse/speaker/clipboard), monitor v86 security issues, never expose host paths.
- The agent runs as root in the VM; that is fine because the VM is the security boundary, not the guest user. If a future version supports unprivileged guests, run as a `sandbox` user.

**Browser / XSS.**

- All LLM output, tool output, and file contents are untrusted. Render as text nodes (`textContent`) or escaped HTML. Never `innerHTML` untrusted data.
- If markdown rendering is desired, sanitize with DOMPurify or a strict allowlist renderer — prefer a tiny custom renderer that outputs `<pre>`/`<code>` and escapes everything else.
- CSP when hosted:
  ```text
  default-src 'self';
  script-src 'self' 'wasm-unsafe-eval';
  style-src 'self' 'unsafe-inline';
  connect-src 'self' https://huggingface.co https://cdn-lfs.huggingface.co;
  img-src 'self' blob: data:;
  worker-src 'self' blob:;
  ```
- Optional defense-in-depth: run the app inside a sandboxed iframe (`<iframe sandbox="allow-scripts">`) hosted by a minimal wrapper page. This isolates the app from the parent origin. Costs an extra file and complicates `file://`. **Decision:** v0.1 uses CSP + escaping; v1.0 evaluates the iframe wrapper.
- No `eval`, no `new Function`, no dynamic script injection.

**Network.**

- Zero network calls by default except the model weight download. Opt-in modes change that: `fetch` performs browser `fetch()` calls to the hosts the VM contacts, `wisp` opens a WebSocket to the user-supplied proxy, and `inbrowser` stays within the page. Verify with a network log in tests: no telemetry, no phone-home.
- Model weight integrity: pin sha256 for the default model; verify after download. [Nice-to-have; adds complexity with sharded files.]
- No API keys: nothing to store, nothing to leak. State this in the README.

**Supply chain.**

- Pin npm dependencies with a lockfile; run `npm audit`; vendor the v86 build (do not rely on a CDN copy of `v86.wasm`).
- The HTML file is self-contained; a user can audit it.

**Data lifecycle.**

- All data lives in IndexedDB. "Clear all data" wipes conversations, snapshots, and the model cache (with confirmation).
- Export/import lets a user back up or move a session.

### 3.5 Persistence Layer

**IndexedDB schema** (via `idb`, version 1):

| Store | Key | Value | Notes |
|---|---|---|---|
| `conversations` | `id` (uuid) | `{id, title, createdAt, updatedAt, messages[]}` | messages: `{role, content, toolCalls[], toolResults[], tokens, timestamp}` |
| `snapshots` | `id` (`"vm-current"` or uuid) | `{id, version, createdAt, size, data: Blob}` | v86 fs image or tar blob |
| `settings` | `key` | JSON | model, temperature, max_tokens, theme, etc. |
| `blobs` | `id` | Blob | exports, large tool outputs, misc |
| `meta` | `key` | JSON | schema version, last model, onboarding state |

**Model cache.** Transformers.js / WebLLM manage their own caches (IndexedDB / Cache API). GhostShell exposes:

- Download progress from the engine's `initProgressCallback`.
- "Clear model cache" in settings.
- Storage usage via `navigator.storage.estimate()`.

**Conversation history.**

- Persist after every message (debounced 500 ms).
- Keep full tool outputs in IndexedDB even when truncated in the prompt.
- Title: first user message, truncated to 60 chars.
- Multi-session: sidebar lists conversations. **v0.1 = one VM, many conversations; v1.0 = optional per-conversation snapshots.**

**VM snapshot.**

- Save on idle (debounce 5 s) and on `beforeunload` / `visibilitychange`.
- Store the fs image (preferred) or tar blob (fallback).
- Version the snapshot format; migrate on schema change.
- Size: ~40–80 MB for a tooled Alpine image. Test IndexedDB write/read throughput; if too slow, save only on explicit "Save snapshot" + on exit.

**Export/import.**

- Export: JSON (conversation + settings) or ZIP (conversation + VM snapshot) via `fflate`.
- Import: restore conversation; optionally restore the VM snapshot.
- Extensions: `.ghostshell.json` / `.ghostshell.zip`.

**Quota:**

```ts
const persisted = await navigator.storage.persist();
const est = await navigator.storage.estimate();
// warn if est.usage / est.quota > 0.8
```

### 3.6 UI/UX

**Layout:**

```text
+--------------------------------------------------------------+
| GhostShell                                   [model] [⚙]    |
+----------+---------------------------------------------------+
| Convos   |  Message list                                     |
|          |   user: fix the failing test                      |
| > conv 1 |   agent: I'll start by running the tests...       |
|   conv 2 |     └─ tool: bash `pytest -x`          [output ▾]  |
|          |     └─ tool: read_file `test_app.py`  [output ▾]  |
|          |   agent: The test fails because...                |
|          |                                                   |
|          |  [ input.............................. ] [Send]   |
|          |  [Terminal] [Files] [Diff]                         |
+----------+---------------------------------------------------+
| VM: Alpine 3.19 | 3.2 tok/s | 1.2k tokens | 💾 saved        |
+--------------------------------------------------------------+
```

**Components:**

| Component | Behavior |
|---|---|
| `ChatView` | Streaming bubbles; token counter; Stop button |
| `ToolCallCard` | Collapsible `<details>` with command, output, duration, exit code |
| `TerminalPanel` | v86 framebuffer canvas + optional xterm.js serial terminal |
| `FileTree` | Built from `list_dir` output; click to read |
| `DiffView` | `jsdiff` line diff for `write_file` (v1.0; v0.1 shows old/new side by side) |
| `SettingsModal` | Model, temperature, max tokens, context, theme, clear data |
| `StatusBar` | Model name, tok/s, token count, VM status, save state |
| `SplashScreen` | Boot/download progress with phases |

**Streaming.** Append tokens to the bubble; batch DOM updates with `requestAnimationFrame` (or every 30 ms) to avoid layout thrash. Show a blinking cursor while generating.

**Thinking display.**

- If the model emits `<think>…</think>`, render it in a collapsible "Thought process" section.
- Otherwise show a spinner + elapsed time + token count.
- Tool calls are shown as they happen (not hidden), so the user can watch the agent work.

**Terminal.** A drawer with two tabs: "Agent view" (the same tool calls, formatted) and "Raw VM" (a live serial console where the user can type commands). The raw console is invaluable for debugging and for users who want to poke around.

**Mobile.** Responsive CSS, but show a warning if `navigator.deviceMemory < 8`. Hide the terminal on small screens. v0.1 is desktop-first; mobile is a v1.0 goal.

**Accessibility.** ARIA labels, keyboard navigation, focus management, reduced-motion support, dark/light themes via CSS variables.

**Onboarding.** First run shows a short overlay: "This page runs a Linux VM and a local AI model. Nothing leaves your machine except the one-time model download." With a "Learn more" link.

### 3.7 Build & Bundle

**Toolchain:** Vite 6 + TypeScript 5 + `vite-plugin-singlefile`.

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig({
  plugins: [viteSingleFile({ removeViteModuleLoader: true })],
  build: {
    target: "es2022",
    assetsInlineLimit: 100_000_000,   // inline everything as data URLs
    chunkSizeWarningLimit: 100_000,
  },
});
```

**Asset strategy:**

| Asset | Size (approx) | Strategy |
|---|---|---|
| JS/CSS (app) | 1–3 MB | Inline (singlefile) |
| `v86.wasm` + fallback | 2–4 MB | Inline as base64 data URL |
| Boot image (Alpine + tools) | 40–80 MB compressed | Inline as base64, **or** separate file |
| Model weights | 1–5 GB | Never inline; download + cache |
| ORT Web wasm (if Transformers.js) | 10–20 MB | Inline as data URLs [UNVERIFIED] |

**Data URLs vs blob URLs.** `WebAssembly.instantiateStreaming` needs a MIME type. A data URL with `data:application/wasm;base64,…` works; a blob URL does not. Vite emits data URLs for inlined assets, so pass those directly to v86 / ORT. For fetch-only assets (boot image), data URLs work with `fetch`.

**Size budget:**

| Build | Contents | Size |
|---|---|---|
| Slim | App + wasm, image fetched from CDN | ~5–10 MB |
| Standard | App + wasm + Alpine image inlined | ~45–85 MB |
| v0.1 target | Standard, < 100 MB | **< 100 MB** |

A 60 MB HTML gzips to ~55 MB (binary barely compresses). First load on 20 Mbps ≈ 22 s. Acceptable one-time cost; flag it in the README.

**Offline.** With everything inlined, the file works offline after the model is cached. A service worker / PWA is optional (v1.0) — a single inlined HTML file is already "offline by default."

**`file://` vs hosted.** `file://` works for classic inline scripts and data URLs, but IndexedDB and `crossOriginIsolated` are unreliable. Recommend a static host (GitHub Pages, Netlify, Cloudflare Pages) or `python -m http.server`. Test `file://` before promising it.

**COOP/COEP and threads.** Threaded WASM (ORT threads, llama.cpp pthreads) needs `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corpus`. GitHub Pages cannot set headers; Netlify/Cloudflare Pages can (`_headers` / `_headers` file). If hosted without these headers, WASM runs single-threaded (3–10× slower for 3B+). **Recommendation:** host on Netlify/Cloudflare Pages and set the headers; accept single-thread as the fallback.

**Precompression.** For hosted builds, precompress with Brotli (`ghostshell.html.br`) and serve with `Content-Encoding: br`. Requires server config; note it.

## 4. Tech Stack Decisions

| Dependency | Version (pin) | Purpose | Rationale | Alternatives considered |
|---|---|---|---|---|
| `v86` | latest stable (pin commit) | x86 Linux VM | Only embeddable full-system browser emulator | JSLinux, TinyEMU, QEMU-WASM, WebContainers |
| `@huggingface/transformers` | v3.x | LLM runtime (default) | Pure WASM fallback; HF hub; tokenizer + chat templates | WebLLM, llama.cpp WASM, candle, ORT direct |
| `@mlc-ai/web-llm` | 0.2.x | LLM runtime (fast path) | Best WebGPU perf; built-in chat API | Transformers.js, candle |
| `onnxruntime-web` | latest | ORT backend for Transformers.js | Required by Transformers.js | — |
| `xterm` + `@xterm/addon-fit` | 5.x | Raw VM terminal | Standard, accessible | Custom renderer (v0.1 maybe) |
| `diff` (jsdiff) | 5.x | Line diffs for write_file | Tiny, battle-tested | `diff2html` (heavier) |
| `fflate` | 0.8.x | ZIP export/import | 8 KB, fast, no deps | JSZip (larger) |
| `idb` | 8.x | IndexedDB wrapper | 1 KB, promise-based | Dexie (more features, larger) |
| `dompurify` | 3.x | Sanitize markdown/HTML | Defense-in-depth | Custom renderer (preferred) |
| `vite` | 6.x | Build | Fast, standard | Rollup, esbuild, webpack |
| `vite-plugin-singlefile` | 2.x | Inline to one HTML | Purpose-built | `rollup-plugin-singlefile`, manual esbuild |
| `typescript` | 5.x | Types | Safety at boundaries | JSDoc + esbuild |
| `preact` + `htm` | 10.x / 3.x | UI (v1.0) | 4 KB, JSX-less | React (heavier), vanilla TS (v0.1) |
| `vitest` | 2.x | Unit tests | Vite-native | Jest, node:test |
| `playwright` | 1.4x | E2E (boot, chat, tools) | Real browser, WebGPU | Puppeteer, web-test-runner |

**Version policy:** pin exact versions in `package.json`, commit `package-lock.json`, run `npm audit` in CI, and re-pin on a schedule.

## 5. Data Flow / Sequence Diagrams

### 5.1 Turn execution (user → tool call → final answer)

```text
User      UI         AgentLoop      LLMEngine        VM (v86)
 |          |             |              |               |
 | send     |             |              |               |
 |--------->| runTurn()   |              |               |
 |          |------------>|              |               |
 |          |             | chat(msgs)   |               |
 |          |             |------------->|               |
 |          |             |              | tokenize      |
 |          |             |              | generate      |
 |          |             |              | (stream)      |
 |          |             |<------------ tokens          |
 |          |             | parse <tool_call>            |
 |          |             | exec bash    |               |
 |          |             |----------------------------->|
 |          |             |                             | serial
 |          |             |                             | "ls -la"
 |          |             |<---------------------------- output
 |          |             | append result |               |
 |          |             | loop (max 20) |               |
 |          |             | final text   |               |
 |          |<------------|              |               |
 |<---------| render      |              |               |
```

### 5.2 Cold start

```text
Browser
 |- parse URL (?model=qwen2.5-1.5b)
 |- open IndexedDB
 |- load settings + conversation
 |- init v86:
 |    |- fetch wasm (data URL) -> instantiate
 |    |- load kernel + rootfs (data URL)
 |    |- boot() -> progress bar
 |- restore VM snapshot (if any)
 |- init LLM:
 |    |- check model cache
 |    |- if absent: download shards (progress)
 |    |- load weights -> engine
 |- warmup: 1-token generation (compile shaders)
 |- VM health check: uname -a, bash --version
 |- UI ready -> enable chat input
```

### 5.3 Persistence save / restore

```text
save:  v86.fs.save() -> Uint8Array -> Blob -> IndexedDB.put("snapshots", "vm-current", blob)
load:  IndexedDB.get("snapshots", "vm-current") -> Blob -> v86.fs.load(bytes)

fallback (API-independent):
save:  VM.run("tar czf - / --exclude=/proc --exclude=/sys --exclude=/dev | base64 -w0")
       -> capture serial -> base64 -> IndexedDB
load:  base64 -> VM.run("base64 -d | tar xzf -") -> restore
```

### 5.4 Error / retry paths

```text
LLM output
 |- valid <tool_call> -> execute -> append result -> next turn
 |- malformed -> corrective prompt -> retry (max 2) -> if still bad: ask user
 |- no tool call, no text -> "please continue" -> retry
 |- repeated identical call x3 -> inject hint -> next turn
 |- tool timeout -> Ctrl-C -> return "timed out" -> next turn
 |- max iters / wall clock -> partial summary -> return
```

## 6. Performance Budget & Benchmarks

### 6.1 Target metrics (v0.1)

| Metric | Target | How to measure |
|---|---|---|
| Cold start, model cached, VM snapshot cached | < 8 s | `performance.now()` at phases; UI splash timer |
| Cold start, model cached, no VM snapshot | < 12 s | Same |
| Model download (1.5B, 20 Mbps) | ~80 s | Engine progress callback |
| Model load from cache (1.5B) | 1–3 s | Engine load timer |
| First token (WebGPU) | < 1.5 s | Time to first streamed token |
| First token (WASM) | < 4 s | Same |
| Generation (1.5B, WebGPU, M1) | 50–80 tok/s | Token count / elapsed |
| Generation (1.5B, WASM, M1) | 8–15 tok/s | Same |
| Tool round-trip (`ls`) | < 100 ms | `VM.run` timer |
| Tool round-trip (`git status`) | < 500 ms | `VM.run` timer |
| Memory footprint (1.5B + 256 MB VM) | < 3 GB | `performance.memory` (Chrome), Activity Monitor |
| Single-file size | < 100 MB | `ls -lh dist/ghostshell.html` |

### 6.2 Benchmark harness

- `bench/llm.mjs`: load a model, generate N tokens, report tok/s, first-token latency, peak memory.
- `bench/vm.mjs`: boot v86, run a command suite (`ls`, `git status`, `python3 -c …`), report latency.
- `bench/e2e.mjs`: Playwright drives the real HTML, sends a message, measures end-to-end.
- Run on: M1 Pro 16 GB, i5-1240P 16 GB, RTX 4060 laptop, low-end 8 GB laptop. Publish numbers in the README.

### 6.3 Bottlenecks and mitigations

| Bottleneck | Why | Mitigation |
|---|---|---|
| Model download (first run) | 1–2 GB from CDN | Progress bar, resumable shards, 1.5B default, model picker |
| WebGPU shader compilation | First generation is slow | Warmup call at startup; browser pipeline cache |
| v86 boot | Kernel + rootfs init | 256 MB RAM, Alpine, no unnecessary services |
| Emulated CPU (compiles) | TCG is ~5–20× slower than native | Pre-bake toolchains; use `tcc` for small C; set expectations |
| KV cache memory | Grows with context | 4k default; 8k+ with compaction in v1.0 |
| Single-threaded WASM | No COOP/COEP on some hosts | Host with headers; document the speed cost |
| IndexedDB snapshot write | 40–80 MB write | Debounce, async, "Saving…" indicator |

## 7. Risks & Mitigations

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| 1 | Small models cannot reliably emit valid tool calls | High | Critical | Hermes-style delimited format; corrective retries; eval-driven model choice (Qwen2.5); fallback to "manual tool syntax" mode |
| 2 | Model download fails or is too slow | High | High | Resumable shards; 1.5B default; progress + retry; mirror config |
| 3 | WebGPU unavailable or broken | Medium | High | WASM SIMD fallback; feature detection; clear warning |
| 4 | Hosting lacks COOP/COEP → single-threaded WASM | Medium | High | Host on Netlify/Cloudflare Pages with headers; document fallback speed |
| 5 | XSS via agent/VM output | Medium | Critical | `textContent` only; no `innerHTML`; CSP; optional sandboxed iframe |
| 6 | v86 escape / emulator bug | Low | Critical | Pin v86; disable unused devices; no host access; monitor security issues |
| 7 | Memory blowup on 8 GB machines | Medium | High | 1.5B default; 4k context; memory monitor; graceful OOM handling |
| 8 | "No server" vs VM networking contradiction | High (scope) | Medium | Default `off` (no network backend) with a frozen image; `inbrowser`/`fetch` need no relay; `wisp` is opt-in with a user-supplied proxy and a warning |
| 9 | IndexedDB quota / eviction loses sessions | Medium | High | `storage.persist()`; usage warning; export/import; explicit "Save snapshot" |
| 10 | Single-file size > 100 MB | Medium | Medium | Alpine image; slim build (CDN image); gzip/brotli; accept 60–85 MB |
| 11 | Model license restrictions | Medium | Medium | Default to Apache-2.0 (Qwen2.5, SmolLM2); document licenses |
| 12 | v86 npm package stale / unmaintained | Medium | Medium | Vendor the build; pin commit; fork if needed |
| 13 | Compiles in the VM are too slow | High | Medium | Pre-bake toolchains; `tcc`; scope v0.1 to scripting tasks |
| 14 | `file://` breaks IndexedDB / COOP | Medium | Medium | Recommend a static host; test and document |

**What could kill the project:** (1) tool-calling reliability of small models — if the eval suite shows <60 % success, the product is a toy; (2) memory/perf on mainstream laptops — if 3B is unusable, v0.1 must ship 1.5B and be honest about limitations; (3) the "no server" promise conflicting with the model download — if users expect fully offline, the messaging must be clear.

## 8. MVP Scope (v0.1)

### 8.1 Exact feature list

**Ships:**

1. Single static HTML file (inlined app + v86 + Alpine image).
2. Alpine VM with `bash`, `git`, `python3`, `nodejs`; 256 MB RAM; no network.
3. Qwen2.5-1.5B-Instruct Q4_K_M (default) and Qwen2.5-3B-Instruct Q4_K_M (quality option); WASM backend.
4. Agent loop with 5 tools: `bash`, `read_file`, `write_file`, `list_dir`, `search`.
5. 4k context, 20 iterations, 300 s wall clock, 60 s per command.
6. Chat UI: streaming, tool-call cards, Stop button, status bar.
7. Raw VM terminal (v86 framebuffer + serial).
8. Persistence: conversations + VM snapshot in IndexedDB; autosave.
9. Settings: model, temperature, max tokens, theme, clear data.
10. Export/import conversation as JSON.

**Cuts (deferred to v1.0):** WebGPU fast path (auto-fallback to WASM), diff viewer, file browser, multi-session with per-conversation snapshots, VM networking, `edit_file` / `ask_user` / `web_fetch`, mobile layout, PWA/service worker, model eval leaderboard, Web Worker offloading.

### 8.2 Milestones and timeline (solo engineer, ~6 weeks)

| Week | Milestone | Deliverable |
|---|---|---|
| 0 (spike, 3–5 d) | **M0: Go/no-go** | v86 boots Alpine + fs persistence spike; Transformers.js 3B load + stream spike; measure tok/s, memory, image size. Decision on runtime + model. |
| 1 | **M1: VM round-trip** | `VM` module: boot, `run()`, sentinel parsing, snapshot save/restore. E2E test: `echo hello` from the browser. |
| 2 | **M2: LLM round-trip** | `LLMEngine` + `TransformersEngine`; load from cache/CDN; stream tokens; token counter. |
| 3 | **M3: Agent round-trip** | Agent loop + tool parser + 5 tools; 20-task eval harness; corrective retries. |
| 4 | **M4: UI + persistence** | Chat, terminal, settings, status bar; IndexedDB schema; autosave; export/import. |
| 5 | **M5: Single file + hardening** | `vite-plugin-singlefile` build; size/perf pass; XSS/escaping; CSP; README. |
| 6 | **M6: Dogfood + cut** | Use it for real tasks; fix bugs; write docs; tag v0.1. |

**Go/no-go criteria for M0:**

- v86 boots Alpine and runs `git status` in < 10 s on M1.
- Transformers.js streams 1.5B at > 10 tok/s (WASM) / > 30 tok/s (WebGPU).
- Boot image (with tooling) compresses to < 80 MB.
- A 3B model + 256 MB VM fits in < 4 GB RAM.
- A 20-task tool-call eval shows > 60 % success for at least one candidate model.

If any criterion fails, v0.1 ships a smaller model or drops a feature — not a later date.

## 9. Repo Structure

```text
ghostshell/
├── index.html                  # entry; everything inlined at build
├── package.json                # pinned deps
├── vite.config.ts              # singlefile build
├── tsconfig.json
├── README.md                   # what it is, how to run, privacy, limits
├── LICENSE
├── src/
│   ├── main.ts                 # boot: settings -> VM -> LLM -> UI
│   ├── ui/
│   │   ├── chat.ts             # message list, streaming, Stop
│   │   ├── terminal.ts         # v86 canvas + xterm.js
│   │   ├── filetree.ts         # list_dir -> tree
│   │   ├── diff.ts             # jsdiff view
│   │   ├── settings.ts         # modal
│   │   ├── statusbar.ts        # model, tok/s, VM, save state
│   │   ├── markdown.ts         # strict, escaped renderer
│   │   └── theme.ts            # dark/light CSS vars
│   ├── agent/
│   │   ├── loop.ts             # the agent loop
│   │   ├── prompt.ts           # system prompt + few-shot
│   │   ├── parser.ts           # <tool_call> -> ToolCall[]
│   │   ├── tools.ts            # tool registry + validation
│   │   ├── tools/
│   │   │   ├── bash.ts
│   │   │   ├── read-file.ts
│   │   │   ├── write-file.ts
│   │   │   ├── list-dir.ts
│   │   │   └── search.ts
│   │   └── context.ts          # token counting + compaction
│   ├── vm/
│   │   ├── v86.ts              # V86 wrapper, boot, serial
│   │   ├── run.ts              # sentinel command runner, timeout
│   │   ├── snapshot.ts         # fs save/restore, tar fallback
│   │   └── image.ts            # build-time image metadata
│   ├── llm/
│   │   ├── engine.ts           # LLMEngine interface
│   │   ├── transformers.ts     # Transformers.js impl
│   │   ├── webllm.ts           # WebLLM impl (v1.0)
│   │   └── models.ts           # model registry, URLs, sizes
│   ├── store/
│   │   ├── db.ts               # idb open + schema
│   │   ├── conversations.ts
│   │   ├── snapshots.ts
│   │   ├── settings.ts
│   │   └── export.ts           # JSON/ZIP via fflate
│   └── util/
│       ├── sanitize.ts         # escape/DOMPurify
│       ├── timing.ts           # performance marks
│       ├── stream.ts           # token batching
│       └── log.ts              # debug logger
├── assets/
│   ├── v86/                    # v86.wasm, v86-fallback.wasm (vendored)
│   └── images/                 # alpine rootfs, kernel, initrd
├── bench/
│   ├── llm.mjs
│   ├── vm.mjs
│   └── e2e.mjs
├── test/
│   ├── unit/                   # parser, tools, diff, context
│   └── e2e/                    # Playwright: boot, chat, tool round-trip
├── docs/
│   ├── architecture.md
│   ├── security.md
│   └── models.md
└── dist/
    └── ghostshell.html         # the artifact
```

**Module boundaries:** `ui/` never imports `vm/` directly (goes through `agent/`); `agent/` never touches IndexedDB (goes through `store/`); `llm/` and `vm/` are independent and communicate only via the agent loop.

## 10. Open Questions

| # | Question | Why it matters | How to resolve |
|---|---|---|---|
| 1 | Transformers.js vs WebLLM: which is faster and more reliable in practice? | Determines the default runtime and the size budget | M0 spike: run both on 1.5B/3B, measure tok/s, memory, first-token, tool-call stability |
| 2 | Does v86 expose filesystem serialization (`fs.save()`), and how fast is it? | Determines the persistence mechanism | M1 spike: try the API; benchmark a 50 MB fs save; fall back to tar-over-serial |
| 3 | Can we set COOP/COEP on the target host, or is single-threaded WASM fast enough? | 3–10× speed difference on 3B+ | Host on Netlify/Cloudflare Pages; benchmark both |
| 4 | 1.5B vs 3B: quality vs speed/memory | The core product tradeoff | 20-task eval with both; measure success rate and tok/s |
| 5 | XML `<tool_call>` vs JSON fenced vs native function calling | Parse reliability drives the loop | M3 eval: 100 tool calls across 3 models, measure parse success |
| 6 | Stock Alpine vs custom Buildroot image | Image size (40 MB vs 10 MB) | Build a Buildroot image; measure size, boot time, tool availability |
| 7 | Is "no VM network" acceptable for v0.1? | Users expect `apt-get` | Dogfood: try to build a real project offline; if painful, ship an offline package cache |
| 8 | Single file (60–85 MB) vs HTML + CDN image (5 MB) | Load time, "single file" promise | Measure first-load time; offer both builds |
| 9 | Is mobile worth supporting at all? | RAM/CPU limits | Test on an iPad/Android tablet; likely cut |
| 10 | Which v86 version to pin, and should we vendor it? | Supply chain | Check npm `v86` latest; vendor the wasm + build files |
| 11 | WebGPU-only (drop WASM fallback) to reduce complexity? | Maintenance burden | Decide after M0; keep both if time allows |
| 12 | License-safe default model? | Legal | Qwen2.5 (Apache-2.0) or SmolLM2 (Apache-2.0); avoid Llama/Gemma for the default |

## Appendix A: Prompt Template (v0.1)

```text
You are GhostShell, an AI coding agent running in a sandboxed Linux VM.
You have tools: bash, read_file, write_file, list_dir, search.

To call a tool, output exactly one <tool_call> block and nothing else:
<tool_call>
{"name": "bash", "arguments": {"command": "ls -la"}}
</tool_call>

After the tool result, continue reasoning. When the task is complete,
answer the user directly.

Rules:
- One tool call per turn.
- Work in /root/workspace unless the user says otherwise.
- With the default `off` network mode the VM has no network; do not try to download anything unless the user enables a network mode.
- Read files before editing them.
- Prefer small, focused changes.
- If a command fails, read the error and try a different approach.
```

Plus 2 few-shot examples (one bash, one write_file) in the system message.

## Appendix B: v86 Image Build Recipe (sketch)

```bash
# On a host with v86 built from source:
# 1. Boot the stock Alpine image in v86.
# 2. Run in the guest:
apk add --no-cache git python3 py3-pip nodejs npm bash curl ca-certificates
mkdir -p /root/workspace
# 3. Save the filesystem image (v86's fs save, or tar-over-serial fallback).
# 4. Record sha256sum; copy to assets/images/.
# 5. Boot it once in the browser build and verify `git --version`.
```

## Appendix C: Milestone Exit Criteria

| Milestone | Exit criteria |
|---|---|
| M0 spike | All go/no-go criteria in §8.2 pass; runtime + model chosen |
| M1 VM | `echo hello` round-trip from the browser; snapshot save/restore works |
| M2 LLM | Streams tokens from a cached model; token counter accurate ±5 % |
| M3 Agent | 20-task eval: ≥60 % tool-call success; retries work; Stop works |
| M4 UI | Chat + terminal + settings usable; autosave verified after reload |
| M5 Build | Single HTML < 100 MB; loads from a static host; no console errors |
| M6 v0.1 | Dogfooded on 5 real tasks; README complete; tagged |

## Appendix D: Glossary

| Term | Meaning |
|---|---|
| v86 | WASM x86 emulator (copy.sh) that boots Linux in the browser |
| WebLLM | MLC's browser LLM runtime (TVM → WASM/WebGPU) |
| Transformers.js | Hugging Face's ONNX-based browser ML library |
| ORT | ONNX Runtime; `onnxruntime-web` is the browser build |
| GGUF | llama.cpp model format; many quantizations (Q4_K_M, etc.) |
| KV cache | Key/value attention cache; grows with context length |
| COOP/COEP | Headers needed for `SharedArrayBuffer` / threaded WASM |
| SLIRP | User-space TCP/IP stack; v86 implements one in the page and carries packets through its network adapter (`fetch`, `inbrowser`, or a WISP proxy) |
| Hermes format | `<tool_call>{"name":…, "arguments":…}</tool_call>` convention |

---

*End of document.*

