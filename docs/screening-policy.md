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

## Where the check runs

Hop one is screened on the server. The hop that names your final destination
is screened on your device. That hop is hop two of the one-time wallet, and
Send out. The page fetches the whole denylist from `/v1/screen/list` as
hashes: the SHA-256 of each trimmed, lower-case address. It hashes your
address and looks it up. Every caller gets the same list, so the server learns
nothing about the address. The list request also applies the geofence. A match
stops the page before it asks the route for a quote.

With the denylist, which unpair.xyz runs, your address never reaches us on
those paths. On those paths you hold the key, so a check on your device is as strong as a
check on our server: you could skip either by sending from your own wallet.
What the check gives is the same rule on every path, without our server
learning where your coins go.

In `http` mode the provider's list is not ours to hand out. The page then
sends the addresses to the server, one at a time, as on hop one, and stops
saying that the address stays on your device.

Anything in the denylist file is public at `/v1/screen/list`, as hashes. Do
not put a provider's licensed list in it.

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
does. In `denylist` mode nothing leaves the server, and the list leaves it only
as hashes.

## Appeals

An address refused in error can be reported through the repository. We can fix a
list entry. We cannot override a provider's verdict for a hosted instance.
Self-hosters set their own policy.
