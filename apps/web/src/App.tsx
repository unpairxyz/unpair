import { useEffect, useMemo, useRef, useState } from "react";
import {
  OneClickClient,
  OneClickError,
  blocksToMs,
  clearnetTransport,
  formatUnits,
  sampleReleaseDelayBlocks,
  type QuoteInput,
  type QuoteResponse,
  type RouteId,
  type StatusResponse,
  type TokenInfo,
} from "@unpair/sdk";
import {
  ApiClient,
  ApiError,
  DEFAULT_ADVANCED,
  DEFAULT_ROUTE,
  MODE_COPY,
  ROUTES,
  SEND_OUT_COPY,
  SLIPPAGE_CHOICES_BPS,
  STATE_COPY,
  TOR_HINT,
  WAIT_COPY,
  WALLET_COPY,
  chainName,
  checkZcashAddress,
  depositDeadline,
  describeCheck,
  describePlan,
  groupByChain,
  planAmount,
  routeInfo,
  stateOf,
  verifySignedQuote,
  type AddressCheck,
  type AdvancedOptions,
  type Landing,
  type Mode,
  type WalletChoice,
} from "@unpair/client";
import { loadConfig } from "./config";

const config = loadConfig();
const client = new OneClickClient({
  ...(config.apiKey ? { apiKey: config.apiKey } : {}),
  fee: config.fee,
  transport: clearnetTransport(),
});
const api = config.apiUrl ? new ApiClient(config.apiUrl) : null;
if (api && !config.apiPubkey) {
  console.warn("VITE_API_URL is set without VITE_API_PUBKEY; signed quotes cannot be verified and will be refused.");
}

type Direction = "in" | "out";

/** Everything the user chose. All of it stays on this device. */
interface Options {
  mode: Mode;
  route: RouteId;
  wallet: WalletChoice;
  advanced: AdvancedOptions;
}

type Step =
  | { kind: "form" }
  | { kind: "quoted"; quote: QuoteResponse; token: TokenInfo; verified: boolean | null; landing?: Landing }
  | { kind: "tracking"; quote: QuoteResponse; token: TokenInfo; landing?: Landing };

export function App() {
  const [direction, setDirection] = useState<Direction>("in");
  const [options, setOptions] = useState<Options>({ mode: "fast", route: DEFAULT_ROUTE, wallet: "own", advanced: DEFAULT_ADVANCED });
  const [tokens, setTokens] = useState<TokenInfo[] | null>(null);
  const [tokensError, setTokensError] = useState<string | null>(null);

  useEffect(() => {
    client
      .getTokens()
      .then((t) => setTokens(t))
      .catch((e: unknown) => setTokensError(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <main>
      <header>
        <h1>Unpair</h1>
        <p>Land any asset in Zcash's shielded pool.</p>
      </header>

      {window.location.origin !== config.officialOrigin && (
        <div className="notice">
          You are not on {config.officialOrigin}. Self-hosted copies are fine. Copies that ask for keys or passwords are not Unpair.
        </div>
      )}

      <div className="tabs" role="tablist" aria-label="Direction">
        <button type="button" role="tab" className="tab" aria-selected={direction === "in"} onClick={() => setDirection("in")}>Swap in</button>
        <button type="button" role="tab" className="tab" aria-selected={direction === "out"} onClick={() => setDirection("out")}>Send out</button>
      </div>

      {tokensError && <p className="hint bad">Could not load the asset list: {tokensError}</p>}

      {direction === "in" ? (
        <SwapIn tokens={tokens} options={options} onOptions={setOptions} />
      ) : (
        <SendOut tokens={tokens} options={options} onOptions={setOptions} />
      )}

      <footer>
        Open source, MIT. Unpair holds no funds and no keys. {api ? "Addresses are screened and quotes are signed by the Unpair API." : "Quotes are requested from your browser."} Each route operator sees its own leg.{" "}
        <a href="https://github.com/unpairxyz/unpair" rel="noreferrer">Source and threat model</a>.
      </footer>
    </main>
  );
}

function ModePicker({ options, onOptions }: { options: Options; onOptions: (o: Options) => void }) {
  return (
    <div className="modes" role="group" aria-label="Mode">
      {(["fast", "quiet"] as Mode[]).map((m) => (
        <button key={m} type="button" className="mode" aria-pressed={options.mode === m} onClick={() => onOptions({ ...options, mode: m })}>
          <strong>{MODE_COPY[m].title}</strong>
          <span>{MODE_COPY[m].text}</span>
        </button>
      ))}
    </div>
  );
}

function RoutePicker({ options, onOptions }: { options: Options; onOptions: (o: Options) => void }) {
  return (
    <fieldset className="choices">
      <legend>Route</legend>
      {ROUTES.map((r) => (
        <label key={r.id} className={`choice ${r.available ? "" : "off"}`}>
          <input type="radio" name="route" value={r.id} checked={options.route === r.id} disabled={!r.available} onChange={() => onOptions({ ...options, route: r.id })} />
          <span>
            <strong>{r.name}</strong>{" "}
            <em>{r.payout === "shielded" ? "pays shielded" : "pays transparent"}</em>
            <small>{r.available ? `You trust ${r.trusted}. ${r.note}` : r.note}</small>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

function WalletPicker({ options, onOptions }: { options: Options; onOptions: (o: Options) => void }) {
  return (
    <fieldset className="choices">
      <legend>Where the ZEC lands</legend>
      {(["own", "unpair_app"] as WalletChoice[]).map((w) => (
        <label key={w} className="choice">
          <input type="radio" name="wallet" value={w} checked={options.wallet === w} onChange={() => onOptions({ ...options, wallet: w })} />
          <span>
            <strong>{WALLET_COPY[w].title}</strong>
            <small>{WALLET_COPY[w].text}</small>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

function AdvancedPanel({ options, onOptions }: { options: Options; onOptions: (o: Options) => void }) {
  const a = options.advanced;
  const set = (patch: Partial<AdvancedOptions>) => onOptions({ ...options, advanced: { ...a, ...patch } });
  return (
    <details className="advanced">
      <summary>More privacy options</summary>
      {options.mode === "quiet" && (
        <label className="check">
          <input type="checkbox" checked={a.round} onChange={(e) => set({ round: e.target.checked })} />
          <span>Round the amount to a common size, so the payout looks like everyone else's.</span>
        </label>
      )}
      <label htmlFor="slippage">Slippage the route may take</label>
      <select id="slippage" value={a.slippageBps} onChange={(e) => set({ slippageBps: Number(e.target.value) })}>
        {SLIPPAGE_CHOICES_BPS.map((b) => (
          <option key={b} value={b}>{b / 100}%</option>
        ))}
      </select>
      {options.mode === "quiet" && (
        <>
          <label htmlFor="wait">Timing of the second hop</label>
          <select id="wait" value={a.wait} onChange={(e) => set({ wait: e.target.value as AdvancedOptions["wait"] })}>
            <option value="suggested">Suggested random wait</option>
            <option value="own">I choose when</option>
          </select>
          <p className="hint">{WAIT_COPY[a.wait]}</p>
        </>
      )}
      <p className="hint">{TOR_HINT}</p>
    </details>
  );
}

interface FlowProps {
  tokens: TokenInfo[] | null;
  options: Options;
  onOptions: (o: Options) => void;
}

async function screenAndQuote(request: QuoteInput): Promise<{ quote: QuoteResponse; verified: boolean | null } | { refused: string }> {
  if (!api) return { quote: await client.quote(request), verified: null };
  for (const [address, chain] of [
    [request.refundTo, chainOf(request.originAsset)],
    [request.recipient, chainOf(request.destinationAsset)],
  ] as const) {
    const v = await api.screen(address, chain);
    if (!v.allowed) return { refused: v.reason ?? "This address cannot be used with Unpair." };
  }
  const signed = await api.quote({ ...request, dry: false, deadline: request.deadline instanceof Date ? request.deadline.toISOString() : (request.deadline ?? new Date(Date.now() + 15 * 60_000).toISOString()) });
  const verified = config.apiPubkey ? await verifySignedQuote(signed, config.apiPubkey) : null;
  if (verified === false) return { refused: "This quote did not come from the Unpair API key this page trusts. Do not send funds. You may be on a copied site." };
  return { quote: signed.quote, verified };
}

/** `nep141:zec.omft.near` is zec; `nep141:base-0x...omft.near` is base; `nep141:eth.omft.near` is eth. */
function chainOf(assetId: string): string {
  const m = /^nep141:(?:([a-z0-9]+)-|([a-z0-9]+)\.omft\.near$)/.exec(assetId);
  return m?.[1] ?? m?.[2] ?? "near";
}

function SwapIn({ tokens, options, onOptions }: FlowProps) {
  const [chain, setChain] = useState<string>("eth");
  const [assetId, setAssetId] = useState<string>("");
  const [amount, setAmount] = useState<string>("");
  const [refundTo, setRefundTo] = useState<string>("");
  const [destination, setDestination] = useState<string>("");
  const [destCheck, setDestCheck] = useState<AddressCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [step, setStep] = useState<Step>({ kind: "form" });

  const byChain = useMemo(() => (tokens ? groupByChain(tokens) : new Map<string, TokenInfo[]>()), [tokens]);
  const chainTokens = byChain.get(chain) ?? [];
  const token = chainTokens.find((t) => t.assetId === assetId) ?? chainTokens[0] ?? null;
  const zec = tokens?.find((t) => t.blockchain === "zec" && t.symbol === "ZEC") ?? null;

  useEffect(() => {
    if (token && token.assetId !== assetId) setAssetId(token.assetId);
  }, [token, assetId]);

  useEffect(() => {
    let alive = true;
    if (destination.trim() === "") {
      setDestCheck(null);
      return;
    }
    checkZcashAddress(destination).then((c) => {
      if (alive) setDestCheck(c);
    });
    return () => {
      alive = false;
    };
  }, [destination]);

  const planned = token && amount ? planAmount(amount, token, options.mode, options.advanced.round) : null;
  const planError = planned && "error" in planned ? planned.error : null;
  const plan = planned && !("error" in planned) ? planned : null;
  const feePreview = token && zec ? client.previewFee(token, zec, "EXACT_INPUT") : null;
  const destVerdict = destCheck ? describeCheck(destCheck) : null;
  const destOk = destVerdict?.ok ?? false;
  const landing = destVerdict?.landing;
  const ownWallet = options.wallet === "own";
  const canQuote = Boolean(token && zec && plan && !planError && ownWallet && destOk && refundTo.trim() !== "" && !busy);

  async function getQuote() {
    if (!token || !zec || !plan) return;
    setBusy(true);
    setFormError(null);
    try {
      const request: QuoteInput = {
        swapType: "EXACT_INPUT",
        slippageTolerance: options.advanced.slippageBps,
        originAsset: token.assetId,
        depositType: "ORIGIN_CHAIN",
        destinationAsset: zec.assetId,
        amount: plan.send.toString(),
        refundTo: refundTo.trim(),
        refundType: "ORIGIN_CHAIN",
        recipient: destination.trim(),
        recipientType: "DESTINATION_CHAIN",
        deadline: new Date(Date.now() + 15 * 60_000),
      };
      const r = await screenAndQuote(request);
      if ("refused" in r) setFormError(r.refused);
      else setStep({ kind: "quoted", quote: r.quote, token, verified: r.verified, ...(landing ? { landing } : {}) });
    } catch (e) {
      setFormError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setStep({ kind: "form" });
    setFormError(null);
  }

  if (step.kind === "quoted") {
    const q = step.quote.quote;
    return (
      <QuoteView
        quote={step.quote}
        verified={step.verified}
        rows={[
          ["You send", `${q.amountInFormatted} ${step.token.symbol} on ${chainName(step.token.blockchain)}`],
          ["You receive", `about ${q.amountOutFormatted} ZEC, at least ${formatUnits(BigInt(q.minAmountOut), 8)} ZEC`],
          ["Lands", step.landing === "shielded" ? "straight in the shielded pool" : "at your transparent address, then your wallet shields it"],
          ["Route", routeInfo(options.route).name],
          ["Time", `about ${Math.max(1, Math.round(q.timeEstimate / 60))} min${options.mode === "quiet" ? ", then your wait before the second hop" : ""}`],
        ]}
        onBack={reset}
        onAccept={() => setStep({ kind: "tracking", quote: step.quote, token: step.token, ...(step.landing ? { landing: step.landing } : {}) })}
      />
    );
  }
  if (step.kind === "tracking") {
    return <TrackingView quote={step.quote} token={step.token} direction="in" options={options} landing={step.landing ?? "transparent"} onDone={reset} />;
  }

  return (
    <section className="card">
      <ModePicker options={options} onOptions={onOptions} />

      <div className="row">
        <div>
          <label htmlFor="chain">From chain</label>
          <select id="chain" value={chain} onChange={(e) => setChain(e.target.value)} disabled={!tokens}>
            {[...byChain.keys()].map((c) => (
              <option key={c} value={c}>{chainName(c)}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="asset">Asset</label>
          <select id="asset" value={token?.assetId ?? ""} onChange={(e) => setAssetId(e.target.value)} disabled={!token}>
            {chainTokens.map((t) => (
              <option key={t.assetId} value={t.assetId}>{t.symbol}</option>
            ))}
          </select>
        </div>
      </div>

      <label htmlFor="amount">Amount{token ? ` of ${token.symbol}` : ""}</label>
      <input id="amount" inputMode="decimal" placeholder="0.0" value={amount} onChange={(e) => setAmount(e.target.value)} autoComplete="off" />
      {planError && <p className="hint bad">{planError}</p>}
      {plan && !planError && token && <p className="hint">{describePlan(plan, token, options.mode)}</p>}

      <label htmlFor="refund">Refund address on {chainName(chain)}</label>
      <input id="refund" placeholder="Where a failed swap is returned" value={refundTo} onChange={(e) => setRefundTo(e.target.value)} autoComplete="off" spellCheck={false} />
      <p className="hint">Use an address you control on the source chain. Never a shielded address.</p>

      <WalletPicker options={options} onOptions={onOptions} />
      {ownWallet ? (
        <>
          <label htmlFor="dest">Your Zcash address</label>
          <input id="dest" placeholder="u1... or t1..." value={destination} onChange={(e) => setDestination(e.target.value)} autoComplete="off" spellCheck={false} className="mono" />
          {destVerdict && <p className={`hint ${destOk ? (landing === "shielded" ? "ok" : "") : "bad"}`}>{destVerdict.text}</p>}
          {!destCheck && <p className="hint">Best: a fresh shielded-only unified address, paid straight into the pool. Also fine: a fresh transparent address that your wallet shields. Use each address once.</p>}
        </>
      ) : (
        <p className="hint warn">Open the Unpair app and use its Swap in tab. It makes the landing address and shields it for you. <a href="https://github.com/unpairxyz/unpair/tree/main/apps/desktop" rel="noreferrer">Get the app</a>.</p>
      )}

      <RoutePicker options={options} onOptions={onOptions} />
      <AdvancedPanel options={options} onOptions={onOptions} />

      {feePreview && <p className="hint">{feePreview.text}</p>}
      {formError && <p className="hint bad">{formError}</p>}

      <button type="button" className="primary" disabled={!canQuote} onClick={getQuote}>
        {busy ? "Getting quote" : plan && !planError && token ? `Unpair ${formatUnits(plan.send, token.decimals)} ${token.symbol}` : "Get quote"}
      </button>
    </section>
  );
}

/** Hop two from your own wallet. ZEC leaves the shielded pool and arrives as another asset. */
function SendOut({ tokens, options, onOptions }: FlowProps) {
  const [chain, setChain] = useState<string>("base");
  const [assetId, setAssetId] = useState<string>("");
  const [amount, setAmount] = useState<string>("");
  const [refundTo, setRefundTo] = useState<string>("");
  const [refundCheck, setRefundCheck] = useState<AddressCheck | null>(null);
  const [destination, setDestination] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [step, setStep] = useState<Step>({ kind: "form" });

  const byChain = useMemo(() => (tokens ? groupByChain(tokens) : new Map<string, TokenInfo[]>()), [tokens]);
  const chainTokens = byChain.get(chain) ?? [];
  const token = chainTokens.find((t) => t.assetId === assetId) ?? chainTokens[0] ?? null;
  const zec = tokens?.find((t) => t.blockchain === "zec" && t.symbol === "ZEC") ?? null;

  useEffect(() => {
    if (token && token.assetId !== assetId) setAssetId(token.assetId);
  }, [token, assetId]);
  useEffect(() => {
    let alive = true;
    if (refundTo.trim() === "") {
      setRefundCheck(null);
      return;
    }
    checkZcashAddress(refundTo).then((c) => {
      if (alive) setRefundCheck(c);
    });
    return () => {
      alive = false;
    };
  }, [refundTo]);

  const planned = zec && amount ? planAmount(amount, zec, options.mode, options.advanced.round) : null;
  const planError = planned && "error" in planned ? planned.error : null;
  const plan = planned && !("error" in planned) ? planned : null;
  const feePreview = token && zec ? client.previewFee(zec, token, "EXACT_INPUT") : null;
  const refundOk = refundCheck ? describeCheck(refundCheck).ok : false;
  const canQuote = Boolean(token && zec && plan && !planError && refundOk && destination.trim() !== "" && !busy);

  async function getQuote() {
    if (!token || !zec || !plan) return;
    setBusy(true);
    setFormError(null);
    try {
      const request: QuoteInput = {
        swapType: "EXACT_INPUT",
        slippageTolerance: options.advanced.slippageBps,
        originAsset: zec.assetId,
        depositType: "ORIGIN_CHAIN",
        destinationAsset: token.assetId,
        amount: plan.send.toString(),
        refundTo: refundTo.trim(),
        refundType: "ORIGIN_CHAIN",
        recipient: destination.trim(),
        recipientType: "DESTINATION_CHAIN",
        deadline: new Date(Date.now() + 30 * 60_000),
      };
      const r = await screenAndQuote(request);
      if ("refused" in r) setFormError(r.refused);
      else setStep({ kind: "quoted", quote: r.quote, token, verified: r.verified });
    } catch (e) {
      setFormError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setStep({ kind: "form" });
    setFormError(null);
  }

  if (step.kind === "quoted") {
    const q = step.quote.quote;
    return (
      <QuoteView
        quote={step.quote}
        verified={step.verified}
        copy={SEND_OUT_COPY.quote ?? STATE_COPY.quote}
        rows={[
          ["You pay", `${q.amountInFormatted} ZEC from your shielded wallet, plus your wallet's network fee`],
          ["You receive", `about ${q.amountOutFormatted} ${step.token.symbol} on ${chainName(step.token.blockchain)}, at least ${formatUnits(BigInt(q.minAmountOut), step.token.decimals)}`],
          ["Route", routeInfo(options.route).name],
          ["Time", `about ${Math.max(1, Math.round(q.timeEstimate / 60))} min after your payment confirms`],
        ]}
        note="On chain this shows one transparent output to the route and the amount. Do not send the same amount you received, and leave time between the two hops."
        acceptLabel="Show the route's address"
        onBack={reset}
        onAccept={() => setStep({ kind: "tracking", quote: step.quote, token: step.token })}
      />
    );
  }
  if (step.kind === "tracking") {
    return <TrackingView quote={step.quote} token={step.token} direction="out" options={options} landing="transparent" onDone={reset} />;
  }

  return (
    <section className="card">
      <p className="hint">Send ZEC from your own shielded wallet and receive another asset at an address of your choice. The two ends have no link on chain. Use this as the second hop of quiet mode, or on its own.</p>
      <ModePicker options={options} onOptions={onOptions} />
      <div className="row">
        <div>
          <label htmlFor="out-chain">To chain</label>
          <select id="out-chain" value={chain} onChange={(e) => setChain(e.target.value)} disabled={!tokens}>
            {[...byChain.keys()].map((c) => (
              <option key={c} value={c}>{chainName(c)}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="out-asset">Asset</label>
          <select id="out-asset" value={token?.assetId ?? ""} onChange={(e) => setAssetId(e.target.value)} disabled={!token}>
            {chainTokens.map((t) => (
              <option key={t.assetId} value={t.assetId}>{t.symbol}</option>
            ))}
          </select>
        </div>
      </div>
      <label htmlFor="out-amount">Amount of ZEC</label>
      <input id="out-amount" inputMode="decimal" placeholder="0.0" value={amount} onChange={(e) => setAmount(e.target.value)} autoComplete="off" />
      {planError && <p className="hint bad">{planError}</p>}
      {plan && !planError && zec && <p className="hint">{describePlan(plan, zec, options.mode)}</p>}
      <label htmlFor="out-dest">Destination address on {chainName(chain)}</label>
      <input id="out-dest" placeholder="Where the asset arrives" value={destination} onChange={(e) => setDestination(e.target.value)} autoComplete="off" spellCheck={false} className="mono" />
      <label htmlFor="out-refund">Refund address, a fresh transparent address of your Zcash wallet</label>
      <input id="out-refund" placeholder="t1..." value={refundTo} onChange={(e) => setRefundTo(e.target.value)} autoComplete="off" spellCheck={false} className="mono" />
      {refundCheck && <p className={`hint ${refundOk ? "ok" : "bad"}`}>{describeCheck(refundCheck).text}</p>}
      {!refundCheck && <p className="hint">If the route fails, the ZEC comes back here and your wallet shields it again.</p>}

      <RoutePicker options={options} onOptions={onOptions} />
      <AdvancedPanel options={options} onOptions={onOptions} />

      {feePreview && <p className="hint">{feePreview.text}</p>}
      {formError && <p className="hint bad">{formError}</p>}
      <button type="button" className="primary" disabled={!canQuote} onClick={getQuote}>{busy ? "Getting quote" : "Get quote"}</button>
    </section>
  );
}

function describeError(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof OneClickError) {
    const body = e.body as { message?: string } | null;
    const msg = body && typeof body.message === "string" ? body.message : e.message;
    if (/refundTo/i.test(msg)) return "The route did not accept the refund address. Check it and try again.";
    if (/recipient/i.test(msg)) return "The route did not accept the destination address. Check it and try again.";
    if (/amount/i.test(msg)) return "The route did not accept this amount. Try a larger or smaller one.";
    return `The route could not quote this swap: ${msg}`;
  }
  return e instanceof Error ? e.message : String(e);
}

function QuoteView({ quote, verified, rows, copy = STATE_COPY.quote, note, acceptLabel = "Show deposit address", onBack, onAccept }: {
  quote: QuoteResponse;
  verified: boolean | null;
  rows: [string, string][];
  copy?: { label: string; text: string };
  note?: string;
  acceptLabel?: string;
  onBack: () => void;
  onAccept: () => void;
}) {
  const fee = client.feeFromQuoteResponse(quote);
  const deadline = depositDeadline(quote);
  return (
    <section className="card">
      <span className="state">{copy.label}</span>
      <p>{copy.text}</p>
      <dl>
        {rows.map(([k, v]) => (
          <DlRow key={k} k={k} v={v} />
        ))}
        <dt>Fee</dt>
        <dd>{fee.text}</dd>
        {deadline && (
          <>
            <dt>Pay by</dt>
            <dd>{deadline.toLocaleTimeString()}</dd>
          </>
        )}
      </dl>
      {verified === true && <p className="hint ok">Signed by the Unpair API. Addresses were screened.</p>}
      {verified === null && api && <p className="hint warn">This page has no pinned API key, so the quote could not be verified.</p>}
      {note && <p className="hint">{note}</p>}
      <p className="hint">The quote is also signed by the route. Keep this page open until the swap completes.</p>
      <button type="button" className="primary" onClick={onAccept}>{acceptLabel}</button>
      <p className="hint"><button type="button" className="link" onClick={onBack}>Back</button></p>
    </section>
  );
}

function DlRow({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </>
  );
}

function TrackingView({ quote, token, direction, options, landing, onDone }: { quote: QuoteResponse; token: TokenInfo; direction: Direction; options: Options; landing: Landing; onDone: () => void }) {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  const q = quote.quote;
  const depositAddress = q.depositAddress ?? "";
  const state = stateOf(status);
  const final = state === "landed" || state === "refunded" || state === "failed";
  const suggestedWait = useMemo(() => blocksToMs(sampleReleaseDelayBlocks()), []);

  useEffect(() => {
    if (!depositAddress || final) return;
    let alive = true;
    const tick = async () => {
      try {
        const s = api ? await api.status(depositAddress, q.depositMemo) : await client.status(depositAddress, q.depositMemo);
        if (alive) {
          setStatus(s);
          setError(null);
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
      if (alive) timer.current = window.setTimeout(tick, 7_000);
    };
    void tick();
    return () => {
      alive = false;
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [depositAddress, q.depositMemo, final]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(depositAddress);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked; the address is selectable */
    }
  }

  const base = (direction === "out" ? SEND_OUT_COPY[state] : undefined) ?? STATE_COPY[state];
  const copy_ = state === "landed" && direction === "in" && landing === "shielded" ? { label: "Shielded", text: "ZEC arrived in the shielded pool at your address. Nothing more to do on the Zcash side." } : base;
  const sendUnit = direction === "out" ? "ZEC from your shielded wallet" : `${token.symbol} on ${chainName(token.blockchain)}`;
  return (
    <section className="card">
      <span className={`state ${state}`}>{copy_.label}</span>
      <p>{copy_.text}</p>
      {!final && (
        <>
          <label>Send exactly</label>
          <p className="mono">{q.amountInFormatted} {sendUnit}</p>
          <label>{direction === "out" ? "To the route's Zcash address" : "To this deposit address"}</label>
          <div className="address">
            <code className="mono">{depositAddress || "No deposit address in this quote."}</code>
            {depositAddress && <button type="button" className="link" onClick={copy}>{copied ? "Copied" : "Copy"}</button>}
          </div>
          {q.depositMemo && (
            <>
              <label>With this memo</label>
              <p className="mono">{q.depositMemo}</p>
            </>
          )}
          {direction === "in" ? (
            <p className="hint warn">Send from any wallet you control. Do not send from an exchange that needs a memo you cannot set.</p>
          ) : (
            <p className="hint warn">Send from your shielded balance, not from a transparent one, or the hop is linkable.</p>
          )}
        </>
      )}
      {status?.swapDetails.destinationChainTxHashes.map((tx) => (
        <p key={tx.hash} className="hint">Transaction <a className="mono" href={tx.explorerUrl} rel="noreferrer">{tx.hash.slice(0, 12)}...</a></p>
      ))}
      {state === "landed" && direction === "in" && options.mode === "quiet" && (
        <p className="hint ok">
          {options.advanced.wait === "suggested"
            ? `Suggested wait before you send out: about ${Math.max(1, Math.round(suggestedWait / 3_600_000))} hours. Then use Send out.`
            : "Wait a while you choose, then use Send out."}
        </p>
      )}
      {status?.swapDetails.refundReason && <p className="hint bad">Reason: {status.swapDetails.refundReason}</p>}
      {error && <p className="hint warn">Status check failed, retrying: {error}</p>}
      {final && <button type="button" className="primary" onClick={onDone}>Start another</button>}
    </section>
  );
}
