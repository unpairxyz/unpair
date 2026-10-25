# Threat model

Unpair unlinks a transfer by landing it in Zcash's shielded pool. This page says
what each observer can see. It is written for users, not lawyers.

## Observers

| Observer | Fast mode, one hop | Quiet mode, two hops | Notes |
|---|---|---|---|
| Anyone watching public chains | Sees the deposit on the source chain. Sees a payout enter a pool of about 5 million ZEC. Can match only by amount and timing. | Same, and rounded amounts plus a random release delay break amount and timing matches. | Strong from day one. |
| The route operator for a hop (NEAR Intents, THORChain, Maya) | Sees the sender, the recipient landing address and the amount of its own leg. Unlinkability against it is its logging policy. | Each operator sees one leg only. Hop one sees a payout into the pool. Hop two sees a source with no history. | Quiet mode uses a different operator for each hop. |
| Unpair | Nothing. Quotes are requested from your device. Our server never sees deposit and destination together. | Nothing. | We are the party that would receive a subpoena. We design so there is nothing to hand over. |
| Your network provider | Sees that you reached a route operator or a lightwalletd server. | Same. | Use Tor, the default in the app. Nym is optional. |

## Hard limits

- Trustless cross-chain unlinkability does not exist today. Each route operator sees its own leg.
- While a swap is in flight, funds sit with the route operator. NEAR Intents, THORChain and Maya have each had incidents. We hold nothing, so we cannot make you whole.
- The anonymity set is the Zcash shielded pool. Very large or very unusual amounts stand out even after rounding.
- Zcash's Orchard pool has no trusted setup. That is the part that needs no trust.

## What we do about it

- A fresh landing address per swap. Never reused.
- Transparent payouts are shielded in one step.
- Refund addresses are never shielded addresses posted to a public chain.
- Quiet mode rounds the amount and releases after a random delay with a mean of about 3 hours and a cap of 12.
- Every fee is shown before the trade and capped in code.
- Addresses are screened before execution. Sanctioned jurisdictions are not served.
