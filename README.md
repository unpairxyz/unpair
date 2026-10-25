# Unpair

Unpair is an open-source router that unlinks a transfer across chains. You deposit an asset on one
chain and receive it, or another asset, on a second chain. The two ends have no on-chain link. The
unlinking comes from landing the transfer in Zcash's shielded pool.

Status: pre-alpha. Nothing here is ready to use with real funds.

## How it works

1. You get a quote on your device. Our server never sees the deposit and the destination together.
2. You send the deposit. Fills come from NEAR Intents.
3. The swap lands at a fresh Zcash address that the Unpair app derived on your device, and the app
   moves it into the shielded pool in one step.
4. In quiet mode the amount is rounded and released after a random delay, then swapped out from a
   fresh shielded source.

The key that receives and shields your ZEC lives on your device, in the open-source Unpair app. We
hold no funds and no key, run no liquidity and run no node. Revenue is a routing fee shown before
every trade and capped in code.

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

Packages live under `packages/`, apps under `apps/`.

## What this repo will hold

- `packages/sdk`: TypeScript client for routes, fees, rounding, release timers and transport. Done first, see its README.
- `packages/zcash`: Rust crate for landing addresses, lightwalletd with failover, auto-shield to Ironwood, ZIP-317 fees. The core of the app. See its README.
- `apps/desktop`: the Unpair app, Tauri on the Rust crate. Holds the key in the system keychain, issues a landing address per swap, shields on sync. Second hop and signed releases to come. See its README.
- `packages/client`: TypeScript shared by the web page and the app: API client, signed quote checks, swap planning, address checks.
- `apps/web`: static web page for people who already run a wallet that shields on receipt. Fast and quiet modes, client-side quotes. See its README.
- `apps/api`: Rust service for screening, signed quotes and status. Holds no key. See its README.
- `docs/`: [threat model](docs/threat-model.md), [fees](docs/fees.md), [screening policy](docs/screening-policy.md), [self-host guide](docs/self-host.md).

## Limits we state up front

- Trustless cross-chain unlinkability does not exist today. Each route operator sees its own leg.
- NEAR Intents is a trusted party while a swap is in flight. It is the only one.
- Lose the seed and nothing can recover the ZEC under it.
- Addresses are screened before execution. Sanctioned jurisdictions are not served.

## Licence

MIT. See [LICENSE](LICENSE).
