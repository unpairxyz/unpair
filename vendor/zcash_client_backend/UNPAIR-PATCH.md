# Why this copy of zcash_client_backend is here

This is zcash_client_backend 0.25.0 from crates.io, MIT or Apache-2.0
licensed, with one change, marked `UNPAIR-PATCH` in `src/scan.rs`:

`Tasks::run_task` hands each batch of trial decryptions to `rayon::spawn_fifo`.
On `wasm32-unknown-unknown` there are no threads, rayon falls back to a pool
with no worker to run a spawned job, and the scanner then waits forever for
results that never come. The patched function runs the batch on the calling
thread when the target is wasm. Native builds are unchanged.

Nothing else is changed. The proto files are not included, so `build.rs` keeps
the generated bindings in `src/proto/` as released.

This copy goes away when upstream runs batches inline on targets without
threads.

To refresh:

```sh
curl -sL https://static.crates.io/crates/zcash_client_backend/zcash_client_backend-0.25.0.crate | tar -xz
cp -R zcash_client_backend-0.25.0/{src,examples,Cargo.toml,build.rs,LICENSE-APACHE,LICENSE-MIT,README.md} vendor/zcash_client_backend/
```

then reapply the change above.
