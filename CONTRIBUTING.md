# Contributing

## Build and test

```sh
pnpm install
pnpm -r build && pnpm -r typecheck && pnpm -r test
cargo fmt --all --check
cargo test -p unpair-api -p unpair-zcash
```

The browser wallet needs a clang with a WebAssembly backend; see
`apps/web/README.md`. Nothing else is special.

## Branches

Work goes on `develop` or on a branch off it, by pull request. `main` only
receives merges from `develop`; its workflows build what gets deployed.
Releases are signed tags on `main`.

## Commits

Sign your commits. Write the subject as a plain sentence that says what the
change does for the user or the operator, not which file it touched. One
commit is one change; a fix to an earlier commit on the same branch goes into
that commit, not on top of it.

## Code style

The Rust crates follow the
[librustzcash style guide](https://github.com/zcash/librustzcash/blob/main/CONTRIBUTING.md#styleguides):

- `cargo fmt` formats everything, and CI checks it. `cargo clippy` stays clean
  for the code you touch.
- Make invalid states unrepresentable. Wrap bare integers and strings in
  newtypes with documented meaning; use enums instead of booleans; keep struct
  fields private behind constructors that check their invariants.
- Anything `pub` is public API and carries a doc comment. Test-only
  capabilities sit behind a feature flag, not in the public surface.
- Prefer immutable data and functions without side effects. Pass in what a
  function needs instead of reaching for globals.
- A change that alters the public API, fixes a bug, or changes behaviour
  updates the docs and tests in the same commit.

TypeScript follows the same spirit: `pnpm typecheck` and `pnpm test` pass,
exports are the public API, and a module exports only what another module
uses.

## Rules that every change keeps

- Screening runs before any execution, and the geofence stays.
- Every fee is shown before the trade and capped in code at 1% per hop.
- The page never asks for a seed phrase, a wallet connection, or a signature.
- No telemetry, no analytics, no third-party scripts on the page.
- User-facing copy is short and plain. No em dashes. No unqualified claim that
  nothing is held: say in which mode.
- No own token, chain, node or extra privacy legs.

A change that breaks one of these is not merged, however good it is otherwise.

## Reporting a bug

Open an issue with the steps, what you expected and what you saw. For a
security problem, read `SECURITY.md` instead.
