# @unpair/sdk

The routing core of Unpair. No network dependencies. Works in browsers and in Node 22 or later.

It gives a wallet or a web app:

- a 1Click (NEAR Intents) client that adds Unpair's routing fee and validates requests before they leave the device,
- fee rules with the cap written in code,
- amount rounding and a random release timer for quiet mode,
- a `Route` interface so THORChain and Maya can plug in next to 1Click,
- a `Transport` interface so the caller decides how traffic leaves the device: clearnet, Tor or Nym.

## Install

```sh
pnpm add @unpair/sdk
```

## Quote and swap

```ts
import { ASSETS, OneClickClient, torTransport } from "@unpair/sdk";

const client = new OneClickClient({
  apiKey: process.env.ONECLICK_JWT,          // optional; without it 1Click adds 25 bps
  fee: { recipient: "unpair.near", feeBps: 50 },
  transport: torTransport(myTorFetch),        // a fetch bound to arti or a Tor SOCKS proxy
});

// 1. Show the estimated fee before anything else.
const preview = client.previewFee({ symbol: "ETH" }, { symbol: "ZEC" }, "EXACT_INPUT");
console.log(preview.text);
// Fee 0.5% of the amount you send. Unpair keeps 0.25%, 1Click keeps 0.25%.

// 2. Get a quote. dry: true commits nothing and returns no deposit address.
const quote = await client.quote({
  swapType: "EXACT_INPUT",
  slippageTolerance: 100,
  originAsset: ASSETS.ETH,
  depositType: "ORIGIN_CHAIN",
  destinationAsset: ASSETS.ZEC,
  amount: "100000000000000000",            // 0.1 ETH in wei
  refundTo: "0xYourAddress",
  refundType: "ORIGIN_CHAIN",
  recipient: "t1...",                       // fresh transparent landing address, see packages/zcash
  recipientType: "DESTINATION_CHAIN",
});

// 3. Show the exact fee 1Click applied, then let the user decide.
console.log(client.feeFromQuoteResponse(quote).text);

// 4. The user sends the deposit to quote.quote.depositAddress. Then:
const final = await client.waitForFinalStatus(quote.quote.depositAddress!, undefined, {
  onUpdate: (s) => console.log(s.status),
});
```

Statuses map to the words the UI shows: `waiting_for_deposit`, `routing`, `landed`, `refunded`, `failed`.

## Fees

The cap is `FEE_CAP_BPS = 100` (1%). It is a constant. A deployment cannot raise it with config.

1Click's split, as measured with live dry quotes on 2026-10-25:

| Fee requested | What the user pays | Unpair | 1Click |
|---|---|---|---|
| 50 | 50 bps | 25 bps | 25 bps |
| 5 | 23 bps | 3 bps | 20 bps (its floor) |
| 0 | 20 bps (1 bp on stable pairs) | 0 | 20 bps |
| 100 | 100 bps | 50 bps | 50 bps |

The docs say a request without an API key keeps the full fee for the partner and adds 25 bps for 1Click. Live quotes without a key did not do that. They used the same 50/50 split as above. `oneClickFeeBreakdown` follows the measured behaviour as the estimate before a quote. `feeFromQuoteResponse` reads the exact split 1Click echoes in the quote, and that is the number to show before the deposit.

## Quiet mode helpers

- `roundDownSignificant(amount, 1)`: 4.93 ZEC becomes 4 ZEC. Nine values per decade.
- `roundDownCoarse(amount)`: 4.93 ZEC becomes 2 ZEC. Three values per decade, more collisions.
- `scheduleRelease(landedAt)`: exponential delay, mean 144 blocks, cap 576 blocks. About 3 hours on average, never more than 12.

Both rounding functions round down and return the remainder. The remainder stays in the user's shielded wallet.

## Transport

The SDK calls one `fetch`-shaped function and nothing else. Pass:

- `clearnetTransport()` for development. It leaks the caller's IP to the route operator.
- `torTransport(fetch)` with a fetch bound to arti or a Tor SOCKS proxy.
- `nymTransport(fetch)` with a fetch from `@nymproject/mix-fetch` or a native nym-sdk binding.

## Test

```sh
pnpm test
```

Tests use a mocked fetch. There is no 1Click testnet. Live checks use `dry: true` quotes, which commit nothing. One such check on 2026-10-25 quoted 0.1 ETH to ZEC and 1000 USDC to ZEC and returned the fee splits in the table above. 1Click rejected a burn address as `refundTo`, so refund addresses are screened too.
