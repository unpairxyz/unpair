# Unpair

Unpair unlinks a transfer across chains. You deposit an asset on one chain and receive it, or another
asset, on a second chain at an address you choose. No transaction connects the two ends, because the
transfer lands in Zcash's shielded pool in between and leaves it from a shielded spend. In fast mode,
amount and timing can still suggest a match. Quiet mode rounds the amount and waits a random time.

Confidential routing hides the swap, not the link: a
[public study](https://github.com/codedforum/piptradedex/blob/main/private-intent/experiments/leak-study/REPORT.md)
still linked 9 in 10 confidential trades by amount and time. Unpair goes after the link itself. The
shielded pool cuts the on-chain link, and quiet mode cuts the amount and time link.

Live at [unpair.xyz](https://unpair.xyz). Early: small caps, one route, and the limits below. Read the
[threat model](docs/threat-model.md) before you trust it with anything that matters.

## How it works

1. Pick what you send, what you get, and where it goes. The form shows the fee and the estimate
   before anything is created.
2. Pick who holds the ZEC between the two hops: a one-time wallet that runs inside the page, Unpair's
   server, or your own Zcash wallet.
3. Send the deposit. The route (NEAR Intents, through 1Click) pays a fresh shielded Zcash address.
4. Hop two leaves the pool from a fresh note and arrives as the asset you chose. In quiet mode the
   amount is rounded and sent on after a random delay, on the server path in standard pieces.

With the one-time wallet or your own wallet, the key that receives and spends your ZEC is on your
device; in those modes we hold no funds and no key. Our API also never gets the address your coins
go to: the page checks it against a hashed screening list itself and asks the route directly for that
hop. The limits below say what our server can still see. With the Unpair server, we hold your ZEC
between the two hops, under caps shown before you deposit, and we can see both ends of that swap. We run no
liquidity and no node. Revenue is a routing fee shown before every trade and capped in code at 1% per
hop.

## What is here

- `apps/web`: the page. Fast and quiet modes, the three custody choices, the one-time wallet in a
  worker, estimates from the route before the deposit, screening on the device for the hop that
  names your destination. See its README.
- `apps/api`: Rust service for screening, signed quotes, estimates, status, and the transit wallet of
  the server path when enabled. See its README.
- `packages/zcash`: Rust crate for landing addresses, lightwalletd with failover, auto-shield to
  Ironwood, hop two from the pool, ZIP-317 fees. Runs natively in the API and as WebAssembly in the
  page. See its README.
- `packages/zcash-web`: the wasm-bindgen wrapper of that crate for the page.
- `packages/client`: TypeScript shared by front ends: API client, signed quote checks, swap planning,
  address checks.
- `packages/sdk`: TypeScript 1Click client with the fee rules, rounding and release timers.
- `vendor/`: two crates with small patches for the browser build, each with an `UNPAIR-PATCH.md`.
- `docs/`: [threat model](docs/threat-model.md), [fees](docs/fees.md),
  [screening policy](docs/screening-policy.md), [self-host guide](docs/self-host.md).

## Develop

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

Node 22 or later and pnpm 10 for the TypeScript packages. Rust 1.85 or later for the Rust crates:

```sh
cargo test
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for branches, commits and the rules every change keeps, and
[SECURITY.md](SECURITY.md) for how to report a problem.

## Releases

Every release is a signed tag. The Release workflow builds the API binary and the page and attaches
them with `SHA256SUMS`. What unpair.xyz serves is a release's files, so you can hash what you load
against the release.

## Limits we state up front

- Trustless cross-chain unlinkability does not exist today. Each route operator sees its own leg.
- NEAR Intents is a trusted party while a swap is in flight. On the server path, so is Unpair.
- Fast mode can still be matched by amount and time. Quiet mode makes that harder, and its cover
  grows with the number of swaps in the same hours.
- Who holds the ZEC between the hops decides what Unpair can see. With the Unpair server we hold
  your ZEC and see both ends. With the one-time wallet or your own wallet we hold no funds and no
  key. Our API gets hop one's addresses, and for the estimate the asset, chain and amount you want
  out, but never your destination address.
- The one-time wallet reads the chain and sends hop two through a proxy on our server. That
  transaction pays the route's deposit address, and the route's public status turns that address
  into your destination. With your IP on both hops, our server could link them. Tor Browser stops
  the IP match. Your own wallet, with its own server, avoids the proxy.
- Lose the one-time wallet's recovery file, or the seed of your own wallet, and nothing can recover
  the ZEC under it.
- Addresses are screened before execution. Sanctioned jurisdictions are not served.

## NEAR integration

**What NEAR does here.** NEAR Intents, through the 1Click API, does both swaps. Hop one swaps the
asset you send into ZEC and pays it to a fresh shielded Zcash address. Hop two swaps ZEC from the pool
into the asset you get, on the chain you pick. Without NEAR Intents there is no route from one chain
into the pool and out to another. The 1Click client is `packages/sdk/src/oneclick/client.ts`.

**Try it.**

1. Open [unpair.xyz](https://unpair.xyz). Pick what you send, what you get, and the address it goes
   to. You see the fee and the estimate from 1Click before anything is created. No funds are needed
   for this step.
2. Pick who holds the ZEC between the hops. Pick "one-time wallet": you see a recovery file to save.
3. Send a small deposit. You see each step: "Deposit seen", "In the pool", "Sent", "Done".
4. Look up the Base or other source deposit on the
   [NEAR Intents explorer](https://explorer.near-intents.org/). The swap ends with a payout to the
   one-time wallet's address.
5. Open the "Zcash tx" link on the page. Hop two spends from the shielded pool, and the spend does not
   show which note it used.
6. Look up the payout on the same explorer. It is a separate swap from step 4. In fast mode, the amount
   and time can still suggest a match. Quiet mode rounds the amount and waits a random time, up to
   12 hours. NEAR Intents still sees each hop.

**Check it without funds or keys.**

```sh
pnpm install && pnpm test
```

You see `Tests 37 passed` for `packages/sdk`, `Tests 34 passed` for `packages/client` and `Tests 8
passed` for `apps/web`. The 1Click tests are in `packages/sdk/test/oneclick.test.ts`. The screening
check that never sends your address is in `packages/client/test/screening.test.ts`.

```sh
cargo test
```

You see `test result: ok. 51 passed` for the API and `21 passed` for the Zcash crate.

Ask the live API for the cost of a route. This is a dry quote of both hops from 1Click, with no
address, so nothing is created:

```sh
curl -s https://api.unpair.xyz/v1/estimate -H 'content-type: application/json' -d '{
  "mode": "fast", "custody": "browser", "amount": "30000000",
  "originAsset": "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
  "destinationAsset": "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near" }'
```

You see the ZEC hop one lands (`zec_out`), what hop two delivers (`estimate_out`) and the full cost
(`cost`): our fee, 1Click's fee, the Zcash network fee, ZEC left in the one-time wallet, and price
and gas. On 6 November 2026, 30 USDC on Base to USDC on Solana cost 3.3% to 3.6%.

See the screening list the page checks your destination against:

```sh
curl -s https://api.unpair.xyz/v1/screen/list
```

Every caller gets the same answer: `hash` says how each entry is made, and `entries` holds one
SHA-256 per listed address. The address you check never leaves your device.

**Built since 19 Oct 2026.** The first commit is 25 Oct 2026. See the [full history](https://github.com/unpairxyz/unpair/commits/main/).

**Libraries.** We wrote the 1Click client, the fee rules, the swap planner and the Zcash crate. We
use these libraries: the Zcash crates (`zcash_client_backend`, `zcash_client_sqlite`,
`zcash_primitives`, `zcash_keys`, `orchard`, `sapling-crypto`, `zip32`, `zip321`), `axum`, `tokio`,
`reqwest`, `rusqlite`, `ed25519-dalek`, `tonic`, React, `@noble/ed25519` and `@noble/hashes`. The
`vendor/` folder has small patches to `zcash_client_backend` and `rusqlite` for the browser build.

## Licence

MIT. See [LICENSE](LICENSE).
