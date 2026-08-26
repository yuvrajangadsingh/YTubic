# Branching

`main` is production. `develop` is everything else.

## main

What Yuvraj actually runs. Only proven work lands here, and it arrives as a
release: version bump in all three manifests (`package.json`,
`tauri.conf.json`, `src-tauri/Cargo.toml`), a `whats-new.ts` entry, then merge.
Never a running total of half-finished fixes.

A known-good build is kept at `~/YTubic-builds/` so there is always something
to fall back to without a rebuild.

## develop

Cut from main. Research, experiments, anything unverified. Feature branches cut
from `develop` and PR back into it. It is allowed to be broken.

`develop` does NOT fast forward into main. It carries things production must
never have, the `devtools` feature being the standing example, so a release
merges the changes that matter rather than the whole branch.

## why

Aug 26 2026: eight PRs went straight into main and were installed one by one
over a single day. Each was individually reasonable and the daily driver still
picked up regressions from it (an album column vanished because a later branch
forked before the fix that added it). Production and the workbench were the
same thing, so every experiment shipped.
