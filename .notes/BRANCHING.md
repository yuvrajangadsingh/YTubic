# Branching

`main` is production. `develop` is the workbench. Features branch off
`develop`. Confirmed as the standing model Aug 27 2026.

## main

The final build the user runs. Only `release/x.y.z` branches merge here,
and a release means: version bump in all three manifests
(`package.json`, `tauri.conf.json`, `src-tauri/Cargo.toml`), a
`whats-new.ts` entry, then a PR into main. Never a running total of
half-finished fixes, and never a plain feature PR.

A known-good build lives in `~/YTubic-builds/` so there is always a
rollback that needs no rebuild.

Release commits stage explicit paths. `git add -u` in a release once
swept in an unrelated floating working-tree change.

## develop

Cut from main, tracks it via merges of main back in after each release.
Everything unproven lives here. It is allowed to be broken, and it
carries things production must never ship — the `devtools` Cargo
feature is the standing example — which is why develop never
fast-forwards into main: a release takes the changes that matter, via a
release branch, not the branch wholesale.

## feature branches

Cut from `develop`, PR back into `develop`. Prefixes:

- `feat/…`     new behavior
- `fix/…`      a bug with a repro
- `research/…` may produce nothing; deletable without ceremony
- `release/…`  the only branches that PR into main

ONE topic per branch. The Aug 27 integration branch carried three
features because they shared a test build; that was expedient and wrong
— it merges as a blob and can only be reverted as one. When several
features need a single build to verify, build from a throwaway local
merge of their branches instead of stacking commits on one branch.

## why this exists

Aug 26: eight PRs went straight into main and were installed one by one
over a single day. Each was individually fine and the daily driver still
picked up regressions (an album column vanished because a later branch
forked before the fix that added it). Production and workbench were the
same thing, so every experiment shipped.
