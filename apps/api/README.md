# unpair-api

A small Rust service. It does the parts a static page cannot:

- **Screening before execution.** Geofence from the edge country header and an address screen on the refund and destination addresses. A refused flow gets no quote, so no fee is ever taken from it.
- **Signed quotes.** The server forwards a quote to 1Click with its own fee settings and signs the result with an Ed25519 key. The web app pins the public key, so a clone site cannot show a forged Unpair quote.
- **Status lookups** for a deposit address.
- **Hosted swaps**, when the operator gives it a seed. The server then holds a Zcash transit key, receives hop one into its own shielded wallet and pays hop two later from the pool. Off by default. See `docs/threat-model.md` for what that means for users and `docs/self-host.md` for what it means for the operator.

## Endpoints

| Method | Path | Auth | What |
|---|---|---|---|
| GET | `/health` | none | Liveness. |
| GET | `/v1/config` | none | Fee, cap, screening mode, geofence list, signing public key. |
| GET | `/v1/pubkey` | none | Quote signing key. |
| POST | `/v1/screen` | none | `{address, chain}` to `{allowed, reason}`. |
| POST | `/v1/quote` | none | A 1Click quote request body. Screens, forwards with the server's fee, returns `{quote, fee_recipient, fee_bps, signature, public_key_hex}`. |
| GET | `/v1/status/{depositAddress}` | none | 1Click status, with optional `?depositMemo=`. |
| POST | `/v1/hosted/swaps` | none | Start a hosted swap: `{mode, originAsset, amount, destinationAsset, recipient, refundTo, slippageTolerance?}`. Screens, takes a fresh shielded landing, quotes hop one to it, returns `{swap, quote}`. |
| GET | `/v1/hosted/swaps/{id}` | the id | Progress of one hosted swap. The id is 16 random bytes; whoever has it sees the swap. |
| GET | `/v1/hosted/report` | operator token | Wallet balance, proving and upgrade state, swap counts. |
| POST | `/v1/handoff` | none | `{quote, ttl_secs?}`: park a signed quote in memory for a second device. Returns `{id, expires_unix}`. Opt-in from the page, at most one day, never written to disk. |
| GET | `/v1/handoff/{id}` | the id | The parked quote. Whoever has the id sees the quote. |

### Hosted swap states

`waiting_for_deposit`, `routing_in`, `in_pool`, `routing_out`, then `done`, `refunded`, `expired` or `failed`. A `failed` swap holds its ZEC in the transit wallet until the operator acts. Finished swaps are deleted after seven days.

## Run

```sh
cp apps/api/.env.example apps/api/.env   # edit
cargo run -p unpair-api
```

Release build:

```sh
cargo build -p unpair-api --release
```

## Deploy

`deploy/unpair-api.service` is a systemd unit with a low CPU weight, a memory cap and a read-only filesystem. Build on a laptop or CI, copy the binary to `/usr/local/bin/unpair-api`, put the env file at `/etc/unpair/api.env`, and:

```sh
sudo useradd --system --home /var/lib/unpair --create-home unpair
sudo install -m 644 deploy/unpair-api.service /etc/systemd/system/
sudo systemctl enable --now unpair-api
```

It fits a 1 vCPU, 1 GB box. Put Cloudflare or nginx in front for TLS and the country header.

## Screening adapters

`UNPAIR_SCREENING=http` posts `{address, chain}` to a URL and expects `{"allowed": bool, "reason": string}`. Provider-specific shapes from TRM or Chainalysis are mapped by a small adapter that lives with the deployment config, not in this repo. The denylist mode needs no provider and is enough for the private alpha.

## Test

```sh
cargo test -p unpair-api
```
