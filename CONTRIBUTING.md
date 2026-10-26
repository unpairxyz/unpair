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
change does for the user or the operator, not which file it touched.

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
