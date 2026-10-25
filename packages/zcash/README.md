# unpair-zcash

The Zcash leg of Unpair, as a Rust crate on top of librustzcash.

It gives the API server and a self-hosted client:

- a fresh landing address per swap, derived from the user's own seed,
- lightwalletd access with failover across public servers and a chain tip cross-check,
- a small wallet database that syncs only what shielding needs,
- one-step auto-shield: every output on a landing address goes to Orchard,
- ZIP-317 fee estimates in plain words,
- Tor transport through arti behind the `tor` feature.

We run no Zcash node. The seed never leaves the process that runs this crate.

## Flow

```rust
use unpair_zcash::keys::Seed;
use unpair_zcash::lightwalletd::{default_endpoints, ClearnetConnector, Pool};
use unpair_zcash::wallet::{ShieldPolicy, ShieldWallet};
use unpair_zcash::Network;

let network = Network::MainNetwork;
let pool = Pool::new(default_endpoints(network), ClearnetConnector::default())?;

// 1. Open the wallet. A new wallet starts at the current tip.
let (tip, _) = pool.checked_tip().await?;
let birthday = pool.tree_state(tip).await?;
let seed = Seed::from_phrase(&phrase)?;
let mut wallet = ShieldWallet::open(network, &db_path, &seed, birthday, ShieldPolicy::default())?;

// 2. One landing address per swap. Give the transparent one to the route.
let landing = wallet.next_landing()?;
let t_address = landing.transparent_string(&network);

// 3. After the route pays: sync, shield, broadcast.
let txids = wallet.sync_and_shield(&pool, &[landing.transparent]).await?;
```

## Fees

The shield step pays the ZIP-317 network fee and nothing else. One landing output
costs 0.00015 ZEC. `fees::describe_shield_fee(n)` gives the sentence for the UI.

## Confirmations and thresholds

`ShieldPolicy` defaults: shield after 1 confirmation, skip amounts under 0.0005 ZEC,
sync in batches of 1000 blocks. Deployments can tighten these.

## Transport

`ClearnetConnector` is for development and leaks the caller's IP to the server.
Build with `--features tor` and use `tor::TorLightwalletd` for the default
production path. Nym is not wired here; it belongs at the SDK transport layer.

## Proving parameters

Sapling parameters are loaded from the zcash_proofs default folder and downloaded
there on first use. Set a folder with `with_params_dir` for air-gapped builds.
Orchard needs no parameters.

## Examples

```sh
cargo run -p unpair-zcash --example tips
UNPAIR_PHRASE="..." cargo run -p unpair-zcash --example landing -- 3
```

Neither example moves funds. There is no faucet step here and mainnet tests with
real value are a manual decision.

## Test

```sh
cargo test -p unpair-zcash
```
