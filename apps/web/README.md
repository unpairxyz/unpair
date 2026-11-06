# Unpair web app

A static page. With the API configured, hop one is screened and its quote comes
back signed. The host of the page itself never sees a key. On the one-time
wallet and Send out, the hop that names your destination goes from the page to
1Click directly: the API never gets that address.

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
| `VITE_ONECLICK_JWT` | empty | Partner key for 1Click. Optional, and public once built: set it only for a page without an API. |
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
- **Check on your phone.** Parks hop one's signed quote on the API for a
  second device, which must show the same mark and code. Send out has no
  signed quote, because the API never gets it, so it has no phone check. The
  page checks that quote itself before it shows it: it must name your
  address, asset and amount, and carry no fee above ours plus what 1Click
  documents.
- **Slippage.** 0.5%, 1% or 2%, in the settings behind the small button.

## With the API

Set `VITE_API_URL` and `VITE_API_PUBKEY` to route through unpair-api. The page then:

1. screens hop one's refund and destination addresses, and stops with the reason if one is refused,
2. asks the API for hop one's quote, which the API forwards to 1Click with its own fee and signs,
3. verifies the signature against the pinned key before showing the quote,
4. polls hop one's status through the API.

A hop that names your final destination does not go through the API. These
are hop two of the one-time wallet and Send out. For them the page:

1. fetches the API's whole denylist as hashes (`GET /v1/screen/list`), and
   checks the addresses itself. Every caller gets the same list, so the API
   learns nothing about the address,
2. asks 1Click directly for the quote, with the same routing fee in it, and
   refuses it unless it names the same addresses, assets and amount, and its
   fee is no more than ours plus the 0.25% 1Click documents for a call
   without a partner key,
3. polls that hop's status on 1Click directly.

The API never gets that hop's destination or its deposit address. The form's
estimate leaves the destination out on these paths, and the API prices the hop
with a stand-in address. An API that screens with a vendor has no list to
give. The page then sends it the addresses to screen, one at a time.

Without the API the page calls 1Click directly and no screening happens, which is
fine for local development and for self-hosters who accept that.

## Privacy notes

- Your browser asks 1Click directly for the hop that names your destination,
  and for every quote when no API is configured. Use Tor Browser or a VPN if
  you do not want the route to see your IP. The one-time wallet also reads the
  chain and sends hop two through the gRPC-web proxy, which sees the tab's IP.
  The proxy relays hop two's transaction, which pays the route's deposit
  address, and the route's public status maps that address to your
  destination. If the API and the proxy run on one server, as on unpair.xyz,
  its operator could link the two hops by IP. Tor Browser stops that.
- The page's Content-Security-Policy must allow `https://1click.chaindefuser.com`
  in `connect-src`.
- The page keeps only the theme and your recent tokens in local storage. No
  key, no address and no swap is stored. Closing the tab loses the status view
  of your own-wallet swap, not the swap; a hosted swap comes back by its link;
  the one-time wallet comes back by its recovery file.
