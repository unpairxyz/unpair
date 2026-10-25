# Self-host guide

Unpair has three pieces. Each can be hosted on its own.

## 1. The web page

Static files. Build and upload them anywhere.

```sh
pnpm install
pnpm --filter @unpair/sdk build
pnpm --filter @unpair/web build
```

Upload `apps/web/dist`. Set `VITE_FEE_RECIPIENT` and `VITE_FEE_BPS` to route the
fee to yourself, or `VITE_FEE_BPS=0` for none. The page talks to 1Click from the
browser. It does not need the API.

## 2. The API

Needed for screening, signed quotes and the shielding worker. See `apps/api/README.md`.
A 2 vCPU, 2 GB VPS is enough. Build off the box:

```sh
cargo build -p unpair-api --release
scp target/release/unpair-api yourbox:/usr/local/bin/
```

Minimum production settings:

- `UNPAIR_SCREENING=denylist` or `http`. Never `off` on a public URL.
- `UNPAIR_SIGNING_SEED` set once and kept. Publish the public key next to your domain.
- `UNPAIR_GEOFENCE_REQUIRE_HEADER=true` when the edge always sets the country header.

## 3. The shielding wallet

Only if you want the server to issue landing addresses and shield for you. The
seed is yours and the funds are yours. Put a BIP-39 phrase in a file readable only
by the service user and point `UNPAIR_WALLET_SEED_FILE` at it. Set a long
`UNPAIR_OPERATOR_TOKEN`. The worker syncs against public lightwalletd servers,
shields every landed output into Orchard, and reports through `/v1/landings`.

Build with `--features tor` to route lightwalletd traffic through Tor.

## Before a public URL

- Run a small mainnet swap end to end with your own funds.
- Check `/v1/config` shows the fee you expect and screening is not `off`.
- Keep the seed file and the signing seed out of git and out of backups that others can read.
