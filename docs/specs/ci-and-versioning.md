# CI and versioning

How PR validation, version bumps, and production deploys work — and the
reasoning that isn't obvious from the YAML.

## Workflows

- [.github/workflows/pr-validation.yml](../../.github/workflows/pr-validation.yml) — runs on PRs targeting `main`.
- [.github/workflows/deploy-production.yml](../../.github/workflows/deploy-production.yml) — runs on push to `main`.

## PR validation flow

```
Open PR (target=main)
  ├─ checkout PR branch
  ├─ setup node v24 (actions/setup-node@v6)
  ├─ npm ci
  ├─ auto-bump version to (main version + 1)   ← see below
  ├─ npm run check  (svelte-kit sync && svelte-check)
  ├─ npm test
  └─ npm run build
```

## Auto-bump reasoning

The validation workflow inspects the diff between `origin/main...HEAD`:

- If the PR only touches `.github/**`, skip the bump (no user-facing change).
- Otherwise, read `package.json#version` on `main`, add 1 to the patch,
  and write it to the PR branch as a bot commit.

**Why bump on the PR branch (not on merge)**: the deploy workflow on `main`
needs the version already incremented when it runs, so the published
bundle reports the right number. Bumping in PR keeps `main` strictly
linear and avoids a race between merge and bump.

**Why patch-only**: this project has no API consumers; semver minor/major
distinctions don't carry meaning. Every shipped change bumps patch.

## Deploy flow

```
Push to main
  └─ deploy-production.yml
       ├─ checkout
       ├─ setup node v24 (actions/setup-node@v6)
       ├─ npm ci
       ├─ npm run build
       └─ cloudflare/wrangler-action@v3 → wrangler pages deploy build --project-name=app --branch=main
```

Concurrency: `production-deploy` with `cancel-in-progress` so a fast-second
merge doesn't run two deploys.

Skip rule: skips when the head commit message contains `[skip ci]` (safety
net for bot-only commits).

## Branch protection assumptions

- "Require branches to be up to date" must be on, so the auto-bump can't
  collide with a fresh merge on `main`.
- PR validation is required to pass.

## Why this is documented separately from the workflows

The workflow YAML expresses the steps; this doc expresses **why** each
step exists. Future agents editing the workflows should read this first
to avoid removing a safety they don't recognize.
