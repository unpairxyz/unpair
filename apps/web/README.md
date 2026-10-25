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
plain nginx folder all work. No server code, no database, no cookies.

Environment values are public and end up in the bundle:

| Variable | Default | Meaning |
|---|---|---|
| `VITE_ONECLICK_JWT` | empty | Partner key for 1Click. Optional. |
| `VITE_FEE_RECIPIENT` | `unpair.near` | Who receives the routing fee. Self-hosters can set their own. |
| `VITE_FEE_BPS` | `50` | Routing fee in basis points. The SDK caps it at 100. |
| `VITE_OFFICIAL_ORIGIN` | `https://unpair.xyz` | Shown in the notice on other origins. |
| `VITE_API_URL` | empty | unpair-api base URL. When set, addresses are screened there and quotes come back signed. |
| `VITE_API_PUBKEY` | empty | The API's Ed25519 public key, hex, from `GET /v1/pubkey`. A quote that does not verify is refused. |

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
- **Who holds the coins in between.** Your own wallet, the Unpair app, or
  Unpair's server. With the server, hop one lands in Unpair's shielded wallet
  and the server pays hop two later to the asset and address you chose, so the
  tab can close. The page says next to the choice that the server holds your
  funds between the hops and sees both ends. The choice is only on when the
  configured API runs the hosted service. A swap link `?swap=<id>` reopens a
  hosted swap.
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
