# Fees

Every fee is shown before you confirm. The routing fee cap is written in code and
cannot be raised by configuration.

## Routing fee

| Mode | Fee asked | What you pay | Unpair keeps | Route operator keeps |
|---|---|---|---|---|
| Fast, 1Click route | 0.5% | 0.5% | 0.25% | 0.25% |
| Quiet, two hops | 0.5% per hop | about 1% in total | about 0.5% | about 0.5% |

The split with 1Click is 50/50 with a 20 basis point floor on 1Click's half. The
numbers above were measured with live quotes on 25 October 2026. The fee for your
swap is on the form before you ask for a deposit address.

The cap in code is 1% per hop.

## Network fees

| Step | Who pays | Amount |
|---|---|---|
| Deposit on the source chain | You | Source chain gas |
| Shield into the pool | You, from the landed amount | 0.00015 ZEC for one landing output, 0.00005 ZEC more per extra output (ZIP 317) |
| Send out of the pool, hop two | You, from the shielded balance | 0.00015 ZEC for one note spent, 0.00005 ZEC more per extra note (ZIP 317) |
| Hop two from the browser wallet | You, from the ZEC that landed | The tab keeps 0.0002 ZEC back for the fee and sends the rest. What the real fee leaves over stays in the tab's wallet; the recovery file can spend it. |
| Hop two on the server path | You, from the ZEC that landed | The server keeps 0.0002 ZEC back per part for the fee. What the real fee leaves over stays as change in the transit wallet. |
| Quiet mode on the server path | You, from the ZEC that landed | Hop two goes out in standard sizes. What is left under 0.02 ZEC stays in the transit wallet. The page says this before you deposit, and the swap page shows the exact amount. |

Unpair takes nothing on network fee steps. On the server path the routing fee
is taken on hop one only; hop two carries no routing fee. From the browser
wallet both hops are quoted from your device, so each carries the routing fee,
as with your own wallet.

## Why a small swap gets less

Three costs do not shrink with the amount: the route's own minimum on each
hop, the network fee reserve of 0.0002 ZEC kept back before hop two, and in
quiet mode on the server path the dust under the smallest standard size. On a
3 USD swap they add up to about a fifth of it. The page shows what the route
will pay before you deposit. Swap at least about 20 USD worth to keep them
small.

## Flagged flows

No fee is taken from a flow that screening stops. The deposit is refunded to the
refund address you gave, minus network fees.
