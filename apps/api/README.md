# unpair-api

A small Rust service. It does the parts a static page cannot:

- **Screening before execution.** Geofence from the edge country header and an address screen on the refund and destination addresses. A refused flow gets no quote, so no fee is ever taken from it.
- **Signed quotes.** The server forwards a quote to 1Click with its own fee settings and signs the result with an Ed25519 key. The web app pins the public key, so a clone site cannot show a forged Unpair quote.
- **Status lookups** for a deposit address.
- **Self-host shielding worker**, off by default. When an operator gives the server a seed, it issues landing addresses and shields whatever lands on them into Orchard every two minutes. The hosted unpair.xyz instance does not run this part. Users bring their own shielding wallet.

It holds no user funds in any mode. In self-host mode the funds are the operator's own.

## Endpoints

| Method | Path | Auth | What |
|---|---|---|---|
| GET | `/health` | none | Liveness. |
| GET | `/v1/config` | none | Fee, cap, screening mode, geofence list, signing public key. |
| GET | `/v1/pubkey` | none | Quote signing key. |
| POST | `/v1/screen` | none | `{address, chain}` to `{allowed, reason}`. |
| POST | `/v1/quote` | none | A 1Click quote request body. Screens, forwards with the server's fee, returns `{quote, fee_recipient, fee_bps, signature, public_key_hex}`. |
| GET | `/v1/status/{depositAddress}` | none | 1Click status, with optional `?depositMemo=`. |
| POST | `/v1/landings/next` | operator | Fresh landing address from the self-host wallet. |
| GET | `/v1/landings` | operator | Landings issued and shield transactions sent. |

Operator endpoints take `Authorization: Bearer <UNPAIR_OPERATOR_TOKEN>` and answer 501 when the wallet is off.

## Run

```sh
cp apps/api/.env.example apps/api/.env   # edit
cargo run -p unpair-api
```

Build without the wallet for the hosted instance, which keeps the binary small and drops the Zcash dependencies:

```sh
cargo build -p unpair-api --release --no-default-features
```

With Tor for the wallet's lightwalletd connections:

```sh
cargo build -p unpair-api --release --features tor
```

## Deploy

`deploy/unpair-api.service` is a systemd unit with a low CPU weight, a memory cap and a read-only filesystem apart from `/var/lib/unpair`. Build on a laptop or CI, copy the binary to `/usr/local/bin/unpair-api`, put the env file at `/etc/unpair/api.env`, and:

```sh
sudo useradd --system --home /var/lib/unpair --create-home unpair
sudo install -m 644 deploy/unpair-api.service /etc/systemd/system/
sudo systemctl enable --now unpair-api
```

It fits a 2 vCPU, 2 GB box. Put Cloudflare or nginx in front for TLS and the country header.

## Screening adapters

`UNPAIR_SCREENING=http` posts `{address, chain}` to a URL and expects `{"allowed": bool, "reason": string}`. Provider-specific shapes from TRM or Chainalysis are mapped by a small adapter that lives with the deployment config, not in this repo. The denylist mode needs no provider and is enough for the private alpha.

## Test

```sh
cargo test -p unpair-api
```
