# Unpair

Unpair unlinks a transfer across chains. You deposit an asset on one chain and receive it, or another
asset, on a second chain at an address you choose. The two ends have no on-chain link, because the
transfer lands in Zcash's shielded pool in between.

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
device; in those modes we hold no funds and no key. With the Unpair server, we hold your ZEC between
the two hops, under caps shown before you deposit, and we can see both ends of that swap. We run no
liquidity and no node. Revenue is a routing fee shown before every trade and capped in code at 1% per
hop.

## What is here

- `apps/web`: the page. Fast and quiet modes, the three custody choices, the one-time wallet in a
  worker, estimates from the route before the deposit. See its README.
- `apps/api`: Rust service for screening, signed quotes, estimates, status, and the transit wallet of
  the server path when enabled. See its README.
- `packages/zcash`: Rust crate for landing addresses, lightwalletd with failover, auto-shield to
  Ironwood, hop two from the pool, ZIP-317 fees. Runs natively in the API and as WebAssembly in the
  page. See its README.
- `packages/zcash-web`: the wasm-bindgen wrapper of that crate for the page.
- `packages/client`: TypeScript shared by front ends: API client, signed quote checks, swap planning,
  address checks.
- `packages/sdk`: TypeScript 1Click client with the fee rules, rounding and release timers.
- `apps/desktop`: an earlier desktop app on the same crate. Paused: not built by CI, not released,
  not offered on the page.
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
- Lose the one-time wallet's recovery file, or the seed of your own wallet, and nothing can recover
  the ZEC under it.
- Addresses are screened before execution. Sanctioned jurisdictions are not served.

## Licence

MIT. See [LICENSE](LICENSE).
