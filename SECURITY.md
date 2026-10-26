# Security

Unpair moves money and touches keys. If you find a way to take funds, learn a
key, link a deposit to a payout, or get around screening or the fee cap, tell
us in private first.

## How to report

Use GitHub's private vulnerability reporting on this repository: open the
Security tab and choose "Report a vulnerability". Do not open a public issue
for a security problem.

Say what you found, how to trigger it, and what it lets an attacker do. A
proof of concept against your own instance or against testnet helps. Please do
not test against the official origin with other people's swaps.

## What to expect

- An answer within three days.
- A fix or a mitigation for a confirmed problem before any public note.
- Credit in the release notes if you want it.

## In scope

- `apps/api`: the API, the hosted swap path, screening, geofence, quote signing.
- `apps/web`: the page and the one-time wallet that runs in the browser.
- `packages/zcash`, `packages/zcash-web`: the wallet crate and its browser build.
- `packages/sdk`, `packages/client`: routes, fees, address checks.
- The deploy files under `apps/api/deploy`.

## Out of scope

- The swap provider's own service and its quotes.
- Lightwalletd servers the page or the API talks to.
- Denial of service by volume alone.
- Anything that needs a compromised operator box or browser.

## Versions

The newest tagged release and `main` get fixes. Older releases do not.
