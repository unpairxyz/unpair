# Unpair web app

A static page. Quotes go from the browser straight to the route, so the server
that hosts this page never sees your deposit and your Zcash address together.

## Icons

The token picker shows icons from our own origin, never from a third party at
page load. Fill `public/icons/` before a build:

```sh
node apps/web/scripts/fetch-icons.mjs
```

The folder is not committed. The Pages workflow runs the script before it builds.
Without it, every token shows a monogram.

## Run

```sh
pnpm install
pnpm --filter @unpair/sdk build
pnpm --filter @unpair/web dev
```

## Build and self-host

```sh
cp apps/web/.env.example apps/web/.env   # optional, defaults work
pnpm --filter @unpair/sdk build
pnpm --filter @unpair/web build           # output in apps/web/dist
```

Upload `dist/` to any static host. Cloudflare Pages, Netlify, GitHub Pages and a
plain nginx folder all work. No server code, no database, no cookies. The
"Web page" workflow builds `dist/` with the browser wallet and the icons on
every push to main and keeps it as the artifact `unpair-web`; it publishes to
GitHub Pages only when the repository variable `USE_PAGES` is `true`.

Environment values are public and end up in the bundle:

| Variable | Default | Meaning |
|---|---|---|
| `VITE_ONECLICK_JWT` | empty | Partner key for 1Click. Optional. |
| `VITE_FEE_RECIPIENT` | `unpair.near` | Who receives the routing fee. Self-hosters can set their own. |
| `VITE_FEE_BPS` | `50` | Routing fee in basis points. The SDK caps it at 100. |
| `VITE_OFFICIAL_ORIGIN` | `https://unpair.xyz` | Shown in the notice on other origins. |
| `VITE_API_URL` | empty | unpair-api base URL. When set, addresses are screened there and quotes come back signed. |
| `VITE_API_PUBKEY` | empty | The API's Ed25519 public key, hex, from `GET /v1/pubkey`. A quote that does not verify is refused. |
| `VITE_LWD_GRPC_WEB_URL` | empty | A gRPC-web proxy in front of lightwalletd. When set, the page offers "This browser". |
| `VITE_ZCASH_NETWORK` | `main` | `main` or `test`. The network the browser wallet uses. |

## The browser wallet

"This browser" runs a Zcash wallet inside the tab for one swap. It is the
Rust crate in `packages/zcash` compiled to WebAssembly, loaded at run time from
`public/wasm/`, and driven from a worker so proving does not freeze the page.
The folder is not committed. Build it before `pnpm build` or `pnpm dev`:

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-pack
apps/web/scripts/build-wasm.sh          # release; "dev" for a quick build
```

The secp256k1 C code needs a clang that can emit WebAssembly. Apple's clang
cannot; `brew install llvm` or a wasi-sdk release can. Point
`CC_wasm32_unknown_unknown` at it if the script does not find it. Without the
build the choice stays visible and says it is off.

The page also needs `VITE_LWD_GRPC_WEB_URL`. See the self-host guide for the
proxy. The Pages workflow builds the wallet on every deploy.

## What the page does

1. Pick Fast or Quiet. Quiet rounds the amount to a 1, 2, 5 grid.
2. Pick the source chain and asset, the amount, a refund address on the source
   chain, and a transparent Zcash address.
3. Read the fee sentence, get a quote, read the exact fee the route applied.
4. Send the deposit to the address shown. The page polls the route until the
   swap lands, is refunded, or fails.

The Zcash address can be a shielded-only unified address, which the route pays
straight into Ironwood, or a transparent address, which your wallet shields on
receipt. A unified address that also carries a transparent receiver is paid to
that receiver. Sapling-only addresses are refused with a reason. The page decodes
unified addresses itself to tell these apart. This page is the bring-your-own-wallet
front end. The Unpair app holds the key itself and needs no other wallet; the
page points to it as the other choice.

## Choices on the page

- **Swap in or Send out.** Swap in lands an asset in Zcash. Send out is the second
  hop: ZEC leaves your shielded wallet and arrives as another asset at an address
  you choose. You pay the route's Zcash address from your own wallet.
- **Fast or quiet.** Quiet rounds the amount and suggests a random wait between
  the hops.
- **Who holds the coins in between.** Your own wallet, this browser, or
  Unpair's server. With this browser, the tab makes a Zcash wallet for the
  swap, hands the route a fresh shielded address, and pays hop two itself once
  the note is spendable, after a random wait in quiet mode. The key stays in
  the tab. A recovery file, offered before the deposit address, reopens the
  wallet in a new tab and finishes the swap from the pool. With the server, hop one lands in Unpair's shielded wallet
  and the server pays hop two later to the asset and address you chose, so the
  tab can close. The page says next to the choice that the server holds your
  funds between the hops and sees both ends. The choice is only on when the
  configured API runs the hosted service. A swap link `?swap=<id>` reopens a
  hosted swap.
- **Who pays the route in Send out.** Your own wallet pays the route's Zcash
  address, or this browser: the tab makes a wallet, you pay its shielded
  address from any Zcash wallet, and the tab proves and pays hop two. A failed
  hop two comes back to the tab's wallet.
- **Refunds in Send out.** The refund address can be a shielded-only unified
  address, so a failed swap comes back straight into the pool, or a transparent
  address that your wallet shields again.
- **Route.** NEAR Intents today. Maya Protocol and THORChain are listed with the
  reason they are off, so the choice is visible before it is live.
- **More privacy options.** Rounding on or off, slippage, suggested or your own
  timing for the second hop, and a Tor Browser hint.

None of these add a party to trust. They all run on your device.

## With the API

Set `VITE_API_URL` and `VITE_API_PUBKEY` to route through unpair-api. The page then:

1. screens the refund and Zcash addresses, and stops with the reason if one is refused,
2. asks the API for a quote, which the API forwards to 1Click with its own fee and signs,
3. verifies the signature against the pinned key before showing the quote,
4. polls status through the API.

Without the API the page calls 1Click directly and no screening happens, which is
fine for local development and for self-hosters who accept that.

## Privacy notes

- Your browser talks to 1Click directly. Use Tor Browser or a VPN if you do not
  want the route to see your IP.
- The page stores nothing. Closing it loses the status view, not the swap. The
  deposit address is enough to look the swap up again on the route's explorer.
