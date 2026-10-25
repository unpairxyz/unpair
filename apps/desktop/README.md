# Unpair app

The desktop app. It holds the Zcash key for your swaps on your device and nowhere
else, built on `packages/zcash` with Tauri.

What it does:

- Makes a 24 word seed on first run and keeps it in the system keychain. Asks you
  to write the words down before any ZEC can arrive.
- Derives a fresh transparent landing address for every swap, gives it to the
  route as the recipient, and shields whatever lands there into Ironwood on the
  next sync. Sync runs every 90 seconds and on demand.
- Restores from a phrase, with an optional birthday height to bound the rescan.

Still to come: the second hop for quiet mode, Tor on by default with a
"connecting privately" state on first run, Sapling parameters fetched over Tor or
bundled instead of over clearnet, a passphrase fallback for Linux systems without
a Secret Service, and signed releases with published hashes. Reproducible builds
are planned, not claimed.

## Run from source

Needs the Rust toolchain, Node 22 or later, pnpm 10, and the platform
prerequisites for Tauri 2 (Xcode command line tools on macOS, WebKitGTK and
friends on Linux).

```sh
pnpm install
pnpm --filter @unpair/sdk build
pnpm --filter @unpair/client build
cp apps/desktop/.env.example apps/desktop/.env   # optional
pnpm --filter @unpair/desktop dev
```

`pnpm --filter @unpair/desktop bundle` builds an installer under
`target/release/bundle`. Route lightwalletd through Tor with
`pnpm --filter @unpair/desktop tauri build -- --features tor`.

## Where things live

| What | Where |
|---|---|
| Seed phrase | System keychain, service `xyz.unpair.desktop` |
| Wallet database, settings | The app data folder for `xyz.unpair.desktop` |
| Sapling proving parameters | The zcash_proofs default folder, fetched on first shield |

`UNPAIR_LIGHTWALLETD` with a comma-separated list overrides the default
lightwalletd servers.

## Trust

The app trusts NEAR Intents while a swap is in flight and nothing else. Check a
release against the published hash, or build it yourself. See the
[threat model](../../docs/threat-model.md).
