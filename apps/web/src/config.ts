import { DEFAULT_FEE_BPS, FEE_CAP_BPS, type FeeConfig } from "@unpair/sdk";

const env = import.meta.env;

function feeBps(): number {
  const raw = env.VITE_FEE_BPS;
  if (raw === undefined || raw === "") return DEFAULT_FEE_BPS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > FEE_CAP_BPS) {
    throw new Error(`VITE_FEE_BPS must be an integer from 0 to ${FEE_CAP_BPS}, got ${raw}`);
  }
  return n;
}

export interface AppConfig {
  apiKey: string | undefined;
  fee: FeeConfig | null;
  officialOrigin: string;
  /** unpair-api base URL. When set, screening and signed quotes go through it. */
  apiUrl: string | undefined;
  /** Pinned Ed25519 public key of that API, hex. Quotes that do not verify are refused. */
  apiPubkey: string | undefined;
  /** gRPC-web proxy in front of lightwalletd. When set, the page can run a Zcash wallet itself. */
  lwdGrpcWebUrl: string | undefined;
  /** Which Zcash network that wallet uses. */
  zcashNetwork: ZcashNetwork;
}

export type ZcashNetwork = "main" | "test";

function zcashNetwork(): ZcashNetwork {
  const raw = ((env.VITE_ZCASH_NETWORK as string | undefined)?.trim() || "main").toLowerCase();
  if (raw === "main" || raw === "test") return raw;
  throw new Error(`VITE_ZCASH_NETWORK must be main or test, got ${raw}`);
}

export function loadConfig(): AppConfig {
  const recipient = (env.VITE_FEE_RECIPIENT as string | undefined)?.trim() || "unpair.near";
  const bps = feeBps();
  return {
    apiKey: (env.VITE_ONECLICK_JWT as string | undefined)?.trim() || undefined,
    fee: bps === 0 ? null : { recipient, feeBps: bps },
    officialOrigin: (env.VITE_OFFICIAL_ORIGIN as string | undefined)?.trim() || "https://unpair.xyz",
    apiUrl: (env.VITE_API_URL as string | undefined)?.trim() || undefined,
    apiPubkey: (env.VITE_API_PUBKEY as string | undefined)?.trim().toLowerCase() || undefined,
    lwdGrpcWebUrl: (env.VITE_LWD_GRPC_WEB_URL as string | undefined)?.trim().replace(/\/+$/, "") || undefined,
    zcashNetwork: zcashNetwork(),
  };
}
