# Fees

Every fee is shown before you confirm. The routing fee cap is written in code and
cannot be raised by configuration.

## Routing fee

Unpair asks 0.5% on each hop it quotes. 1Click splits it 50/50, with a floor of
0.2% on its own half. Where Unpair asks nothing, 1Click still takes its own 0.2%.

| Held by | Hop one | Hop two |
|---|---|---|
| One-time wallet | 0.5%: Unpair 0.25%, 1Click 0.25% | 0.5%: Unpair 0.25%, 1Click 0.25% |
| Unpair server | 0.5%: Unpair 0.25%, 1Click 0.25% | 1Click's own 0.2%, nothing for Unpair |
| My Zcash wallet | 0.5%: Unpair 0.25%, 1Click 0.25% | Send out, when you do it here: 0.5%, split the same way |

Stablecoin pairs and routes to the same asset on another chain have a lower floor
for 1Click. On ZEC to ZEC on Solana, measured on 6 November 2026, 1Click took
nothing and the full 0.5% went to Unpair. Fast and quiet mode pay the same rates.

The cap in code is 1% per hop.

## The cost the form shows

The form asks the route for real quotes of both hops before you ask for a deposit
address, and shows the full cost of your route in US dollars: Unpair's fee and
1Click's fee as each quote states them, the Zcash network fee of hop two, ZEC
left in the Zcash wallet, and the rest, which is the route's price and each
chain's gas. The parts add up to the total: what you send less what you get.
In quiet mode on the server path, each standard-size piece is quoted on its own.

## Network fees

| Step | Who pays | Amount |
|---|---|---|
| Deposit on the source chain | You | Source chain gas |
| Shield into the pool | You, from the landed amount | 0.00015 ZEC for one landing output, 0.00005 ZEC more per extra output (ZIP 317) |
| Send out of the pool, hop two | You, from the shielded balance | 0.00015 ZEC for one note spent, 0.00005 ZEC more per extra note (ZIP 317) |
| Hop two from the browser wallet | You, from the ZEC that landed | The tab keeps 0.0002 ZEC back for the fee and sends the rest. What the real fee leaves over stays in the tab's wallet; the recovery file can spend it. |
| Hop two on the server path | You, from the ZEC that landed | The server keeps 0.0002 ZEC back per part for the fee. What the real fee leaves over stays as change in the transit wallet. |
| Quiet mode on the server path | You, from the ZEC that landed | Hop two goes out in standard sizes. What is left under 0.02 ZEC stays in the transit wallet. The page says this before you deposit, and the swap page shows the exact amount. |

Unpair takes nothing on network fee steps. On the server path Unpair's fee is
taken on hop one only. From the one-time wallet both hops carry it, as with your
own wallet when you send out here.

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
