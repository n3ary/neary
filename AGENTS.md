# Agent guide

Canonical instructions for any AI agent working in this repo (Copilot, Claude
Code, Cursor, etc.). Read this once per session before making changes.

This file owns the "how to work here" rules. Code conventions live in
[docs/standards/](docs/standards/). Domain vocabulary lives in
[docs/concepts/](docs/concepts/).

## Read order

1. This file — how to work in this repo.
2. [docs/README.md](docs/README.md) — what's in `docs/` and where to find it.
3. [docs/architecture/system-overview.md](docs/architecture/system-overview.md) — what the system is.
4. The specific file you need to change.

Do not load entire directories speculatively. Three small targeted reads
beat one big traversal.

## Core rules

Coding principles (KISS, DRY) live in [docs/standards/core-principles.md](docs/standards/core-principles.md).
The rules below are how those principles apply to agent behavior in this repo.

### Verify before you state

- Read the actual file, run the actual command, query the actual store.
- Don't infer from memory or training data.
- When stating a fact about the code, cite the source path.
- When uncertain, say so — "I think" beats a confident wrong answer.

### Code is the source of truth

- If behavior is in the code, don't restate it in docs.
- Specs only exist where reasoning isn't in the code — see [docs/specs/README.md](docs/specs/README.md).
- When code and docs disagree, the code is right; fix the doc.

### Edit, don't author

- Read files before modifying them.
- Don't create files unless they're necessary.
- Prefer updating an existing file over adding a new one.

### Minimal change

- Only make changes that are directly requested or clearly necessary.
- Don't refactor unrelated code "while you're there".
- Don't add comments unless they explain a non-obvious WHY (hidden constraint,
  subtle invariant, workaround). Never restate what the code says.
- Don't add error handling for cases that can't happen — trust internal code.

### Follow the placement framework

When adding a doc, ask in order — see [docs/standards/documentation.md](docs/standards/documentation.md):

1. Is the answer in the code? → don't write a doc.
2. Is it a shared term? → `docs/concepts/`.
3. Is it a rule the codebase MUST follow? → `docs/standards/`.
4. Is it a contract whose reasoning isn't in code? → `docs/specs/`.
5. Is it future work? → `docs/plan/`.
6. Is it historical analysis? → `docs/investigation/`.
7. Is it a system-level diagram? → `docs/architecture/`.

If none match cleanly, the doc probably shouldn't exist.

### Update affected indexes

When you add a doc, also update:

- The directory's own `README.md` so the new file is listed.
- The parent's `README.md` if a new subdirectory was added.

### Terminology

Use the canonical names from [docs/concepts/terminology.md](docs/concepts/terminology.md).
Do not introduce new synonyms.

## What NOT to do

> [!CAUTION]
> The following are explicit anti-patterns. Do not introduce them.

- **Don't restate code in docs.** Docs cover what's NOT obvious from reading [src/](src/).
- **Don't add rationale paragraphs to standards.** Rationale belongs in git/PR descriptions, not in the rules.
- **Don't add timelines or dates that go stale.** "As of 2026-Q3" rots. Use git history for "when".
- **Don't copy-paste content from another repo.** Link to the source instead.
- **Don't include tutorials for popular libraries.** Link to upstream docs.
- **Don't pile multiple unrelated topics into one file.** Split by topic.
- **Don't add `console.log` in production code.** If a log is genuinely useful, structured logging only.
- **Don't bypass safety checks** (e.g. `git push --force`, `--no-verify`) without explicit user approval.

## When you commit code

> [!IMPORTANT]
> The PR validation pipeline runs `npm run check && npm test && npm run build`.
> Confirm all three pass locally before you push.

- Commit message: short imperative subject ("fix: …", "feat(web): …"), optional body explaining the WHY for non-obvious changes.
- Keep PRs scoped — one logical change per PR. Don't bundle a refactor with a bug fix.
- Update the relevant spec or concept doc only if the change alters something the doc claimed.

## When you commit docs

- Run a quick grep for broken relative links in files you touched.
- Keep new files short (< 100 lines target, < 200 hard cap; plan docs may be longer).
- Always update the directory `README.md` index.

## CI and release

The auto-version + deploy flow is documented in
[docs/specs/ci-and-versioning.md](docs/specs/ci-and-versioning.md).
Don't change workflow files without reading that spec first.

## Asking for help

If a request is ambiguous, ask one focused question. Don't ask a battery of
clarifying questions; pick the one that actually unblocks you.
