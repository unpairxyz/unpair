import { useEffect, useMemo, useRef, useState } from "react";
import {
  OneClickClient,
  OneClickError,
  clearnetTransport,
  formatUnits,
  type QuoteResponse,
  type StatusResponse,
  type TokenInfo,
} from "@unpair/sdk";
import { loadConfig } from "./config";
import { ApiClient, ApiError, verifySignedQuote } from "./lib/api";
import { checkZcashAddress, describeCheck, type AddressCheck } from "./lib/zcashAddress";
import {
  MODE_COPY,
  STATE_COPY,
  chainName,
  depositDeadline,
  describePlan,
  groupByChain,
  planAmount,
  stateOf,
  type Mode,
} from "./lib/swap";

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

type Step =
  | { kind: "form" }
  | { kind: "quoted"; quote: QuoteResponse; send: bigint; token: TokenInfo; verified: boolean | null }
  | { kind: "tracking"; quote: QuoteResponse; token: TokenInfo; status: StatusResponse | null; error: string | null };

export function App() {
  const [mode, setMode] = useState<Mode>("fast");
  const [tokens, setTokens] = useState<TokenInfo[] | null>(null);
  const [tokensError, setTokensError] = useState<string | null>(null);
  const [chain, setChain] = useState<string>("eth");
  const [assetId, setAssetId] = useState<string>("");
  const [amount, setAmount] = useState<string>("");
  const [refundTo, setRefundTo] = useState<string>("");
  const [destination, setDestination] = useState<string>("");
  const [destCheck, setDestCheck] = useState<AddressCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [step, setStep] = useState<Step>({ kind: "form" });

  useEffect(() => {
    client
      .getTokens()
      .then((t) => setTokens(t))
      .catch((e: unknown) => setTokensError(e instanceof Error ? e.message : String(e)));
  }, []);

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

  const planned = token && amount ? planAmount(amount, token, mode) : null;
  const planError = planned && "error" in planned ? planned.error : null;
  const plan = planned && !("error" in planned) ? planned : null;
  const feePreview = token && zec ? client.previewFee(token, zec, "EXACT_INPUT") : null;
  const destOk = destCheck ? describeCheck(destCheck).ok : false;
  const canQuote = Boolean(token && zec && plan && !planError && destOk && refundTo.trim() !== "" && !busy);

  async function getQuote() {
    if (!token || !zec || !plan) return;
    setBusy(true);
    setFormError(null);
    const request = {
      swapType: "EXACT_INPUT" as const,
      slippageTolerance: 100,
      originAsset: token.assetId,
      depositType: "ORIGIN_CHAIN" as const,
      destinationAsset: zec.assetId,
      amount: plan.send.toString(),
      refundTo: refundTo.trim(),
      refundType: "ORIGIN_CHAIN" as const,
      recipient: destination.trim(),
      recipientType: "DESTINATION_CHAIN" as const,
      deadline: new Date(Date.now() + 15 * 60_000),
    };
    try {
      if (api) {
        // Screening first. A refused address never reaches the route.
        for (const [address, chain] of [
          [request.refundTo, token.blockchain],
          [request.recipient, "zec"],
        ] as const) {
          const v = await api.screen(address, chain);
          if (!v.allowed) {
            setFormError(v.reason ?? "This address cannot be used with Unpair.");
            return;
          }
        }
        const signed = await api.quote({ ...request, dry: false, deadline: request.deadline.toISOString() });
        const verified = config.apiPubkey ? await verifySignedQuote(signed, config.apiPubkey) : null;
        if (verified === false) {
          setFormError("This quote did not come from the Unpair API key this page trusts. Do not send funds. You may be on a copied site.");
          return;
        }
        setStep({ kind: "quoted", quote: signed.quote, send: plan.send, token, verified });
      } else {
        const quote = await client.quote(request);
        setStep({ kind: "quoted", quote, send: plan.send, token, verified: null });
      }
    } catch (e) {
      if (e instanceof ApiError) setFormError(e.message);
      else setFormError(e instanceof OneClickError ? describeOneClickError(e) : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setStep({ kind: "form" });
    setFormError(null);
  }

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

      {step.kind === "form" && (
        <section className="card">
          <div className="modes" role="group" aria-label="Mode">
            {(["fast", "quiet"] as Mode[]).map((m) => (
              <button key={m} type="button" className="mode" aria-pressed={mode === m} onClick={() => setMode(m)}>
                <strong>{MODE_COPY[m].title}</strong>
                <span>{MODE_COPY[m].text}</span>
              </button>
            ))}
          </div>

          {tokensError && <p className="hint bad">Could not load the asset list: {tokensError}</p>}

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
          {plan && !planError && token && <p className="hint">{describePlan(plan, token, mode)}</p>}

          <label htmlFor="refund">Refund address on {chainName(chain)}</label>
          <input id="refund" placeholder="Where a failed swap is returned" value={refundTo} onChange={(e) => setRefundTo(e.target.value)} autoComplete="off" spellCheck={false} />
          <p className="hint">Use an address you control on the source chain. Never a shielded address.</p>

          <label htmlFor="dest">Zcash address</label>
          <input id="dest" placeholder="t1..." value={destination} onChange={(e) => setDestination(e.target.value)} autoComplete="off" spellCheck={false} className="mono" />
          {destCheck && <p className={`hint ${destOk ? "ok" : "bad"}`}>{describeCheck(destCheck).text}</p>}
          {!destCheck && <p className="hint">A fresh transparent address from a wallet that shields automatically, such as Zodl or the Unpair self-host wallet. Use it once.</p>}

          {feePreview && <p className="hint">{feePreview.text}</p>}
          {formError && <p className="hint bad">{formError}</p>}

          <button type="button" className="primary" disabled={!canQuote} onClick={getQuote}>
            {busy ? "Getting quote" : plan && !planError && token ? `Unpair ${formatUnits(plan.send, token.decimals)} ${token.symbol}` : "Get quote"}
          </button>
        </section>
      )}

      {step.kind === "quoted" && <QuoteView step={step} mode={mode} onBack={reset} onAccept={() => setStep({ kind: "tracking", quote: step.quote, token: step.token, status: null, error: null })} />}

      {step.kind === "tracking" && <TrackingView step={step} onDone={reset} />}

      <footer>
        Open source, MIT. Unpair holds no funds. {api ? "Addresses are screened and quotes are signed by the Unpair API." : "Quotes are requested from your browser."} Each route operator sees its own leg.{" "}
        <a href="https://github.com/unpairxyz/unpair" rel="noreferrer">Source and threat model</a>.
      </footer>
    </main>
  );
}

function describeOneClickError(e: OneClickError): string {
  const body = e.body as { message?: string } | null;
  const msg = body && typeof body.message === "string" ? body.message : e.message;
  if (/refundTo/i.test(msg)) return "The route did not accept the refund address. Check it and try again.";
  if (/recipient/i.test(msg)) return "The route did not accept the Zcash address. Check it and try again.";
  if (/amount/i.test(msg)) return "The route did not accept this amount. Try a larger or smaller one.";
  return `The route could not quote this swap: ${msg}`;
}

function QuoteView({ step, mode, onBack, onAccept }: { step: Extract<Step, { kind: "quoted" }>; mode: Mode; onBack: () => void; onAccept: () => void }) {
  const q = step.quote.quote;
  const fee = client.feeFromQuoteResponse(step.quote);
  const deadline = depositDeadline(step.quote);
  return (
    <section className="card">
      <span className="state">{STATE_COPY.quote.label}</span>
      <p>{STATE_COPY.quote.text}</p>
      <dl>
        <dt>You send</dt>
        <dd>{q.amountInFormatted} {step.token.symbol} on {chainName(step.token.blockchain)}</dd>
        <dt>You receive</dt>
        <dd>about {q.amountOutFormatted} ZEC, at least {formatUnits(BigInt(q.minAmountOut), 8)} ZEC</dd>
        <dt>Fee</dt>
        <dd>{fee.text}</dd>
        <dt>Time</dt>
        <dd>about {Math.max(1, Math.round(q.timeEstimate / 60))} min{mode === "quiet" ? ", then your wallet's release delay" : ""}</dd>
        {deadline && (
          <>
            <dt>Deposit by</dt>
            <dd>{deadline.toLocaleTimeString()}</dd>
          </>
        )}
      </dl>
      {step.verified === true && <p className="hint ok">Signed by the Unpair API. Addresses were screened.</p>}
      {step.verified === null && api && <p className="hint warn">This page has no pinned API key, so the quote could not be verified.</p>}
      <p className="hint">The quote is also signed by the route. Keep this page open until the swap lands.</p>
      <button type="button" className="primary" onClick={onAccept}>Show deposit address</button>
      <p className="hint"><button type="button" className="link" onClick={onBack}>Back</button></p>
    </section>
  );
}

function TrackingView({ step, onDone }: { step: Extract<Step, { kind: "tracking" }>; onDone: () => void }) {
  const [status, setStatus] = useState<StatusResponse | null>(step.status);
  const [error, setError] = useState<string | null>(step.error);
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  const q = step.quote.quote;
  const depositAddress = q.depositAddress ?? "";
  const state = stateOf(status);
  const final = state === "landed" || state === "refunded" || state === "failed";

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

  const copy_ = STATE_COPY[state];
  return (
    <section className="card">
      <span className={`state ${state}`}>{copy_.label}</span>
      <p>{copy_.text}</p>
      {!final && (
        <>
          <label>Send exactly</label>
          <p className="mono">{q.amountInFormatted} {step.token.symbol} on {chainName(step.token.blockchain)}</p>
          <label>To this deposit address</label>
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
          <p className="hint warn">Send from any wallet you control. Do not send from an exchange that needs a memo you cannot set.</p>
        </>
      )}
      {status?.swapDetails.destinationChainTxHashes.map((tx) => (
        <p key={tx.hash} className="hint">Zcash transaction <a className="mono" href={tx.explorerUrl} rel="noreferrer">{tx.hash.slice(0, 12)}...</a></p>
      ))}
      {status?.swapDetails.refundReason && <p className="hint bad">Reason: {status.swapDetails.refundReason}</p>}
      {error && <p className="hint warn">Status check failed, retrying: {error}</p>}
      {final && <button type="button" className="primary" onClick={onDone}>Start another</button>}
    </section>
  );
}
