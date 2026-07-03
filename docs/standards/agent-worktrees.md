# Agent worktrees

Rules for any AI agent (Kilo, Copilot, Cursor, Claude Code, etc.) working
in this repo.

## Default: don't use a worktree

Worktrees multiply the cost of working in a repo — disk, `node_modules`,
setup-script time, merge complexity. Most agent tasks in this repo do
not need one. Default to working on a single branch in the main checkout.

## Always ask before creating a worktree

Before any `git worktree add` or tool-specific equivalent (Kilo Agent
Manager "New Worktree", Copilot coding agent, Cursor background agent,
etc.), the agent **MUST** ask the user for explicit confirmation. The
question **MUST** include:

- What the worktree is for (one sentence)
- Proposed branch name (per [naming.md](naming.md))
- Proposed worktree path (default: `.kilo/worktrees/<name>` if Kilo,
  otherwise the repo's local convention)
- Why a worktree is justified vs working on the current branch

If the user declines, work on the current branch.

## When a worktree is justified

A worktree is appropriate only when **all** of the following hold:

1. The task must run **in parallel** with other work in the same repo
   (another agent, a long-running dev server, a watch-mode test runner).
2. The changes touch a **disjoint set of files** from the parallel work —
   no shared hot file (schema, interface, lockfile, route table) that
   both would rewrite.
3. The work is **leaf-shaped** — a single package, module, or quirk
   file — not a chain of dependent steps.

If any of these is uncertain, serialize the work on one branch.

## Pre-flight check

Before creating the worktree, name the files that two parallel agents
would fight over. If you can't, parallelizing is safe. If you can,
serialize until those files are stable.

## When to abort and fall back to a branch

Stop using the worktree and consolidate onto a single branch if any of
these emerge:

- **Hidden coupling surfaces.** The worktree's task starts touching
  files that belong to the parallel task's scope.
- **Every rebase conflicts.** If `git rebase <base>` produces conflicts
  on most commits, the parallel shape is wrong.
- **`git stash` appears.** Stash is global across worktrees — if anyone
  reaches for it, the isolation is broken. Abort and consolidate.
- **Setup-script, port, or DB collisions** that can't be parameterized
  from `WORKTREE_PATH` or branch name.
- **Scope creep.** The agent is editing files outside its assigned leaf.

Recovery: capture intent (`git diff` or stash in a single-worktree
repo), `git worktree remove <path>`, re-apply on the main branch.

## Shared contracts first

For multi-worktree efforts (e.g. the producer monorepo plan in
[docs/plan/producer-monorepo.md](../plan/producer-monorepo.md)),
stabilize shared contracts — interfaces, schemas, route tables, file
layout, test shape — on the base branch **before** creating parallel
worktrees. The shared layer is what most often turns parallel work into
conflict work.

## Cleanup

When a worktree's task is merged:

- `git worktree remove <path>`
- `git branch -d <branch>` only after the merge lands

Never delete a worktree branch before its changes are integrated.