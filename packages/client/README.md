# @unpair/client

Front-end logic shared by the Unpair web page and the Unpair desktop app. It
never touches a key.

- `ApiClient`, `verifySignedQuote`: talk to unpair-api and check that a quote was
  signed by the key the front end pins.
- `planAmount`, `MODE_COPY`, `STATE_COPY`, `stateOf`: fast and quiet mode planning
  and the words shown for each state.
- `checkZcashAddress`: accepts a transparent Zcash address and refuses unified or
  Sapling ones with a reason, because the routes pay transparent only.

```sh
pnpm --filter @unpair/client build
pnpm --filter @unpair/client test
```
