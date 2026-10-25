# Unpair

Unpair is an open-source router that unlinks a transfer across chains. You deposit an asset on one
chain and receive it, or another asset, on a second chain. The two ends have no on-chain link. The
unlinking comes from landing the transfer in Zcash's shielded pool.

Status: pre-alpha. Nothing here is ready to use with real funds.

## How it works

1. You get a quote in your browser. Our server never sees the deposit and the destination together.
2. You send the deposit. Fills come from NEAR Intents, THORChain or Maya.
3. The swap lands at a fresh shielded Zcash address. Transparent routes are shielded in one step.
4. In quiet mode the amount is rounded and released after a random delay, then swapped out from a
   fresh shielded source on a different route operator.

We hold no funds, run no liquidity and run no node. Revenue is a routing fee shown before every trade
and capped in code.

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
- `packages/zcash`: Rust crate for landing addresses, lightwalletd with failover, auto-shield to Orchard, ZIP-317 fees. See its README.
- `apps/web`: static web app, self-hostable.
- `apps/api`: Rust service for watching, shielding and screening.
- `docs/`: threat model, fee table, screening policy and self-host guide.

## Limits we state up front

- Trustless cross-chain unlinkability does not exist today. Each route operator sees its own leg.
- NEAR Intents, THORChain and Maya are trusted parties while a swap is in flight.
- Addresses are screened before execution. Sanctioned jurisdictions are not served.

## Licence

MIT. See [LICENSE](LICENSE).
