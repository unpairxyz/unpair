# Threat model

Unpair unlinks a transfer by landing it in Zcash's shielded pool. This page says
who holds what, what each observer can see, and what you still have to trust.
It is written for users, not lawyers.

## Who holds the keys

Shielded ZEC exists only under a spending key. So the key that receives and
later spends your ZEC has to live somewhere. You choose where, per swap.

- **Your own wallet.** The web page never sees a key. Give it a shielded-only
  unified address and the route pays straight into the pool; give it a
  transparent address and your wallet shields it. For a two-hop swap you send
  the second hop from your own wallet with the Send out tab. Unpair holds
  nothing on this path.
- **Unpair's server.** The server holds a transit key. Hop one pays a fresh
  shielded-only address of that wallet, so the ZEC lands in Ironwood with no
  transparent step. After a release delay the server pays hop two from the pool
  to the asset and address you chose. Between those two moments the server holds
  your ZEC, and it sees both ends of your swap. Each swap is one note in and one
  spend out; there is no pooled balance beyond swaps in flight, and the per-swap
  and in-flight caps are in the server's configuration and in `/v1/config`.
- **The Unpair app.** Creates the seed on your device and keeps it in the
  operating system keychain. Same flow as the server path, with the key on your
  machine. Not the focus right now.

A swap that ends in ZEC makes the app your Zcash wallet, so the app requires a
seed backup first. A pass-through swap, from one asset through shielded ZEC to
another, can run on a one-time transit seed. The app offers a backup and warns
that funds in transit need it.

## Observers

| Observer | Fast mode, one hop | Quiet mode, two hops | Notes |
|---|---|---|---|
| Anyone watching public chains | Sees the deposit on the source chain. Sees a payout enter a pool of about 4 million ZEC. Can match only by amount and timing. | Same, and rounded amounts plus a random release delay break amount and timing matches. | Strong from day one. |
| The route operator for a hop (NEAR Intents today) | Sees the sender, the recipient address and the amount of its own leg. Unlinkability against it is its logging policy. | Each operator sees one leg only. Hop one sees a payout into the pool. Hop two sees a source with no history. | Quiet mode uses a different operator for each hop when one is available. |
| Anyone, for a payout straight into the pool | The route's bridge encrypts the shielded output with an all-zero outgoing key, so the amount and the receiving address of that one payout are readable by anyone. The note is in the pool, but the swap itself is public. | Same for hop one. Hop two spends from the pool, and that spend is unlinkable. | This is why each address is used once, and why the unlinking comes from the later spend, not from the payout. |
| Unpair, own-wallet path | Nothing that links the two ends. Quotes are requested from your device. The server sees the addresses it screens, one request at a time, and never a deposit and a destination together. | Nothing. | We are the party that would receive a subpoena. On this path there is nothing to hand over. |
| Unpair, server path | Both ends: the deposit, the receiving address and the timing, for seven days after the swap finishes. | Same, plus the release delay it chose. | This is the price of closing the tab. The server is the one party able to link your swap. |
| Your network provider | Sees that you reached a route operator or a lightwalletd server. | Same. | The app uses Tor for lightwalletd and broadcast by default. Nym is optional. |

## What you still trust

- The route operator while a swap is in flight. Today that is NEAR Intents and
  nothing else. Funds sit with it between deposit and payout. On 1 October 2026 a
  bug drained about $3.8M from a NEAR Intents hot wallet; the funds were returned
  the next day. If a route loses funds we cannot make you whole.
- On the server path, Unpair itself: its custody of your ZEC between the hops,
  its logs, and its solvency. The server keeps the swap record for seven days
  after it finishes, then deletes it. While it exists, that record ties your
  deposit to your receiving address, and a subpoena could reach it.
- Our code. We shrink this with signed releases and published hashes, and with
  quotes you can check against 1Click directly. Reproducible builds are planned;
  we will claim them only once an independent rebuild matches.

Nothing else. No own node, no own chain, no token.

## Hard limits

- Trustless cross-chain unlinkability does not exist today. Each route operator sees its own leg.
- The anonymity set is the Zcash shielded pool. Very large or very unusual amounts stand out even after rounding.
- Zcash's shielded pool has no trusted setup. That is the part that needs no trust. The live pool is Ironwood, which uses the Orchard protocol; it held about 4.2 million ZEC in October 2026.
- Lose the seed and nothing can recover the ZEC under it. Not us, not the route.

## What we do about it

- A fresh landing address per swap. Never reused.
- Payouts go straight into Ironwood when the route can pay a shielded-only address. Transparent payouts are shielded into Ironwood in one step, on your device.
- Refund addresses follow the payout rule. A shielded-only unified address is refunded straight into the pool, a transparent address is shielded again on receipt. Like the payout address, a refund address is readable for that one transaction, so it is fresh and used once.
- Quiet mode rounds the amount and releases after a random delay with a mean of about 3 hours and a cap of 12.
- Every fee is shown before the trade and capped in code.
- Addresses are screened before execution. Sanctioned jurisdictions are not served.

## Routes we have not added

Maya Protocol pays shielded Zcash, but into Sapling, a pool about ten times
smaller than Ironwood. It would also move the in-flight trust from NEAR Intents
to Maya, and Maya was exploited and halted from 18 August to 1 October 2026. If
Maya is added it will be an optional route that you pick, never the default.
THORChain carries ZEC, transparent only, in a pool a few dozen ZEC deep. Custodial
swap services are out because they can hold funds.

## The server path, in plain words

Your receiving address never appears on NEAR or in a bridge output next to your
deposit, because the route pays Unpair's wallet, not yours, and the second hop
starts from a fresh shielded note at a time the server picks. That is a stronger
break of the on-chain link than a payout into your own wallet. The price is
that you trust us with your funds for that time, and that we can link the two
ends. It also makes us a custodian in the eyes of regulators in some places.
The page says this next to the choice. Your own wallet is the default.
