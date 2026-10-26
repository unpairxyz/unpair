// Downloads token and chain icons into public/icons/ so the page loads them from our own origin.
// Run before a build: node scripts/fetch-icons.mjs
// Sources: the 1Click token list (coingeckoId per token) and CoinGecko's public markets API.
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const OUT = fileURLToPath(new URL("../public/icons/", import.meta.url));
const ONECLICK = process.env.ONECLICK_URL || "https://1click.chaindefuser.com";

// Chain code -> CoinGecko id of the chain's own coin. Chains without one get a monogram.
const CHAIN_COIN = {
  eth: "ethereum", arb: "arbitrum", op: "optimism", bsc: "binancecoin", pol: "polygon-ecosystem-token", avax: "avalanche-2",
  gnosis: "gnosis", bera: "berachain-bera", scroll: "scroll", monad: "monad", xlayer: "okb", plasma: "plasma",
  hypercore: "hyperliquid", sol: "solana", btc: "bitcoin", ltc: "litecoin", doge: "dogecoin", bch: "bitcoin-cash",
  dash: "dash", zec: "zcash", tron: "tron", ton: "the-open-network", stellar: "stellar", xrp: "ripple", cardano: "cardano",
  near: "near", sui: "sui", aptos: "aptos", movement: "movement", starknet: "starknet", aleo: "aleo",
};
// Chains with no coin of their own -> CoinGecko asset platform id, whose logo is used instead.
const CHAIN_PLATFORM = { base: "base", abs: "abstract", adi: "adi-chain", fogo: "fogo", hood: "robinhood" };

const tokens = await (await fetch(`${ONECLICK}/v0/tokens`)).json();
const ids = [...new Set([...tokens.map((t) => t.coingeckoId).filter(Boolean), ...Object.values(CHAIN_COIN)])];
const images = new Map();
for (let i = 0; i < ids.length; i += 200) {
  const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&per_page=250&ids=${ids.slice(i, i + 200).join(",")}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
  for (const c of await res.json()) if (c.image) images.set(c.id, c.image.replace("/large/", "/small/"));
}

await mkdir(OUT, { recursive: true });
const save = async (name, src) => {
  const res = await fetch(src);
  if (!res.ok) return false;
  await writeFile(OUT + name, Buffer.from(await res.arrayBuffer()));
  return true;
};
let n = 0;
for (const [id, src] of images) if (await save(`${id}.png`, src)) n++;
for (const [chain, id] of Object.entries(CHAIN_COIN)) if (images.has(id) && (await save(`chain-${chain}.png`, images.get(id)))) n++;
const platforms = await (await fetch("https://api.coingecko.com/api/v3/asset_platforms")).json();
for (const [chain, id] of Object.entries(CHAIN_PLATFORM)) {
  const src = platforms.find((p) => p.id === id)?.image?.small;
  if (src && (await save(`chain-${chain}.png`, src))) n++;
}
console.log(`saved ${n} icons to public/icons/ (${ids.length - images.size} ids without an image)`);
