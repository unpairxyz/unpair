# @unpair/client

Front-end logic for Unpair front ends. It never touches a key.

- `ApiClient`, `verifySignedQuote`: talk to unpair-api and check that a quote was
  signed by the key the front end pins.
- `planAmount`, `STATE_COPY`, `stateOf`: fast and quiet mode planning
  and the words shown for each state.
- `decodeUnified`, `describeCheck`, `describeRefundCheck`: decode a Zcash
  address, tell shielded-only from transparent, and refuse Sapling-only ones
  with a reason.
- `checkAddressForChain`: a shape check for an address on any chain the route
  serves.

```sh
pnpm --filter @unpair/client build
pnpm --filter @unpair/client test
```
