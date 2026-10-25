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
  apiUrl: string | undefined;
  apiPubkey: string | undefined;
}

export function loadConfig(): AppConfig {
  const recipient = (env.VITE_FEE_RECIPIENT as string | undefined)?.trim() || "unpair.near";
  const bps = feeBps();
  return {
    apiKey: (env.VITE_ONECLICK_JWT as string | undefined)?.trim() || undefined,
    fee: bps === 0 ? null : { recipient, feeBps: bps },
    apiUrl: (env.VITE_API_URL as string | undefined)?.trim() || undefined,
    apiPubkey: (env.VITE_API_PUBKEY as string | undefined)?.trim().toLowerCase() || undefined,
  };
}
