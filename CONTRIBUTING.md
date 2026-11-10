# Contributing to GhostShell

GhostShell is built **in the open, the agentic way**. Every change follows the
same loop:

```
issue → branch → implement → test → PR → review → fix → merge → release
```

## Ground rules

1. **Conventional commits.** `feat:`, `fix:`, `refactor:`, `docs:`, `test:`,
   `chore:`, `perf:`, `ci:`. Scope is optional but encouraged (`feat(vm):`).
2. **One concern per PR.** Small, reviewable, mergeable. Aim for <400 lines.
3. **Tests for new behavior.** `bun run test` must pass before you open a PR.
4. **Typecheck before push.** `bun run typecheck` must be clean.
5. **No secrets. Ever.** If you find one, rotate it and open a security issue.
6. **Docs with behavior.** User-facing changes update README or docs/.
7. **Comments explain why, not what.** The code explains what.

## Branch naming

```
feat/<slug>     new feature
fix/<slug>      bug fix
docs/<slug>     documentation
refactor/<slug> refactor
spike/<slug>    research / experiment
```

## Commit format

```
<type>(<scope>): <description>

[optional body]

[optional footer: Closes #123]
```

Example:

```
feat(vm): boot Alpine i386 and expose serial to the agent

Implements the v86 bootstrap with a pre-baked Alpine image and wires the
serial port through the event bus. Serial output is buffered per line so the
Twin-View can link tool calls to terminal lines.

Closes #16
```

## Pull requests

- Fill in the PR template.
- Link the issue with `Closes #N`.
- Request review from `@10xdev4u-alt`.
- Keep the discussion technical and kind. Review the code, not the author.
- A PR is merged when: CI is green, one approval, no open concerns.

## Review guidelines

- **Correctness first.** Does it do what the issue asked? Does it break anything?
- **Tests.** Are edge cases covered? Would you trust this in production?
- **Simplicity.** Is there a smaller way? Flag premature abstraction.
- **Security.** Any new egress, any unsanitized input, any new dependency?

## Development setup

```bash
git clone https://github.com/10xdev4u-alt/ghostshell
cd ghostshell
bun install
bun run dev
```

## Code of conduct

Be respectful. Assume good intent. Disagree with ideas, not people. Harassment
of any kind is not tolerated.
