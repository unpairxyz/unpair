# Self-host guide

Unpair has three pieces: the page, the API, and a gRPC-web proxy for the
one-time wallet. Only the API's hosted path holds a key on a server, and only
when you turn it on. Each piece can be hosted or built on its own.

## 1. The web page

Static files. Build and upload them anywhere.

```sh
pnpm install
pnpm --filter @unpair/sdk build
pnpm --filter @unpair/web build
```

Upload `apps/web/dist`. Set `VITE_FEE_RECIPIENT` and `VITE_FEE_BPS` to route the
fee to yourself, or `VITE_FEE_BPS=0` for none. Without an API the page talks to
1Click from the browser, with no screening and no server path. The one-time
wallet also needs the proxy in section 3.

`.github/workflows/build.yml` builds the page with the browser wallet and the
icons, from the repository variables listed at the top of that file, and
keeps it as a run artifact; a tag turns the same build into a release with
hashes. Serve the files from any static host.

## 2. The API

Needed for screening and signed quotes. Without a seed file it holds no key that
can receive funds; with one it runs the hosted swap path described below.
See `apps/api/README.md`. A 1 vCPU, 1 GB VPS is enough without hosted swaps;
with them, 2 GB. Build off the box. Every tagged release on GitHub carries the
Linux x86_64 binary and the page with their sha256 sums; between releases the
Build workflow, run by hand, keeps a build of any branch as an artifact for
seven days. Or build it yourself:

```sh
cargo build -p unpair-api --release
scp target/release/unpair-api yourbox:/usr/local/bin/
```

`apps/api/deploy/Caddyfile` is a reverse proxy with TLS for the box. It serves HTTP/1.1 and HTTP/2 only: on a network that drops QUIC, Safari waits about 30 s per connection before it falls back from HTTP/3, and the one-time wallet looks stuck. Turn HTTP/3 off at Cloudflare too if it proxies the hosts. The country
header that the geofence reads must come from a trusted edge only. With
Cloudflare in front, allow port 443 from Cloudflare's address ranges and nothing
else, and remove the line in the Caddyfile that strips the header.

Minimum production settings:

- `UNPAIR_SCREENING=denylist` or `http`. Never `off` on a public URL.
- `UNPAIR_SIGNING_SEED` set once and kept. Publish the public key next to your domain.
- `UNPAIR_GEOFENCE_REQUIRE_HEADER=true` when the edge always sets the country header.
- `UNPAIR_RATE_LIMIT_PER_MIN` (default 20) per client address on the endpoints that cost something. Add a rate rule at the edge too.

### Hosted swaps

Set `UNPAIR_WALLET_SEED_FILE` to turn on the server path. The API then holds a
Zcash transit key, takes hop one into its own shielded wallet and pays hop two
later. That makes you a custodian between the hops. Before turning it on:

- Make a fresh 24-word phrase for this and nothing else. Keep a copy offline.
  Everything the wallet ever held is under that phrase.
- Give the service a writable `UNPAIR_WALLET_DIR` (the unit allows
  `/var/lib/unpair`) and raise `MemoryMax` in the unit to 768M; proving needs it.
- Set `UNPAIR_OPERATOR_TOKEN` to a long random string. `GET /v1/hosted/report`
  with `Authorization: Bearer <token>` shows the balance and the swap counts.
- Keep `UNPAIR_HOSTED_MAX_ZAT` and `UNPAIR_HOSTED_MAX_OPEN` low. They bound what
  a compromise of the box can lose.
- Have counsel look at money-transmission rules where you operate, and at the
  EU rule that bars crypto-asset service providers from privacy-coin accounts
  from 10 July 2027, before the URL is public.

## 3. The gRPC-web proxy, for the one-time wallet

The one-time wallet runs a Zcash wallet inside the page. Browsers
cannot speak gRPC, so the page reaches lightwalletd through a gRPC-web proxy.
Any gRPC-web capable proxy works; Envoy's `grpc_web` filter is the common
one. `apps/api/deploy/envoy-lwd.yaml` is a working Envoy configuration:
replace `LWD_HOST` with a lightwalletd you trust and `PAGE_ORIGIN` with the
page's origin, run it, put TLS in front, and set `VITE_LWD_GRPC_WEB_URL` to
the proxy's URL when you build the page. The Caddyfile in the same folder has
a host for it with the access log off.

The proxy sees the visitor's IP and the block ranges the wallet asks for. It
never sees a key or a note. Keep its access log off, or short.

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
