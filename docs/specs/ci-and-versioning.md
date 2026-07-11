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
  └─ deploy-pwa.yml
       ├─ checkout
       ├─ setup node v24 (setup-node@v6)
       ├─ setup pnpm (auto-detected from packageManager field)
       ├─ pnpm install --frozen-lockfile  (NPM_TOKEN for @n3ary GH Packages scope)
       ├─ pnpm run build
       ├─ cloudflare/wrangler-action@v4 → wrangler pages deploy build --project-name=neary --branch=main
       ├─ Cloudflare API: purge zone cache for /_app/immutable/* + service-worker.js
       └─ Smoke test: GET a hashed worker file, assert CSP includes the expected origin
```

Concurrency: `production-deploy` with `cancel-in-progress` so a fast-second
merge doesn't run two deploys.

Skip rule: skips when the actor is `n3ary-release-bot[bot]` (the release
bot's version-only commits would re-deploy a byte-identical artefact, and
the actual deploy already happened via the squashed PR merge). Tracked in
the workflow header comment.

## Post-deploy cache purge — why it exists

The static `static/_headers` file is read at deploy time. The headers
(including `Content-Security-Policy`) get baked into the response and
**cached at the Cloudflare edge** on first request. Any subsequent change
to `_headers` does NOT reach files that are already in the edge cache --
they keep serving the OLD response headers (with the OLD CSP) until the
cache TTL expires (`max-age=14400` = 4 hours for hashed `/_app/immutable/*`).

The concrete failure mode (observed on 2026-07-11, post PR #291):

1. PR #291 added `gtfs-rt.n3ary.com` to `connect-src` in `static/_headers`.
2. The deploy shipped new files. Documents (`/`) and chunks whose hashes
   changed got the new CSP on the next request. But
   `gtfs.worker-C9WVoLDT.js` did not change (worker source unchanged
   between deploys), so Cloudflare served the previously-cached response
   with the OLD CSP.
3. Workers inherit their CSP from the response that loaded them
   (verified in WebKit 26.5 / Safari 17). The worker tried to call
   `gtfs-rt.n3ary.com/...` and got blocked by the old CSP, even though
   the document was on the new CSP.

The fix: after every deploy, purge the edge cache for the relevant URL
prefixes via the Cloudflare API. The next request re-fetches from origin
with the current `_headers` and the new CSP reaches the browser. The
following smoke test asserts the CSP on a real worker file (a representative
cached asset) actually contains the expected origin, so a silently-failed
purge (e.g. token scope regression) is caught before the deploy is treated
as successful.

**Required secrets:** `CLOUDFLARE_ZONE_ID` (zone ID for `n3ary.com`, get
from the Cloudflare dashboard → n3ary.com → Overview → Zone ID on the
right). The existing `CLOUDFLARE_API_TOKEN` must have `Zone: Purge` (or
`Zone: Edit`) on the zone; if it was created with `Cloudflare Pages: Edit`
only, rotate it via the dashboard to add the zone permission.

## Branch protection assumptions

- "Require branches to be up to date" must be on, so the auto-bump can't
  collide with a fresh merge on `main`.
- PR validation is required to pass.

## Why this is documented separately from the workflows

The workflow YAML expresses the steps; this doc expresses **why** each
step exists. Future agents editing the workflows should read this first
to avoid removing a safety they don't recognize.
