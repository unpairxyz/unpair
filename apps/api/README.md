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
| GET | `/v1/tokens` | none | The route's token list, cached here for ten minutes and served stale when the route is down. `cache-control: public, max-age=300`. |
| POST | `/v1/screen` | none | `{address, chain}` to `{allowed, reason}`. |
| POST | `/v1/quote` | none | A quote request with only the fields the page sends (`dry, swapType, slippageTolerance, originAsset, depositType, destinationAsset, amount, refundTo, refundType, recipient, recipientType, deadline, depositMode?`); any other field is refused. Screens, forwards with the server's fee, returns `{quote, fee_recipient, fee_bps, signature, public_key_hex}`. |
| POST | `/v1/estimate` | none | `{mode, originAsset, amount, destinationAsset, recipient, refundTo, slippageTolerance?, custody?}`: dry quotes of both hops, so the form shows the number the deposit screen will show. An address left empty is replaced by a well-formed stand-in on its chain, where one exists. Returns `{zec_out, estimate_out}`. Nothing is created or screened. A destination other than ZEC needs the hosted wallet. |
| GET | `/v1/status/{depositAddress}` | none | 1Click status, with optional `?depositMemo=`. |
| POST | `/v1/hosted/swaps` | none | Start a hosted swap: `{mode, originAsset, amount, destinationAsset, recipient, refundTo, slippageTolerance?}`. Screens, takes a fresh shielded landing, quotes hop one to it, returns `{swap, quote}`. |
| GET | `/v1/hosted/swaps/{id}` | the id | Progress of one hosted swap. The id is 16 random bytes; whoever has it sees the swap. |
| GET | `/v1/hosted/report` | operator token | Wallet balance, proving and upgrade state, swap counts. |
| GET | `/v1/operator/swaps/{id}` | operator token | The whole swap row, errors included. |
| POST | `/v1/operator/swaps/{id}/payout` | operator token | `{to, amount_zat?}`: pay a stuck swap out by hand. See below. |
| POST | `/v1/handoff` | none | `{quote, ttl_secs?}`: park a signed quote in memory for a second device. Returns `{id, expires_unix}`. Opt-in from the page, at most one day, never written to disk. |
| GET | `/v1/handoff/{id}` | the id | The parked quote. Whoever has the id sees the quote. |

### Hosted swap states

`waiting_for_deposit`, `routing_in`, `in_pool`, `routing_out`, then `done`, `refunded`, `expired` or `failed`. A `failed` swap holds its ZEC in the transit wallet until the operator acts. Finished swaps are deleted after seven days.

Hop two goes out in parts. A fast swap has one part for the full amount. A quiet swap is cut into standard sizes, 0.5, 0.2, 0.1, 0.05 and 0.02 ZEC, at most six parts, each with its own release time, quote, payout and route status; what is left under 0.02 ZEC stays in the transit wallet as `dust_zat`. The swap is `in_pool` until the first part is paid, `routing_out` while any part is unpaid or in flight, `done` when every part is delivered, and `failed` if a part gives up. The swap view carries `parts_total`, `parts_delivered`, `dust_zat` and a `parts` list with each part's state, txid and delivery transaction. `UNPAIR_HOSTED_SPLIT=false` turns the cut off; `/v1/config` shows `hosted.split`.

### Rate limit

`UNPAIR_RATE_LIMIT_PER_MIN` (default 20, 0 turns it off) bounds what one client
address may ask per minute of `/v1/quote`, `/v1/estimate`, `/v1/hosted/swaps`, `/v1/screen` and
`/v1/handoff`. The address is read from `cf-connecting-ip`, then
`x-forwarded-for`; with neither header every caller shares one bucket. The
answer over the limit is 429 with a plain message. Put a rate rule at the edge
as well; this one only protects the partner key and the wallet's addresses.

### Paying a stuck swap out by hand

A swap goes to `failed` when hop two could not be completed, or when a payout
was handed to the wallet and no transaction id came back. The driver never pays
such a swap again. Read it first, then pay it to a transparent address you and
the user agree on. Keep the token in a file, never on the command line:

```sh
TOKEN=$(cat /etc/unpair/operator.token)
curl -s -H "Authorization: Bearer $TOKEN" https://api.example.org/v1/operator/swaps/<id>
curl -s -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"to":"t1...","amount_zat":980000}' \
  https://api.example.org/v1/operator/swaps/<id>/payout
```

`amount_zat` defaults to the swap's hop two amount and may not exceed the
per-swap cap. The payout is written to the swap before the wallet sees it, as
the driver does. On success the swap closes as `done`, with the transaction id
in its note for the user and in `last_error` for you. Check the wallet report
before paying a swap whose earlier payout result was unknown: the first
transaction may have gone through.

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

`UNPAIR_SCREENING=http` posts `{address, chain}` to a URL and expects `{"allowed": bool, "reason": string}`. Provider-specific shapes from TRM or Chainalysis are mapped by a small adapter that lives with the deployment config, not in this repo. The denylist mode needs no provider and is what the public instance runs today.

## Test

```sh
cargo test -p unpair-api
```

## Making the hosted wallet's seed

```sh
unpair-api new-seed /etc/unpair/wallet.seed
```

Writes a fresh 24 word phrase to that file, owner-readable only, never prints
it, and prints the mainnet height to put in `UNPAIR_WALLET_BIRTHDAY`. Back the
file up on paper before the first hosted swap.
