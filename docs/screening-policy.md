# Screening policy

Unpair checks two things before any quote is given. Nothing moves until both pass.

## Where you are

The edge sets a country header on every request. Requests from comprehensively
sanctioned jurisdictions are refused. The default list is Cuba, Iran, North Korea
and Syria. The list is public in the server configuration and in `/v1/config`.

## Who you pay and who gets refunds

The refund address on the source chain and the destination address, on Zcash
or on the chain you chose, are screened. A match on the configured list or a risk flag from the screening
provider refuses the quote. The message says the address cannot be used. It does
not say why in detail, because that would help the wrong people.

## What we never do

- No fee is taken from a refused flow. There is no quote, so there is nothing to take.
- No identity is collected. There is no account, no email, no KYC form.
- No IP addresses are logged with verdicts. The log line holds the check that
  refused and the chain, nothing else.
- Screening happens before execution, never after. With the one-time wallet or your
  own wallet we cannot freeze funds, because in those modes we hold none. On
  the server path a flagged address is refused before any deposit is taken.

## What a provider sees

In `http` mode the address and chain go to the screening provider. Nothing else
does. In `denylist` mode nothing leaves the server.

## Appeals

An address refused in error can be reported through the repository. We can fix a
list entry. We cannot override a provider's verdict for a hosted instance.
Self-hosters set their own policy.
