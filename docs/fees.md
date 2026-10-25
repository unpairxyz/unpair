# Fees

Every fee is shown before you confirm. The routing fee cap is written in code and
cannot be raised by configuration.

## Routing fee

| Mode | Fee asked | What you pay | Unpair keeps | Route operator keeps |
|---|---|---|---|---|
| Fast, 1Click route | 0.5% | 0.5% | 0.25% | 0.25% |
| Quiet, two hops | 0.5% per hop | about 1% in total | about 0.5% | about 0.5% |

The split with 1Click is 50/50 with a 20 basis point floor on 1Click's half. The
numbers above were measured with live quotes on 25 October 2026. The exact split
for your quote is read back from the quote itself and shown before you deposit.

The cap in code is 1% per hop.

## Network fees

| Step | Who pays | Amount |
|---|---|---|
| Deposit on the source chain | You | Source chain gas |
| Shield into the pool | You, from the landed amount | 0.00015 ZEC for one landing output, 0.00005 ZEC more per extra output (ZIP 317) |
| Send out of the pool, hop two | You, from the shielded balance | 0.00015 ZEC for one note spent, 0.00005 ZEC more per extra note (ZIP 317) |

Unpair takes nothing on network fee steps.

## Flagged flows

No fee is taken from a flow that screening stops. The deposit is refunded to the
refund address you gave, minus network fees.
