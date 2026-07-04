# Standards

Repo-agnostic standards are vendored from
[`n3ary/standards/standards/`](https://github.com/n3ary/standards/tree/main/standards).
The vendored copies carry a `<!-- synced from n3ary/standards@<sha> on <date} -->` header.
The shared standards sync CI on n3ary/standards opens vendor PRs in this repo when a shared standard changes.

**Don't edit vendored standards locally.** Edits will be overwritten by the next sync. To change a shared standard, edit it in `n3ary/standards/standards/` instead.

The drift check workflow (`.github/workflows/check-standards-drift.yml`) fails a PR if a vendored copy is out of date with `n3ary/standards@main`.

## Vendored (from `n3ary/standards`)

- `agent-worktrees.md`
- `core-principles.md`
- `diagramming.md`
- `documentation.md`
- `issue-plan-lifecycle.md`
- `naming.md`
- `testing.md`
- `verification.md`
- `version-management.md`

## Local (neary-specific)

- `feed-agnostic.md` — the "no per-feed exceptions in app code" rule is specific to the neary PWA's contract with feed data. The producer repos (`neary-gtfs`, `cluj-napoca-gtfs-adapter`) are upstream of neary's data and don't apply.

## When you add a new standard

1. **Cross-repo?** → put it in `n3ary/standards/standards/` and add it to `SHARED-STANDARDS.md`. The sync CI will vendore it here.
2. **neary-specific?** → put it in this directory. Don't add it to the manifest.

## How to sync locally

```bash
# From the n3ary/standards repo checkout:
node scripts/vendor-standards.mjs --local /tmp/vendor-test
cp /tmp/vendor-test/* docs/standards/
git add docs/standards/
git commit -m "chore(standards): vendor from n3ary/standards"
```

Or wait for the auto-sync PR from `n3ary/standards@main` when standards change.