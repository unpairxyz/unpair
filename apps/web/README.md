# Unpair web app

A static page. Quotes go from the browser straight to the route, so the server
that hosts this page never sees your deposit and your Zcash address together.

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

## What the page does

1. Pick Fast or Quiet. Quiet rounds the amount to a 1, 2, 5 grid.
2. Pick the source chain and asset, the amount, a refund address on the source
   chain, and a transparent Zcash address.
3. Read the fee sentence, get a quote, read the exact fee the route applied.
4. Send the deposit to the address shown. The page polls the route until the
   swap lands, is refunded, or fails.

The Zcash address must be transparent, because the route pays transparent only.
Use a fresh address from a wallet that shields automatically, such as Zodl or the
Unpair self-host wallet in `packages/zcash`. The page refuses unified and Sapling
addresses with a reason.

## Privacy notes

- Your browser talks to 1Click directly. Use Tor Browser or a VPN if you do not
  want the route to see your IP.
- The page stores nothing. Closing it loses the status view, not the swap. The
  deposit address is enough to look the swap up again on the route's explorer.
