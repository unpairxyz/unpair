# Self-host guide

Unpair has three pieces. None of them holds a key on a server. Each can be
hosted or built on its own.

## 1. The app

The desktop app is the part that holds your Zcash key, shields the payout and
runs the second hop. It is built on `packages/zcash` and ships as signed releases
with published hashes, so you can check a download against the source. Building
it yourself from the repo is the same thing without the signature.

Until a release ships, run it from source as its README describes, or use the
web page below with any Zcash wallet that shields on receipt, such as Zodl, Zingo
or Zkool.

## 2. The web page

Static files. Build and upload them anywhere.

```sh
pnpm install
pnpm --filter @unpair/sdk build
pnpm --filter @unpair/web build
```

Upload `apps/web/dist`. Set `VITE_FEE_RECIPIENT` and `VITE_FEE_BPS` to route the
fee to yourself, or `VITE_FEE_BPS=0` for none. The page talks to 1Click from the
browser. It does not need the API.

## 3. The API

Needed for screening and signed quotes. It holds no key that can receive funds.
See `apps/api/README.md`. A 1 vCPU, 1 GB VPS is enough. Build off the box:

```sh
cargo build -p unpair-api --release
scp target/release/unpair-api yourbox:/usr/local/bin/
```

Minimum production settings:

- `UNPAIR_SCREENING=denylist` or `http`. Never `off` on a public URL.
- `UNPAIR_SIGNING_SEED` set once and kept. Publish the public key next to your domain.
- `UNPAIR_GEOFENCE_REQUIRE_HEADER=true` when the edge always sets the country header.

## Before a public URL

- Run a small mainnet swap end to end with your own funds.
- Check `/v1/config` shows the fee you expect and screening is not `off`.
- Keep the signing seed out of git and out of backups that others can read.
