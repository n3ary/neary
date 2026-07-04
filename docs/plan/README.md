# Plan

Plans are short-lived work artifacts on a feature branch. They do
**not** live in `main`. Once work is complete, the plan is distilled
into `../specs/` or `../concepts/` and the unfinished pieces become
GitHub issues on the repo where the code will be written.

For the full lifecycle, see [issue-plan-lifecycle.md](../standards/issue-plan-lifecycle.md).

## How to use this directory

If you're starting implementation of a complex idea:

1. Create a branch for the work (often the feature branch the work lives on).
2. Put the plan in `docs/plan/<slug>.md` **on that branch**.
3. As work proceeds, update the plan to reflect current understanding.
4. At completion:
   - Distill decisions into `docs/specs/` or `docs/concepts/`.
   - Open GitHub issues on the right repos for unfinished work.
   - Delete the plan file. Do not merge it to `main`.

If you only have an idea and aren't implementing yet, open a GitHub issue
instead — that's the long-lived record of intent.

## Active plans

None. If you're looking for ongoing work, check the open issues on this
repo and on the producer / adapter repos.