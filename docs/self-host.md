# Self-host guide

Unpair has three pieces. None of them holds a key on a server. Each can be
hosted or built on its own.

## 1. The app

The desktop app is the part that holds your Zcash key, shields the payout and
runs the second hop. It is built on `packages/zcash` and ships as signed releases
with published hashes, so you can check a download against the source. Building
it yourself from the repo is the same thing without the signature.

Until a release ships, run it from source as its README describes, or use the
web page below with any Zcash wallet that shields on receipt, such as Zodl, Zingo
or Zkool.

## 2. The web page

Static files. Build and upload them anywhere.

```sh
pnpm install
pnpm --filter @unpair/sdk build
pnpm --filter @unpair/web build
```

Upload `apps/web/dist`. Set `VITE_FEE_RECIPIENT` and `VITE_FEE_BPS` to route the
fee to yourself, or `VITE_FEE_BPS=0` for none. The page talks to 1Click from the
browser. It does not need the API.

`.github/workflows/web.yml` builds the page and publishes it to GitHub Pages on
every push to `main`. Turn on Pages for the repository with "GitHub Actions" as
the source, set the repository variables listed at the top of that file, and
point your domain's DNS at GitHub Pages. Set `BASE_PATH=/name/` when the page
is served under a sub-path instead of a domain of its own.

## 3. The API

Needed for screening and signed quotes. It holds no key that can receive funds.
See `apps/api/README.md`. A 1 vCPU, 1 GB VPS is enough. Build off the box:

```sh
cargo build -p unpair-api --release
scp target/release/unpair-api yourbox:/usr/local/bin/
```

`apps/api/deploy/Caddyfile` is a reverse proxy with TLS for the box. The country
header that the geofence reads must come from a trusted edge only. With
Cloudflare in front, allow port 443 from Cloudflare's address ranges and nothing
else, and remove the line in the Caddyfile that strips the header.

Minimum production settings:

- `UNPAIR_SCREENING=denylist` or `http`. Never `off` on a public URL.
- `UNPAIR_SIGNING_SEED` set once and kept. Publish the public key next to your domain.
- `UNPAIR_GEOFENCE_REQUIRE_HEADER=true` when the edge always sets the country header.

## Before a public URL

1. Run a small mainnet swap end to end with your own funds. Swap in to a
   shielded-only address and to a transparent one. Send out from a shielded
   wallet. Let one quote expire and check the refund.
2. Check `GET /v1/config` shows the fee you expect and screening is not `off`.
3. Pin the key: copy `GET /v1/pubkey` into `VITE_API_PUBKEY`. The page refuses
   quotes that do not verify against it.
4. Keep the signing seed out of git and out of backups that others can read.
   Changing it invalidates nothing in flight, but the page must be rebuilt
   with the new public key.
5. Set `UNPAIR_ALLOWED_ORIGINS` to the page's origin only.
6. Set `UNPAIR_GEOFENCE_REQUIRE_HEADER=true` once the edge sets the header on
   every request, and confirm a request without it is refused.
7. Confirm the clone-site notice: open the page on a different origin and see
   the notice that points at `VITE_OFFICIAL_ORIGIN`.
8. Read `docs/screening-policy.md` and `docs/threat-model.md` once more as the
   operator, and have the terms and the screening policy reviewed by counsel
   for the places you serve.
