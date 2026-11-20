# dopamine

A public experiment: a small hub that serves dashboards agent threads publish once and then update by posting data. See [README.md](README.md).

To create, update or remove a dashboard, follow [skills/dashboard/SKILL.md](skills/dashboard/SKILL.md). That skill describes how the CLI behaves for its users, so when a CLI change alters that behaviour, update the skill in the same PR.

## Public repository: privacy

Everything committed here, and everything written to GitHub (commit messages, PR text, comments, issues), is public. Keep the repository generic: concrete infrastructure belongs in private config or private infrastructure repositories. That includes machine names, ports, home-directory paths, service labels, SSH hosts, tunnel and deploy settings, descriptions of the owner's setup, and text copied or quoted from private plans. Examples and tests use placeholder names and paths.

Before every push or public write, inspect the entire diff being published, including every commit and commit message, not just the latest change.

## Stack

- TypeScript that Node runs directly through type stripping. There is no build step. Use only erasable syntax (no `enum`, `namespace` or constructor parameter properties), write relative imports with their `.ts` extension, and import types with `import type`.
- Zero runtime dependencies: `dependencies` stays empty. Tooling goes in `devDependencies`.
- Toolchain: Node 26.12.1, pnpm 12.15.0, vite-plus, `@effect/tsgo`, knip and oxlint. Versions are pinned exactly to match LastCode's.

## Commands

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm fmt          # write formatting
pnpm fmt:check
pnpm test
pnpm knip:check
pnpm run ci           # all of the checks above, in order
pnpm lastcode:pr-gates -- <PR>
pnpm lastcode:merge -- <PR>
```

## Scope

Work only on phase 1a. Phase 1b (actions) and any phase 2 work, including changes to LastCode itself, need the owner's approval before you start.

## Commits

Make small commits, each a single coherent change. End every commit message with the attribution trailer your harness supplies.

## Pull requests and merging

Use the owner's global `review-loop`, `full-send`, `full-stop` and `babysit` skills for review and merge work. This file adds only what is specific to this repository.

A PR merges only when all of these hold. There is no bypass: no admin merge and no skipped checks.

- The single required GitHub CI check has passed.
- Codex Review has **completed** on the exact current head commit. A review that is still running is not a clean review, and neither is one on an earlier head.
- Every review finding has been handled: fixed, or answered and the thread resolved.
- It merges by squash into `main`, through `pnpm lastcode:merge -- <PR>`.

Immediately before merging, fetch, then recheck the current head and base, every check, unresolved review threads, clean mergeability, and the privacy of the full diff (see above). `pnpm lastcode:pr-gates -- <PR>` reports the gate state.

To wait for CI or review on a Dopamine PR, call `watch_pull_request` with the PR's full URL. If you own the merge, pass `until: "merged"`. Then take one snapshot with `pnpm lastcode:pr-gates -- <PR>`. On `pending`, end your turn so the watch can resume it. Call `unwatch_pull_request` before handing the PR back to the owner.

## After merging a Dopamine PR

1. Confirm the merge commit is on `main`. The PR's required checks already ran before the merge. A PR in another repository follows that repository's merge and after-merge rules instead.
2. Update the main checkout only when that is safe: it is clean and already on `main`. Never switch the main checkout to another branch.
3. Reconcile linked issues and worktree bookkeeping. Leave unrelated work in place.
