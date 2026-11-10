# Fix Plan — GhostShell PR Triage (#30–#34)

**Date:** 2026-11-10
**Scope:** Triage of review findings on PRs #30 (`feat/vm`), #31 (`feat/llm`), #32 (`feat/agent`), #33 (`feat/persist`), #34 (`feat/security`).
**Method:** Every finding was re-verified against the PR-head files, the installed dependency sources (`node_modules/v86`, `node_modules/@huggingface/transformers`), and the live Hugging Face API. No source code was modified; nothing was merged or closed.

## Decision summary

| Decision | Count | Disposition |
|---|---|---|
| Fix now | **26** | 8 blockers + 18 majors → one issue each |
| Deferred (polish) | **33** | 5 per-PR `chore: polish pass` issues |
| False positives | **1** | `T_MKNOD` rdev encoding (see Notes) |

A finding is "fix now" when it breaks correctness, security, or a stated contract. Everything else is deferred to the per-PR polish pass.

### Per-PR totals

| PR | Branch | Blockers | Majors | Minors/nits deferred |
|---|---|---|---|---|
| #30 feat/vm | `feat/vm` | 2 | 4 | 8 (6 minors + 2 CodeRabbit) |
| #31 feat/llm | `feat/llm` | 1 | 5 | 7 (4 minors + 3 nits) |
| #32 feat/agent | `feat/agent` | 1 | 3 | 7 (5 minors + 2 nits) |
| #33 feat/persist | `feat/persist` | 3 | 2 | 5 (5 minors) |
| #34 feat/security | `feat/security` | 1 | 4 | 6 (3 minors + 3 nits) |

Review evidence:

- #30: [the-ai-developer](https://github.com/10xdev4u-alt/ghostshell/pull/30#pullrequestreview-PRR_kwDOVplGYs8AAAABXI54Tw), [coderabbitai](https://github.com/10xdev4u-alt/ghostshell/pull/30#pullrequestreview-PRR_kwDOVplGYs8AAAABXIkNuQ)
- #31: [the-ai-developer](https://github.com/10xdev4u-alt/ghostshell/pull/31#pullrequestreview-PRR_kwDOVplGYs8AAAABXJJMcw)
- #32: [the-ai-developer](https://github.com/10xdev4u-alt/ghostshell/pull/32#pullrequestreview-PRR_kwDOVplGYs8AAAABXJJTHA)
- #33: [the-ai-developer](https://github.com/10xdev4u-alt/ghostshell/pull/33#pullrequestreview-PRR_kwDOVplGYs8AAAABXI6CzA)
- #34: [10xdev4u-alt](https://github.com/10xdev4u-alt/ghostshell/pull/34#pullrequestreview-PRR_kwDOVplGYs8AAAABXIqBzQ)

## Findings and decisions

### PR #30 — feat/vm

| # | Severity | Location | Finding | Decision |
|---|---|---|---|---|
| 30-1 | Blocker | `src/core/vm/v86.ts:79-85` | `start()` calls `await emu.run()` immediately after `new V86()`. v86 0.5.473 assigns `this.v86` asynchronously inside a `.then()` on the WASM-load promise (`libv86-debug.mjs:6071`), and `run()` is `this.v86.run()` (`:6344-6346`). `this.v86` is still `undefined`, so `start()` always rejects with `TypeError`. | Fix now |
| 30-2 | Blocker | `src/core/vm/image.ts:36-37` | Default boot points at `images/alpine-rootfs-flat` and `images/alpine-fs.json`; neither exists on the branch (`images/` is absent), `scripts/build-image.sh` does not exist, and `.gitignore` ignores only `images/*.img`, `images/*.iso`, `images/build/`. CI never builds an image. The PR body's claim that the artifacts are built by `scripts/build-image.sh` and gitignored is inaccurate. | Fix now |
| 30-3 | Major | `src/core/vm/commands.ts:61` | Exit-code regex `(-?\d+)` has no terminator. The serial listener receives one byte at a time, so `__GS_DONE_<id>__ 127` settles with `exitCode: 1` as soon as the `1` arrives; codes ≥ 10 (and negatives) are truncated. | Fix now |
| 30-4 | Major | `src/core/vm/commands.ts:63-67` | The prompt is printed before the done line, so the body between markers ends with a prompt (e.g. `localhost:~# `). `cleanOutput`'s `echoed` removal only works when the wrapped command is in the body, which it is not on the normal path. `list()` then emits a bogus trailing entry. | Fix now |
| 30-5 | Major | `src/core/vm/v86.ts:133` | `LIST_TAB` is a raw `\t` in `stat -c '%F\t%s\t%Y\t%n'`. BusyBox ash's line editor treats tab as completion, so the command can be mangled before it runs. | Fix now |
| 30-6 | Major | `src/core/vm/v86.ts:134` | `path` is interpolated into `echo "list: not a directory: ${path}"` without `shellQuote()`, unlike the other three uses. A path containing `"`, `$`, or a backtick breaks out of the string. `path` is an API input. | Fix now |
| 30-7 | Minor | `src/core/vm/v86.ts:109-118` | `write()` retries on every `create_file` failure; permission/read-only/quota errors are not missing-parent errors. | Polish |
| 30-8 | Minor | `src/core/vm/commands.ts:88` | `stripAnsi` CSI regex `[0-9;?]*` does not cover intermediate bytes such as `:`. | Polish |
| 30-9 | Minor | `src/core/vm/v86.ts:139-143` | Filenames containing newlines break the line-oriented `stat` parser. | Polish |
| 30-10 | Minor | `src/core/vm/commands.ts:74-77` | `cleanOutput`'s `echoed` parameter is dead on the normal path. | Polish |
| 30-11 | Minor | `src/core/vm/image.ts:57-58` | `DEFAULT_IMAGE` placeholder: `sizeBytes: 0`, `url` points at the Docker Hub tag page. | Polish |
| 30-12 | Minor | sentinel names | `docs/ENGINEERING_PLAN.md` specifies `__GS_START__`/`__GS_END_<code>__`; code implements `__GS_BEGIN_<id>__`/`__GS_DONE_<id>__`. | Polish |
| 30-13 | Minor (CodeRabbit) | `src/core/vm/commands.ts:145-146` | Per-byte regex rebuild and full-buffer scan is O(n²) for large output. | Polish |
| 30-14 | Minor (CodeRabbit) | `tests/unit/vm.test.ts:90-99` | Mock never prints prompts or multi-digit exit codes, so it cannot catch 30-3/30-4. | Polish |

### PR #31 — feat/llm

| # | Severity | Location | Finding | Decision |
|---|---|---|---|---|
| 31-1 | Blocker | `src/core/llm/models.ts:39-47` | `resolveModelRepo` maps `Qwen/Qwen2.5-3B-Instruct-GGUF` to `onnx-community/Qwen2.5-3B-Instruct`, which returns HTTP 401 on the HF API (the 1.5B mapping returns 200). The model recommended by `recommendModel(true, >=12)` cannot load. | Fix now |
| 31-2 | Major | `src/core/llm/transformers.ts:392-409` | `applyChatTemplate` maps every message to `{role, content}`, dropping `toolCalls`/`toolResults`. The loop stores results on an assistant message (`src/core/agent/loop.ts:138`), so after one tool turn the prompt has no tool output. This is the LLM half of the contract bug whose agent half is 32-1. | Fix now |
| 31-3 | Major | `src/core/llm/transformers.ts:420-425` | `cache: 'opfs'` sets `env.useFSCache = true`; transformers.js's `useFSCache` is the Node `fs`-backed `FileCache` and throws `File System Cache is not available in this environment.` in a browser (`hub.js:458-464`, `env.js:40`). The package has no OPFS backend. `MODEL_CDN.cache = 'opfs'` (`src/config.ts:61`) names the option. | Fix now |
| 31-4 | Major | `src/core/llm/engine.ts:26-34` | `createEngine('transformers')` defaults `device` to `detectBackend()`, which returns `'webgpu'` when `navigator.gpu` exists. Both registry models declare `backend: 'wasm'`; `supportsBackend` is never called. A WebGPU browser builds a WebGPU engine for a WASM-only model. | Fix now |
| 31-5 | Major | `src/core/llm/grammar.ts:124-127` | `root` accepts only `{"tool_calls": [...]}`. A grammar-constrained model can never emit a final answer, so the loop retries until `maxRetries` and returns `error`. Latent today (transformers.js ignores `req.grammar`) but breaks the PR's stated purpose. | Fix now |
| 31-6 | Major | `src/core/llm/grammar.ts:197-203` | `ruleSlug` lowercases and replaces non-alphanumerics with `-`, so `read-file` and `read_file` both become `read-file`. Two tools whose names slug the same emit duplicate GBNF rules, which is a parse error in llama.cpp. Latent for the five built-ins. | Fix now |
| 31-7 | Minor | `src/core/llm/transformers.ts:216-222` | `toLoadProgress` reports `done` as 100% using `spec.sizeBytes` (the GGUF size), not the actual downloaded bytes. | Polish |
| 31-8 | Minor | `src/core/llm/transformers.ts:357-358` | `finishReason = 'error'` is assigned immediately before `throw`, so it is never observed. | Polish |
| 31-9 | Minor | `src/core/llm/transformers.ts:256-282` | `load` does not dispose a previously loaded generator. | Polish |
| 31-10 | Minor | `src/core/llm/transformers.ts:125-133` | `clearTransformersCache` resolves on `onblocked`, so the caller proceeds while the database still exists. | Polish |
| 31-11 | Nit | `src/core/llm/grammar.ts:50` | The `number` rule inherits llama.cpp's exponent quirk (`[1-9]{0,15}` rejects `1e10`). | Polish |
| 31-12 | Nit | `src/core/llm/grammar.ts:206-208` | `gbnfLiteral` does not escape control characters. | Polish |
| 31-13 | Nit | `src/core/llm/grammar.ts:141` | `buildToolCallSchema` returns `unknown` and has no caller. | Polish |

### PR #32 — feat/agent

| # | Severity | Location | Finding | Decision |
|---|---|---|---|---|
| 32-1 | Blocker | `src/core/agent/loop.ts:138` | Tool results are stored on an assistant message's `toolResults` field (`loop.ts:316-328`). The loop never emits a `tool` role message, which is what chat templates expect, and `applyChatTemplate` drops the fields entirely (31-2). After one tool turn the model sees an assistant message with empty content and no tool output, so observe → think → act → observe cannot continue. `MessageRole` already includes `'tool'`. | Fix now |
| 32-2 | Major | `src/core/agent/loop.ts:297-314` | `withTimeout` races the tool against a timer and ignores `signal`. The loop checks `signal.aborted` before each tool but not while one runs; an abort during a long tool waits for the tool (or `toolTimeoutMs`). Reproduced: a 5 s tool with `toolTimeoutMs: 10_000` took 5008 ms after an abort at 50 ms. | Fix now |
| 32-3 | Major | `src/core/agent/tools.ts:231-233` | A `pattern` beginning with `-` is parsed as a grep option. `search({pattern: '-v foo'})` → `grep -rn '-v foo' …` → `invalid option -- ' '`; `search({pattern: '--include=secret'})` is treated as an include filter and grep reads stdin. | Fix now |
| 32-4 | Major | `src/core/agent/compaction.ts:23` | `SUMMARY_HEADROOM_TOKENS` (128) is smaller than the summary it reserves room for (`SUMMARY_MAX_TOKENS = 300`, `loop.ts:37`). The result can exceed the budget by up to 172 tokens, so the next `compactIfNeeded` immediately re-compacts. Reproduced: `compactMessages(messages, 100, …)` with a 100-token summary returned 210 tokens. | Fix now |
| 32-5 | Minor | `src/core/agent/loop.ts:216-230` | Aborting during compaction inserts `Earlier conversation omitted.` as a summary system message. | Polish |
| 32-6 | Minor | `src/core/agent/parser.ts:105-147` | `retryWithCorrection` does not check the signal between attempts. | Polish |
| 32-7 | Minor | `src/core/agent/tools.ts:33-37` | `truncateOutput` can exceed `max` when the suffix is longer than `max`, and reports an inaccurate removed count. | Polish |
| 32-8 | Minor | `src/core/agent/loop.ts:154-159` | `iterations` is inconsistent: `iterations + 1` on the retries-exhausted path, `iterations` in the catch block. | Polish |
| 32-9 | Minor | `src/core/agent/loop.ts:282-288` | A timed-out tool is not cancelled; its promise keeps running and the `SerialQueue` slot is freed, breaking serialization. | Polish |
| 32-10 | Nit | `src/core/agent/tools.ts:231` | `grep -rn` scans binary files and `.git`. | Polish |
| 32-11 | Nit | `src/core/agent/loop.ts:170-178` | The grammar is rebuilt on every `generate` call and every corrective retry. | Polish |

### PR #33 — feat/persist

| # | Severity | Location | Finding | Decision |
|---|---|---|---|---|
| 33-1 | Blocker | `src/core/vm/fs9p.ts:661-675, 807-830` | `readManifest` swallows JSON parse failures and returns `undefined`; `ensureLoaded`'s `catch` around `BigInt(entry.qidPath)` falls back to `emptyRoot()`. Either way the tree looks loaded but is empty, and the next `persistTree` overwrites `manifest.json` with an empty manifest. A corrupt/foreign manifest silently wipes the snapshot. | Fix now |
| 33-2 | Blocker | `src/core/persistence/snapshots.ts:156-198` | `LazyBlobStore` only falls back when `getDirectory()` rejects at `_resolveBackend()`. If OPFS initializes and a later `saveBlob`/`loadBlob`/`deleteBlob` fails (quota, eviction, write error), the error propagates and the snapshot is lost without falling back to IndexedDB. | Fix now |
| 33-3 | Blocker | `src/core/persistence/snapshots.ts:274-278` | For a plain `Database`, `delete()` skips `this.db.deleteSnapshot` (absent from the base interface) and `this.blobs` is `null`, so the `snapshots` row is left behind and remains readable. The PR body acknowledges the blob gap but not the row gap. | Fix now |
| 33-4 | Major | `src/core/vm/fs9p.ts:1150-1158` | `Tsetattr` reads `size, atimeSec, mtimeSec, atimeNsec, mtimeNsec`, but 9P2000.L `SETATTR` is `size, atime_sec, atime_nsec, mtime_sec, mtime_nsec`. v86's own decoder reads `"wwwwwddddd"` (`libv86-debug.mjs`). `SETATTR_MTIME` writes mtime seconds into `atimeSec`; mtime is never set and atime is corrupted. | Fix now |
| 33-5 | Major | `src/core/vm/fs9p.ts:792`, `src/core/vm/v86.ts` | `create9pHandler`/`handle9p` are never called by `V86VMHandle.buildOptions` or anywhere else in `src/`; the handler's only consumers are unit tests. The persistent filesystem is unreachable from the running app. | Fix now |
| 33-6 | Minor | `src/core/vm/fs9p.ts` | Dead COW helpers (`cowWrite`, `cowSetChild`, `cowRemoveChild`, `cloneTree`, `cloneNode`) and an unused `walk` with no cycle guard. | Polish |
| 33-7 | Minor | `src/core/vm/fs9p.ts` | `T_RENAMEAT` can create a directory cycle (`mv dir dir/sub`), making `walk()` recurse forever. | Polish |
| 33-8 | Minor | `src/core/vm/fs9p.ts` | `T_REMOVE`/`T_UNLINKAT` never remove the blob, and `persistTree` never prunes unreferenced blobs. | Polish |
| 33-9 | Minor | `src/core/vm/fs9p.ts` | `T_VERSION` payload validation sits outside the try/catch, so a bad payload becomes an unhandled rejection and the guest's 9p request hangs. | Polish |
| 33-10 | Minor | `src/core/vm/fs9p.ts:1135, 1289` | `T_GETATTR` reports `blocks: 0` for empty files; v86 reports `Math.floor(size / 512 + 1)` = 1 (`libv86-debug.mjs:13237`). The `T_MKNOD` rdev encoding matches v86's own (`major << 8 | minor`, `libv86-debug.mjs:13234`) — see Notes. | Polish (blocks only) |

### PR #34 — feat/security

| # | Severity | Location | Finding | Decision |
|---|---|---|---|---|
| 34-1 | Blocker | `src/core/vm/network.ts:35-41, 50-75` | `NetDevice` targets `backend`/`url`/`peer_mac`/`peer_ip`, none of which exist on v86's `V86NetworkDevice`. v86 selects the adapter from `net_device.relay_url` (`"fetch"`, `"inbrowser"`, `wisp://`/`wisps://`) and reads `router_mac`/`router_ip` (`libv86-debug.mjs:6188-6192`). Every mode is a silent no-op; `buildNetDevice({mode:'fetch'})` returns `{backend:'fetch'}`, so `relay_url` is undefined and no adapter is constructed. | Fix now |
| 34-2 | Major | `src/core/vm/network.ts` | `buildNetDevice` has no caller; `V86VMHandle.start` (`src/core/vm/v86.ts:48-56`) builds `V86Options` without `net_device`. Even with the correct shape, network mode is not wired end-to-end. | Fix now |
| 34-3 | Major | `src/core/security/egress.ts:34-44, 209-221` | Lockdown is bypassable by `new Worker()`/`SharedWorker`/`ServiceWorker`/`importScripts()`, dynamic `import()`, and subresource loads (`<script src>`, `<link href>`, `<img src>`/`srcset`, `<iframe src>`, `<source>`/`<video>`/`<audio>`/`<track>`, `<embed>`, `<object data>`, `<form action>`, CSS `@import`/`url()`). The plan's second enforcement layer (CSP) is absent, so the interceptor is the only app-layer lockdown; the doc comment overclaims. | Fix now |
| 34-4 | Major | `src/core/security/attestation.ts:171-189` | `verifyReport` calls `resolvePublicKey` → `importPublicKeyJwk`, which rejects with a `DataError` for a malformed JWK (e.g. `{kty:'oct', k:'AAAA', alg:'HS256'}`). A verification API should fail closed with `false`, not throw. | Fix now |
| 34-5 | Major | `src/core/security/attestation.ts:134-143`, `src/ui/settings.ts:75-108` | `signReport(report)` with no key generates an ephemeral key and returns an unverifiable signature, labeled "Signature (ECDSA P-256)". `signReport`, `verifyReport`, and `renderPrivacyReport` are called nowhere in `src/` (only tests); `FLAGS.privacyAttestation` is unused. The signed, exportable report is dead code. | Fix now |
| 34-6 | Minor | `src/core/security/egress.ts:76-87` | `input instanceof Request` fails across realms, so the logged method falls back to `GET`. | Polish |
| 34-7 | Minor | `src/ui/settings.ts:56-68` | Revoking the object URL on `setTimeout(0)` can cancel the download in some engines. | Polish |
| 34-8 | Minor | `tests/unit/egress.test.ts:222-232` | Restore test covers fetch/WebSocket/EventSource but not `XMLHttpRequest.prototype.open`, `navigator.sendBeacon`, or global `sendBeacon`; the `Request`-input method branch is untested. | Polish |
| 34-9 | Nit | `src/core/security/attestation.ts:43-55` | `buildReport` is `async` with no `await`. | Polish |
| 34-10 | Nit | `src/core/security/attestation.ts:88-97` | `canonicalize` silently drops unknown top-level fields. | Polish |
| 34-11 | Nit | `src/core/vm/network.ts:15` | `NetworkBackend` includes `'wsproxy'`, but `AgentConfig.networkMode`, `isNetworkMode`, and the settings `<select>` do not. | Polish |

## Proposed fixes

### Blockers

**#30-1 — await v86 WASM init before `run()`.** Await the `emulator-loaded` event (or `continue_init`) before calling `run()`, or pass `autostart: true` and drop the manual `run()`. Acceptance: `start()` resolves on a real (non-mocked) `V86`; a unit test that does not mock `run()` passes.

**#30-2 — make the default boot image real or explicitly deferred.** Either commit the rootfs artifacts (or add `scripts/build-image.sh` and a CI job that builds them) or change `DEFAULT_IMAGE` to a documented, fetchable URL and correct the PR body/review note. Acceptance: the default config points at an artifact that exists and is either committed or built by a checked-in script; `.gitignore` matches the artifact paths.

**#31-1 — point the 3B model at a real ONNX repo.** Map `Qwen2.5-3B-Instruct-GGUF` to an existing `onnx-community` conversion, or fail `load()` with a clear "no ONNX conversion for this model" error. Acceptance: `resolveModelRepo` for every registry model returns a repo that responds 200 on the HF API; `recommendModel(true, >=12)` resolves to a loadable model.

**#32-1 — emit tool results as `tool` role messages.** In the loop, emit one `tool` message per result (the `Message` type already supports the role) instead of attaching `toolResults` to the assistant message. Acceptance: after a tool turn, the next request's messages contain the tool output; a test asserts the emitted role and content.

**#33-1 — fail closed on a corrupt manifest.** Reject the mount (or otherwise refuse to persist) when `manifest.json` fails to parse or a node's `qidPath` is not an integer. Never allow an empty/foreign manifest to overwrite an existing one. Acceptance: a corrupt manifest surfaces as an explicit error and the existing `manifest.json` is unchanged after a persist attempt.

**#33-2 — fall back to IndexedDB on runtime OPFS failure.** Wrap `saveBlob`/`loadBlob`/`deleteBlob` (or the store's operations) so a runtime OPFS error triggers the IndexedDB fallback, not just a `getDirectory()` failure at resolution. Acceptance: with OPFS initialized, a forced save failure falls back to IndexedDB and the snapshot is retained.

**#33-3 — delete the snapshot row for a plain `Database`.** Add `deleteSnapshot` to the base `Database` interface (and implement it), or fail `delete()` explicitly. Acceptance: `delete()` removes the row for any `Database` implementation; a test covers the plain-DB path.

**#34-1 — map `NetDevice` to v86's real contract.** Replace `backend`/`url`/`peer_mac`/`peer_ip` with `relay_url` (`'fetch' | 'inbrowser' | 'wisp://…' | 'wisps://…' | 'ws://…'`) and `router_mac`/`router_ip`; drop `wsproxy` or implement it as the raw `ws://` relay. Acceptance: every mode produces a `relay_url` value v86 recognizes, and a test asserts the adapter is constructed.

### Majors

**#30-3 — terminate the exit-code sentinel.** Match `__GS_DONE_<id>__ (-?\d+)` up to a non-digit (or end of line), and delay `finish()` until the line is complete. Acceptance: a multi-digit code (e.g. `127`) is reported as `127`; add a byte-at-a-time test.

**#30-4 — strip the trailing prompt.** Remove the prompt from the body between markers (e.g. strip a trailing `…# `/`…$ ` line) or model it in `cleanOutput`. Acceptance: `stdout` does not end with a prompt; `list()` emits no bogus trailing entry.

**#30-5 — avoid the raw tab.** Use a separator the shell will not interpret (e.g. `|`) and update the `stat` parsing. Acceptance: the `list()` command survives the busybox line editor.

**#30-6 — quote the error-branch path.** Apply `shellQuote(path)` in the `else` branch. Acceptance: a path containing `"`, `$`, or a backtick does not break the command.

**#31-2 — preserve tool fields in the chat template.** Pass `toolCalls`/`toolResults` through to the tokenizer (and, per #32-1, feed a `tool` role message the template accepts). Acceptance: a mocked pipeline shows tool output in the next prompt.

**#31-3 — remove or implement `opfs`.** Implement an OPFS-backed `env.customCache` (`match`/`put` are enough) or remove the option and the `MODEL_CDN.cache` entry. Acceptance: `cache: 'opfs'` either works in a browser or is no longer a supported value.

**#31-4 — honor the model's backend.** Pass the `ModelSpec` into `createEngine`/`load` and validate `supportsBackend(spec, this.kind)`, downgrading to WASM when needed. Acceptance: a WASM-only model never builds a WebGPU engine; `supportsBackend` has a caller.

**#31-5 — add a final-answer alternative.** Extend `root` to admit a plain final answer (or a stop token the grammar can express). Acceptance: a test asserts the constrained grammar admits both a tool call and a final answer.

**#31-6 — disambiguate rule slugs.** Detect a slug collision and throw a clear error, or include a hash/disambiguator in the rule name. Acceptance: two tools named `read-file`/`read_file` produce a valid grammar.

**#32-2 — honor abort during tool execution.** Race the tool against `signal` as well as the timer (or pass the signal into the tool); ensure an abort rejection is not reported as a tool failure. Acceptance: an abort during a long tool returns promptly; a test covers it.

**#32-3 — protect leading-dash grep patterns.** Use `grep -rn -e <pattern> <path>` (or `--` before the pattern). Acceptance: `search({pattern: '-v foo'})` searches the literal pattern; a test covers `-`-prefixed patterns.

**#32-4 — size the compaction headroom.** Set `SUMMARY_HEADROOM_TOKENS` to the summary's max (or compute it from the actual summary length). Acceptance: `compactMessages` never returns a list exceeding `maxTokens`; a test asserts the final budget.

**#33-4 — correct the `Tsetattr` wire order.** Read `size, atime_sec, atime_nsec, mtime_sec, mtime_nsec` per 9P2000.L. Acceptance: `SETATTR_MTIME` sets mtime and leaves atime unchanged; a test models the wire order.

**#33-5 — wire the 9p handler into the VM.** Call `create9pHandler`/`handle9p` from `V86VMHandle.buildOptions` (or accept it via `V86Deps`). Acceptance: a test asserts the handler reaches the v86 filesystem options.

**#34-2 — wire `buildNetDevice` into `start()`.** Add `net_device` to `V86Options` from the config (or via `V86Deps`). Acceptance: a test asserts the device reaches the v86 options.

**#34-3 — close the lockdown gaps or narrow the claim.** Add a CSP meta tag as a second layer and/or patch worker/dynamic-import/subresource vectors; in any case narrow the doc comment to the covered surface and document the gaps. Acceptance: the comment matches the enforced surface; either the gaps are closed or the residual risk is documented.

**#34-4 — make `verifyReport` fail closed.** Wrap the import/verify in try/catch and return `false` on any error. Acceptance: a malformed JWK returns `false`; a test covers it.

**#34-5 — wire the attestation or declare it a follow-up.** Build → sign with a long-lived key → render → download in `App`, or state in the PR body that wiring is a follow-up. Acceptance: `renderPrivacyReport` is reachable from the UI with a verifiable signature, or the follow-up is documented.

## Dependency order

1. **#30 blockers** — the VM cannot boot at all; everything else depends on a running VM.
2. **#31-1 + #32-1 together** — the tool-result contract spans both modules; fix the loop's message shape and the chat template in the same pass.
3. **#31-3, #31-4, #31-5, #31-6** — LLM correctness and grammar.
4. **#32-2, #32-3, #32-4** — agent loop robustness.
5. **#33 blockers** — data-loss paths in persistence.
6. **#34-1 + #34-2** — network wiring; depends on #30-1 (a working `start()`).
7. **#34-3, #34-4, #34-5** — security surface and attestation.

## Notes

- **False positive — `T_MKNOD` rdev encoding (33-10).** The review claims Linux/modern v86 use `(major << 20) | minor` and that the handler's `(major << 8) | minor` is wrong. The vendored v86 0.5.473 encodes `rdev` as `major << 8 | minor` on `T_GETATTR` (`node_modules/v86/build/libv86-debug.mjs:13234`) and stores major/minor separately internally. The handler's encoding matches v86's own, so this sub-finding is not a bug relative to the v86 contract. The `blocks` off-by-one in the same finding is real (v86 computes `Math.floor(size / 512 + 1)`, which is 1 for an empty file; the handler returns 0).
- **Stale evidence in #33-3.** The review cites `deleteSessionBlobs()` and `deleteSession()` in `app.ts`; neither exists in the PR head, and the app always constructs `IdbDatabase` (which has `deleteSnapshot`). The core row-deletion gap for a plain `Database` is still real, but it is not currently reachable in the shipped app — treat it as a contract gap in the supported fallback rather than a live data-loss path.
- **CI is red on all five PRs** with `Cannot find dependency '@vitest/coverage-v8'` (pre-existing on `main`, noted in the #34 review). Not part of this triage, but it blocks the coverage gate.
- **Cross-PR contract bug.** #32-1 and #31-2 are one bug: the loop must emit `tool` role messages and `applyChatTemplate` must pass the tool fields through. Fix both together; neither fix alone restores the observe → think → act → observe cycle.
