# Terms

Last updated 30 October 2026.

These terms cover the page at unpair.xyz and the API at api.unpair.xyz. Unpair is run by its maintainers. There is no registered company behind it. The code is open source under the MIT licence at github.com/unpairxyz/unpair.

## What Unpair is

Unpair swaps one asset for another through Zcash's shielded pool. You send a deposit on one chain. The route pays ZEC to a fresh shielded Zcash address. From there, hop two sends the asset you chose to the address you gave.

Unpair does not run an exchange, a liquidity pool or a Zcash node. Each hop is a trade with NEAR Intents through its 1Click API. Unpair builds the two hops, shows the price and the fee, and in one mode holds the ZEC between them.

## Who holds the ZEC between the hops

You choose before you deposit.

- One-time wallet. A Zcash wallet made in your browser tab for one swap. The key stays on your device. Unpair never has it. If you close the tab without saving the recovery file, the ZEC in that wallet is lost.
- Your own wallet. The ZEC lands in a Zcash wallet you already run. Only you hold the key.
- Unpair's server. Unpair holds your ZEC in a transit wallet between the two hops, mixed with other users' ZEC. In this mode Unpair can see both ends of your swap. The cap is 1 ZEC per swap and 20 open swaps at a time. These caps are shown before you deposit.

## Fees

The routing fee is 0.5% of each hop. The cap is 1% per hop and is written in the code. The fee for your swap is on the form before a deposit address is made. Network fees on each chain are paid from your funds and are listed at github.com/unpairxyz/unpair/blob/main/docs/fees.md.

## Screening

Two checks run before every quote. Requests from Cuba, Iran, North Korea and Syria are refused. The refund address and the destination address are checked against a list. A refused request gets no quote and no deposit address, so nothing is taken.

Unpair never asks who you are. There is no account, no email and no identity form.

## The route operator

Each hop is settled by NEAR Intents. During a hop your funds are with that operator, under its own terms at near-intents.org.

## Refunds

If a hop fails, the route refunds the deposit to the refund address you gave, minus network fees. Unpair takes no fee on a failed or refused hop. In the one-time wallet mode, ZEC that has already landed stays in your wallet and can be spent with the recovery file. Unpair cannot refund funds it never held.

## Data

Unpair keeps no accounts and no log of IP addresses or browser details. The web server keeps no access log. The API log records which check refused a request and the chain, nothing about who asked. A swap on the server path is stored with its addresses, amounts and quotes until it finishes, then deleted after 7 days. A quote handed from the API to the page is kept in memory for at most 24 hours and never written to disk.

Three outside services see parts of your traffic. Cloudflare fronts the page and the API and sees your IP address. The lightwalletd server at zec.rocks sees the Zcash queries of the browser wallet. NEAR Intents sees the addresses and amounts of each hop. The threat model at github.com/unpairxyz/unpair/blob/main/docs/threat-model.md describes what each can learn.

## Risks

Unpair is early software with small caps and one route. Prices move between the quote and settlement. Chains, the route operator and Zcash itself can fail or be delayed. You use Unpair at your own risk and as is, with no warranty. Unpair is not liable for loss of funds or missed deadlines on any chain or route.

Do not use Unpair for anything unlawful where you are.

## Changes

These terms can change. The date at the top moves when they do, and the history is in the repository.

## Contact

Open an issue at github.com/unpairxyz/unpair.
