# Unpair web app

A static page. With the API configured, addresses are screened one at a time
and quotes come back signed; the host of the page itself never sees a key, and
on the own-wallet and one-time-wallet paths no server sees your deposit and
your destination together.

## Icons

The token picker shows icons from our own origin, never from a third party at
page load. Fill `public/icons/` before a build:

```sh
node apps/web/scripts/fetch-icons.mjs
```

The folder is not committed. The Build and Release workflows run the script before they build.
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
Build workflow, run by hand or by a release, builds `dist/` with the browser
wallet and the icons and keeps it as the artifact `unpair-web`; a release
attaches it as `unpair-web.tar.gz` with its hash.

Environment values are public and end up in the bundle:

| Variable | Default | Meaning |
|---|---|---|
| `VITE_ONECLICK_JWT` | empty | Partner key for 1Click. Optional. |
| `VITE_FEE_RECIPIENT` | `unpair.near` | Who receives the routing fee. Self-hosters can set their own. |
| `VITE_FEE_BPS` | `50` | Routing fee in basis points. The SDK caps it at 100. |
| `VITE_OFFICIAL_ORIGIN` | `https://unpair.xyz` | Shown in the notice on other origins. |
| `VITE_API_URL` | empty | unpair-api base URL. When set, addresses are screened there and quotes come back signed. |
| `VITE_API_PUBKEY` | empty | The API's Ed25519 public key, hex, from `GET /v1/pubkey`. A quote that does not verify is refused. |
| `VITE_LWD_GRPC_WEB_URL` | empty | A gRPC-web proxy in front of lightwalletd. When set, the page offers the one-time wallet. |
| `VITE_ICON_BASE` | `/icons` | Where token and chain icons are served from. Leave it on the page's own origin, or the page makes third-party requests. |
| `VITE_ZCASH_NETWORK` | `main` | `main` or `test`. The network the browser wallet uses. |

## The browser wallet

The one-time wallet runs a Zcash wallet inside the tab for one swap. It is the
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
proxy. The Build workflow builds the wallet, from a cache when the Zcash
crates did not change.

## What the page does

1. Pick Fast or Quiet. Quiet rounds the amount to a 1, 2, 5 grid.
2. Pick the source chain and asset, the amount, what you want to get and where,
   and a refund address on the source chain.
3. Pick who holds the ZEC in between. The form shows the fee and the estimate
   from the route before anything is created.
4. Send the deposit to the address shown. The page follows the swap until it
   lands, is refunded, or fails.

With your own wallet the destination is a Zcash address: a shielded-only
unified address, which the route pays straight into Ironwood, or a transparent
address, which your wallet shields on receipt. A unified address that also
carries a transparent receiver is paid to that receiver. Sapling-only addresses
are refused with a reason. The page decodes unified addresses itself to tell
these apart.

## Choices on the page

- **Swap in or Send out.** Swap in lands an asset in Zcash. Send out is the second
  hop: ZEC leaves your shielded wallet and arrives as another asset at an address
  you choose. You pay the route's Zcash address from your own wallet.
- **Fast or quiet.** Quiet rounds the amount and suggests a random wait between
  the hops.
- **Who holds the coins in between.** The one-time wallet, Unpair's server, or
  your own wallet. With the one-time wallet, the tab makes a Zcash wallet for
  the swap, hands the route a fresh shielded address, and pays hop two itself
  once the note is spendable, after a random wait in quiet mode. The key stays
  in the tab. A recovery file, offered before the deposit address, reopens the
  wallet in a new tab and finishes the swap from the pool. You can also pay the
  tab's address with ZEC you already hold. With the server, hop one lands in
  Unpair's shielded wallet and the server pays hop two later to the asset and
  address you chose, so the tab can close. The page says next to the choice
  that the server holds your funds between the hops and sees both ends. The
  choice is only on when the configured API runs the hosted service. A swap
  link `?swap=<id>` reopens a hosted swap. With your own wallet, the ZEC lands
  there, shielded, and you send out later.
- **Send out.** Your own wallet pays the route's Zcash address. The refund
  address can be a shielded-only unified address, so a failed swap comes back
  straight into the pool, or a transparent address that your wallet shields
  again.
- **Fee and time per choice.** Two chips next to each choice, and the summary
  line under the form, say what each path costs and how long it takes. Quiet
  mode adds its random wait.
- **Check on your phone.** Parks the signed quote on the API for a second
  device, which must show the same mark and code.
- **Slippage.** 0.5%, 1% or 2%, in the settings behind the small button.

## With the API

Set `VITE_API_URL` and `VITE_API_PUBKEY` to route through unpair-api. The page then:

1. screens the refund and Zcash addresses, and stops with the reason if one is refused,
2. asks the API for a quote, which the API forwards to 1Click with its own fee and signs,
3. verifies the signature against the pinned key before showing the quote,
4. polls status through the API.

Without the API the page calls 1Click directly and no screening happens, which is
fine for local development and for self-hosters who accept that.

## Privacy notes

- Your browser fetches the token list from 1Click directly, and quotes too
  when no API is configured. Use Tor Browser or a VPN if you do not want the
  route to see your IP. The one-time wallet also reads the chain through the
  gRPC-web proxy, which sees the tab's IP.
- The page keeps only the theme and your recent tokens in local storage. No
  key, no address and no swap is stored. Closing the tab loses the status view
  of your own-wallet swap, not the swap; a hosted swap comes back by its link;
  the one-time wallet comes back by its recovery file.
