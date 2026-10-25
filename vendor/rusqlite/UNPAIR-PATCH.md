# Why this copy of rusqlite is here

This is rusqlite 0.40.2 from crates.io, MIT licensed, with two changes:

1. `version` in `Cargo.toml` reads `0.37.100`, so that it satisfies the
   `^0.37` requirement of `zcash_client_sqlite` and `schemerz-rusqlite`
   through `[patch.crates-io]` in the workspace `Cargo.toml`.
2. `fallible_uint` is on by default. rusqlite 0.38 moved the `u64` and
   `usize` SQL conversions behind that feature; `zcash_client_sqlite` 0.23
   still uses them.

Nothing else is changed. Everything in `src/` is upstream.

Why 0.40 at all: rusqlite 0.40 is the first release that builds for
`wasm32-unknown-unknown` (feature `ffi-sqlite-wasm-rs`, SQLite compiled to
WebAssembly). The browser wallet needs it. Native builds keep using the same
bundled SQLite as before.

This copy goes away when librustzcash moves to rusqlite 0.40 or later.

To refresh:

```sh
curl -sL https://static.crates.io/crates/rusqlite/rusqlite-0.40.2.crate | tar -xz
cp -R rusqlite-0.40.2/{src,Cargo.toml,LICENSE,README.md} vendor/rusqlite/
```

then reapply the two changes above.
