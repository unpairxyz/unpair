import { useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  OneClickClient,
  OneClickError,
  clearnetTransport,
  formatUnits,
  parseUnits,
  type QuoteResponse,
  type StatusResponse,
  type TokenInfo,
} from "@unpair/sdk";
import {
  ApiClient,
  ApiError,
  MODE_COPY,
  STATE_COPY,
  chainName,
  depositDeadline,
  describePlan,
  groupByChain,
  planAmount,
  stateOf,
  verifySignedQuote,
  type Mode,
} from "@unpair/client";
import { loadConfig } from "./config";
import { errorText, wallet, type Landing, type Payout, type WalletReport, type WalletStatus } from "./bridge";

const config = loadConfig();
const client = new OneClickClient({
  ...(config.apiKey ? { apiKey: config.apiKey } : {}),
  fee: config.fee,
  transport: clearnetTransport(),
});
const api = config.apiUrl ? new ApiClient(config.apiUrl) : null;

type Screen = { kind: "loading" } | { kind: "setup" } | { kind: "backup"; phrase: string } | { kind: "home" } | { kind: "error"; text: string };

export function App() {
  const [status, setStatus] = useState<WalletStatus | null>(null);
  const [screen, setScreen] = useState<Screen>({ kind: "loading" });

  useEffect(() => {
    wallet
      .status()
      .then(async (s) => {
        if (!s.has_seed) {
          setStatus(s);
          setScreen({ kind: "setup" });
          return;
        }
        const opened = await wallet.open();
        setStatus(opened);
        setScreen({ kind: "home" });
      })
      .catch((e: unknown) => setScreen({ kind: "error", text: errorText(e) }));
  }, []);

  function refresh() {
    wallet.status().then(setStatus).catch(() => undefined);
  }

  return (
    <main>
      <header>
        <h1>Unpair</h1>
        <p>Land any asset in Zcash's shielded pool.</p>
      </header>

      {screen.kind === "loading" && <section className="card"><p>Opening your wallet.</p></section>}
      {screen.kind === "error" && (
        <section className="card">
          <p className="hint bad">{screen.text}</p>
          <p className="hint">Check the network connection and open the app again. Nothing was lost: the phrase stays in the keychain.</p>
        </section>
      )}
      {screen.kind === "setup" && (
        <SetupView
          onCreated={(phrase) => {
            refresh();
            setScreen({ kind: "backup", phrase });
          }}
          onRestored={(s) => {
            setStatus(s);
            setScreen({ kind: "home" });
          }}
        />
      )}
      {screen.kind === "backup" && (
        <BackupView
          phrase={screen.phrase}
          onDone={(s) => {
            setStatus(s);
            setScreen({ kind: "home" });
          }}
        />
      )}
      {screen.kind === "home" && status && <HomeView status={status} onStatus={setStatus} />}

      <footer>
        Open source, MIT. The key for your ZEC is on this device and nowhere else. Unpair holds no funds.{" "}
        {api ? "Addresses are screened and quotes are signed by the Unpair API." : "Quotes are requested from this app."}{" "}
        <button type="button" className="link" onClick={() => void openUrl("https://github.com/unpairxyz/unpair")}>Source and threat model</button>.
      </footer>
    </main>
  );
}

function SetupView({ onCreated, onRestored }: { onCreated: (phrase: string) => void; onRestored: (s: WalletStatus) => void }) {
  const [mode, setMode] = useState<"pick" | "restore">("pick");
  const [phrase, setPhrase] = useState("");
  const [height, setHeight] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const { phrase } = await wallet.create();
      onCreated(phrase);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function restore() {
    setBusy(true);
    setError(null);
    try {
      const h = height.trim() === "" ? null : Number(height);
      if (h !== null && (!Number.isInteger(h) || h < 0)) throw new Error("Birthday height must be a whole number.");
      onRestored(await wallet.restore(phrase, h));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>Set up this device</h2>
      <p className="hint">Unpair makes a Zcash key on this device and keeps it in the system keychain. The key never leaves the device. Unpair's servers cannot see it or recover it.</p>
      {mode === "pick" && (
        <>
          <button type="button" className="primary" disabled={busy} onClick={create}>{busy ? "Creating" : "Create a new wallet"}</button>
          <p className="hint"><button type="button" className="link" onClick={() => setMode("restore")}>Restore from a recovery phrase</button></p>
        </>
      )}
      {mode === "restore" && (
        <>
          <label htmlFor="phrase">Recovery phrase, 24 words</label>
          <textarea id="phrase" value={phrase} onChange={(e) => setPhrase(e.target.value)} spellCheck={false} autoComplete="off" />
          <label htmlFor="height">Birthday block height, optional</label>
          <input id="height" inputMode="numeric" placeholder="Speeds up the rescan. Leave empty to start from today." value={height} onChange={(e) => setHeight(e.target.value)} />
          <p className="hint warn">Without a height the wallet starts from the current block and will not see older funds.</p>
          <button type="button" className="primary" disabled={busy || phrase.trim().split(/\s+/).length !== 24} onClick={restore}>{busy ? "Restoring" : "Restore"}</button>
          <p className="hint"><button type="button" className="link" onClick={() => setMode("pick")}>Back</button></p>
        </>
      )}
      {error && <p className="hint bad">{error}</p>}
    </section>
  );
}

function BackupView({ phrase, onDone }: { phrase: string; onDone: (s: WalletStatus) => void }) {
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const words = phrase.split(" ");
  return (
    <section className="card">
      <h2>Write down your recovery phrase</h2>
      <p className="hint">A swap into ZEC makes this app your Zcash wallet. These 24 words are the only way to get the ZEC back if this device is lost. Unpair cannot recover them. Write them on paper, in order, and keep the paper somewhere safe.</p>
      <ol className="words">
        {words.map((w, i) => <li key={i}>{w}</li>)}
      </ol>
      <p className="hint warn">Do not store the words in a screenshot, a note app, or a message. Anyone with the words has the funds.</p>
      <label className="check">
        <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
        <span>I wrote all 24 words down, in order, and stored the paper safely.</span>
      </label>
      <button type="button" className="primary" disabled={!checked} onClick={() => wallet.confirmBackup().then(onDone).catch((e: unknown) => setError(errorText(e)))}>Continue</button>
      {error && <p className="hint bad">{error}</p>}
    </section>
  );
}

function HomeView({ status, onStatus }: { status: WalletStatus; onStatus: (s: WalletStatus) => void }) {
  const [tab, setTab] = useState<"swap" | "out" | "wallet">("swap");
  return (
    <>
      <div className="tabs" role="tablist">
        <button type="button" role="tab" className="tab" aria-selected={tab === "swap"} onClick={() => setTab("swap")}>Swap in</button>
        <button type="button" role="tab" className="tab" aria-selected={tab === "out"} onClick={() => setTab("out")}>Send out</button>
        <button type="button" role="tab" className="tab" aria-selected={tab === "wallet"} onClick={() => setTab("wallet")}>Wallet</button>
      </div>
      {!status.backed_up && (
        <div className="notice">
          Your recovery phrase is not backed up yet. Back it up in the Wallet tab before receiving ZEC.
        </div>
      )}
      {status.open_error && <div className="notice">The wallet could not open: {status.open_error}</div>}
      {tab === "swap" && <SwapView status={status} />}
      {tab === "out" && <SendOutView status={status} />}
      {tab === "wallet" && <WalletView status={status} onStatus={onStatus} />}
    </>
  );
}

type Step =
  | { kind: "form" }
  | { kind: "quoted"; quote: QuoteResponse; send: bigint; token: TokenInfo; verified: boolean | null }
  | { kind: "tracking"; quote: QuoteResponse; token: TokenInfo };

function SwapView({ status }: { status: WalletStatus }) {
  const [mode, setMode] = useState<Mode>("fast");
  const [tokens, setTokens] = useState<TokenInfo[] | null>(null);
  const [tokensError, setTokensError] = useState<string | null>(null);
  const [chain, setChain] = useState<string>("eth");
  const [assetId, setAssetId] = useState<string>("");
  const [amount, setAmount] = useState<string>("");
  const [refundTo, setRefundTo] = useState<string>("");
  const [landing, setLanding] = useState<Landing | null>(null);
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

  const planned = token && amount ? planAmount(amount, token, mode) : null;
  const planError = planned && "error" in planned ? planned.error : null;
  const plan = planned && !("error" in planned) ? planned : null;
  const feePreview = token && zec ? client.previewFee(token, zec, "EXACT_INPUT") : null;
  const canQuote = Boolean(token && zec && plan && !planError && status.backed_up && status.running && refundTo.trim() !== "" && !busy);

  async function getQuote() {
    if (!token || !zec || !plan) return;
    setBusy(true);
    setFormError(null);
    try {
      // One fresh landing address per swap, from this device's key.
      const l = await wallet.nextLanding();
      setLanding(l);
      const request = {
        swapType: "EXACT_INPUT" as const,
        slippageTolerance: 100,
        originAsset: token.assetId,
        depositType: "ORIGIN_CHAIN" as const,
        destinationAsset: zec.assetId,
        amount: plan.send.toString(),
        refundTo: refundTo.trim(),
        refundType: "ORIGIN_CHAIN" as const,
        recipient: l.transparent,
        recipientType: "DESTINATION_CHAIN" as const,
        deadline: new Date(Date.now() + 15 * 60_000),
      };
      if (api) {
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
          setFormError("This quote did not come from the Unpair API key this app trusts. Do not send funds.");
          return;
        }
        setStep({ kind: "quoted", quote: signed.quote, send: plan.send, token, verified });
      } else {
        const quote = await client.quote(request);
        setStep({ kind: "quoted", quote, send: plan.send, token, verified: null });
      }
    } catch (e) {
      if (e instanceof ApiError) setFormError(e.message);
      else if (e instanceof OneClickError) setFormError(describeOneClickError(e));
      else setFormError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setStep({ kind: "form" });
    setFormError(null);
  }

  if (step.kind === "quoted") {
    return <QuoteView step={step} mode={mode} landing={landing} onBack={reset} onAccept={() => setStep({ kind: "tracking", quote: step.quote, token: step.token })} />;
  }
  if (step.kind === "tracking") return <TrackingView step={step} onDone={reset} />;

  return (
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

      <label>Zcash address</label>
      <p className="hint">A fresh landing address from this device's key is made for each swap. The app shields it as soon as the route pays.</p>

      {feePreview && <p className="hint">{feePreview.text}</p>}
      {!status.backed_up && <p className="hint warn">Back up the recovery phrase in the Wallet tab first.</p>}
      {formError && <p className="hint bad">{formError}</p>}

      <button type="button" className="primary" disabled={!canQuote} onClick={getQuote}>
        {busy ? "Getting quote" : plan && !planError && token ? `Unpair ${formatUnits(plan.send, token.decimals)} ${token.symbol}` : "Get quote"}
      </button>
    </section>
  );
}

type OutStep =
  | { kind: "form" }
  | { kind: "quoted"; quote: QuoteResponse; token: TokenInfo; verified: boolean | null; refund: Landing }
  | { kind: "paying"; quote: QuoteResponse; token: TokenInfo }
  | { kind: "tracking"; quote: QuoteResponse; token: TokenInfo; paid: Payout };

/** Hop two. ZEC leaves this device's shielded pool and arrives as another asset
 * at an address with no link to the deposit that came in. */
function SendOutView({ status }: { status: WalletStatus }) {
  const [tokens, setTokens] = useState<TokenInfo[] | null>(null);
  const [tokensError, setTokensError] = useState<string | null>(null);
  const [report, setReport] = useState<WalletReport | null>(null);
  const [chain, setChain] = useState<string>("base");
  const [assetId, setAssetId] = useState<string>("");
  const [amount, setAmount] = useState<string>("");
  const [destination, setDestination] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [step, setStep] = useState<OutStep>({ kind: "form" });

  useEffect(() => {
    client
      .getTokens()
      .then((t) => setTokens(t))
      .catch((e: unknown) => setTokensError(errorText(e)));
  }, []);
  useEffect(() => {
    if (!status.running) return;
    let alive = true;
    const tick = () => wallet.report().then((r) => alive && setReport(r)).catch(() => undefined);
    tick();
    const id = window.setInterval(tick, 5_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [status.running]);

  const byChain = useMemo(() => {
    const m = tokens ? groupByChain(tokens) : new Map<string, TokenInfo[]>();
    m.delete("zec");
    return m;
  }, [tokens]);
  const chainTokens = byChain.get(chain) ?? [];
  const token = chainTokens.find((t) => t.assetId === assetId) ?? chainTokens[0] ?? null;
  const zec = tokens?.find((t) => t.blockchain === "zec" && t.symbol === "ZEC") ?? null;
  useEffect(() => {
    if (token && token.assetId !== assetId) setAssetId(token.assetId);
  }, [token, assetId]);

  const spendable = BigInt(report?.balance.ironwood_spendable ?? 0);
  let send: bigint | null = null;
  let amountError: string | null = null;
  if (amount.trim() !== "") {
    try {
      send = parseUnits(amount.trim(), 8);
      if (send <= 0n) amountError = "Enter an amount above zero.";
      else if (send + 15_000n > spendable) amountError = `Not enough spendable ZEC. Keep 0.00015 ZEC for the network fee.`;
    } catch {
      amountError = "Enter a ZEC amount, for example 0.05.";
    }
  }
  const feePreview = token && zec ? client.previewFee(zec, token, "EXACT_INPUT") : null;
  const canQuote = Boolean(token && zec && send && !amountError && destination.trim() !== "" && status.running && !busy);

  async function getQuote() {
    if (!token || !zec || !send) return;
    setBusy(true);
    setFormError(null);
    try {
      // A refund, if the route fails, lands on a fresh address of ours and is shielded again.
      const refund = await wallet.nextLanding();
      const request = {
        swapType: "EXACT_INPUT" as const,
        slippageTolerance: 100,
        originAsset: zec.assetId,
        depositType: "ORIGIN_CHAIN" as const,
        destinationAsset: token.assetId,
        amount: send.toString(),
        refundTo: refund.transparent,
        refundType: "ORIGIN_CHAIN" as const,
        recipient: destination.trim(),
        recipientType: "DESTINATION_CHAIN" as const,
        deadline: new Date(Date.now() + 30 * 60_000),
      };
      if (api) {
        for (const [address, c] of [
          [request.refundTo, "zec"],
          [request.recipient, token.blockchain],
        ] as const) {
          const v = await api.screen(address, c);
          if (!v.allowed) {
            setFormError(v.reason ?? "This address cannot be used with Unpair.");
            return;
          }
        }
        const signed = await api.quote({ ...request, dry: false, deadline: request.deadline.toISOString() });
        const verified = config.apiPubkey ? await verifySignedQuote(signed, config.apiPubkey) : null;
        if (verified === false) {
          setFormError("This quote did not come from the Unpair API key this app trusts. Nothing was sent.");
          return;
        }
        setStep({ kind: "quoted", quote: signed.quote, token, verified, refund });
      } else {
        const quote = await client.quote(request);
        setStep({ kind: "quoted", quote, token, verified: null, refund });
      }
    } catch (e) {
      if (e instanceof ApiError) setFormError(e.message);
      else if (e instanceof OneClickError) setFormError(describeOneClickError(e));
      else setFormError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function pay(q: Extract<OutStep, { kind: "quoted" }>) {
    const deposit = q.quote.quote.depositAddress;
    if (!deposit) {
      setFormError("The route gave no deposit address.");
      return;
    }
    setStep({ kind: "paying", quote: q.quote, token: q.token });
    try {
      const paid = await wallet.pay(deposit, BigInt(q.quote.quote.amountIn));
      setStep({ kind: "tracking", quote: q.quote, token: q.token, paid });
    } catch (e) {
      setFormError(errorText(e));
      setStep(q);
    }
  }

  function reset() {
    setStep({ kind: "form" });
    setFormError(null);
  }

  if (step.kind === "quoted") {
    const q = step.quote.quote;
    const fee = client.feeFromQuoteResponse(step.quote);
    const deadline = depositDeadline(step.quote);
    return (
      <section className="card">
        <span className="state">{STATE_COPY.quote.label}</span>
        <p>The route holds this price for a while. Paying sends ZEC from this device's shielded pool to the route's deposit address.</p>
        <dl>
          <dt>You send</dt>
          <dd>{q.amountInFormatted} ZEC from the shielded pool, plus a 0.00015 ZEC network fee</dd>
          <dt>You receive</dt>
          <dd>about {q.amountOutFormatted} {step.token.symbol} on {chainName(step.token.blockchain)}, at least {formatUnits(BigInt(q.minAmountOut), step.token.decimals)}</dd>
          <dt>Route deposit</dt>
          <dd className="mono">{q.depositAddress}</dd>
          <dt>Fee</dt>
          <dd>{fee.text}</dd>
          <dt>Time</dt>
          <dd>about {Math.max(1, Math.round(q.timeEstimate / 60))} min after the Zcash transaction confirms</dd>
          {deadline && (
            <>
              <dt>Pay by</dt>
              <dd>{deadline.toLocaleTimeString()}</dd>
            </>
          )}
        </dl>
        {step.verified === true && <p className="hint ok">Signed by the Unpair API. Addresses were screened.</p>}
        <p className="hint">On chain this shows one transparent output to the route and the amount. Do not send the same amount you received, and leave time between the two hops.</p>
        {formError && <p className="hint bad">{formError}</p>}
        <button type="button" className="primary" onClick={() => void pay(step)}>Pay from the shielded pool</button>
        <p className="hint"><button type="button" className="link" onClick={reset}>Back</button></p>
      </section>
    );
  }
  if (step.kind === "paying") {
    return (
      <section className="card">
        <span className="state">Proving</span>
        <p>Building and proving the Zcash transaction on this device. This takes a few seconds, longer the first time.</p>
      </section>
    );
  }
  if (step.kind === "tracking") {
    return <TrackingView step={{ kind: "tracking", quote: step.quote, token: step.token }} onDone={reset} doneLabel="Delivered" paid={step.paid} />;
  }

  return (
    <section className="card">
      <p className="hint">Send ZEC from this device's shielded pool and receive another asset at an address of your choice. The two ends have no link on chain.</p>
      {tokensError && <p className="hint bad">Could not load the asset list: {tokensError}</p>}
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
      <p className={`hint ${amountError ? "bad" : ""}`}>{amountError ?? `${formatUnits(spendable, 8)} ZEC spendable in the shielded pool.`}</p>
      <label htmlFor="out-dest">Destination address on {chainName(chain)}</label>
      <input id="out-dest" placeholder="Where the asset arrives" value={destination} onChange={(e) => setDestination(e.target.value)} autoComplete="off" spellCheck={false} className="mono" />
      <p className="hint">A refund, if the route fails, comes back to a fresh address of this wallet and is shielded again.</p>
      {feePreview && <p className="hint">{feePreview.text}</p>}
      {formError && <p className="hint bad">{formError}</p>}
      <button type="button" className="primary" disabled={!canQuote} onClick={getQuote}>{busy ? "Getting quote" : "Get quote"}</button>
    </section>
  );
}

function describeOneClickError(e: OneClickError): string {
  const body = e.body as { message?: string } | null;
  const msg = body && typeof body.message === "string" ? body.message : e.message;
  if (/refundTo/i.test(msg)) return "The route did not accept the refund address. Check it and try again.";
  if (/recipient/i.test(msg)) return "The route did not accept the landing address. Try again.";
  if (/amount/i.test(msg)) return "The route did not accept this amount. Try a larger or smaller one.";
  return `The route could not quote this swap: ${msg}`;
}

function QuoteView({ step, mode, landing, onBack, onAccept }: { step: Extract<Step, { kind: "quoted" }>; mode: Mode; landing: Landing | null; onBack: () => void; onAccept: () => void }) {
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
        <dt>Lands at</dt>
        <dd className="mono">{landing?.transparent}</dd>
        <dt>Fee</dt>
        <dd>{fee.text}</dd>
        <dt>Time</dt>
        <dd>about {Math.max(1, Math.round(q.timeEstimate / 60))} min{mode === "quiet" ? ", then the release delay" : ""}</dd>
        {deadline && (
          <>
            <dt>Deposit by</dt>
            <dd>{deadline.toLocaleTimeString()}</dd>
          </>
        )}
      </dl>
      {step.verified === true && <p className="hint ok">Signed by the Unpair API. Addresses were screened.</p>}
      {step.verified === null && api && <p className="hint warn">This build has no pinned API key, so the quote could not be verified.</p>}
      <p className="hint">The quote is also signed by the route. Keep the app open until the swap lands and is shielded.</p>
      <button type="button" className="primary" onClick={onAccept}>Show deposit address</button>
      <p className="hint"><button type="button" className="link" onClick={onBack}>Back</button></p>
    </section>
  );
}

function TrackingView({ step, onDone, doneLabel, paid }: { step: Extract<Step, { kind: "tracking" }>; onDone: () => void; doneLabel?: string; paid?: Payout | null }) {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
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
        if (alive) setError(errorText(e));
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
  const label = state === "landed" && doneLabel ? doneLabel : copy_.label;
  const text = state === "landed" && doneLabel ? "The route paid your destination address." : copy_.text;
  return (
    <section className="card">
      <span className={`state ${state}`}>{label}</span>
      <p>{text}</p>
      {paid && (
        <p className="hint ok">Paid from the shielded pool. Zcash transaction <span className="mono">{paid.txid.slice(0, 12)}...</span>, fee {formatUnits(BigInt(paid.fee), 8)} ZEC.</p>
      )}
      {!final && !paid && (
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
        <p key={tx.hash} className="hint">Zcash transaction <span className="mono">{tx.hash.slice(0, 12)}...</span></p>
      ))}
      {state === "landed" && !doneLabel && <p className="hint ok">The app shields the landing on its next sync. See the Wallet tab.</p>}
      {status?.swapDetails.refundReason && <p className="hint bad">Reason: {status.swapDetails.refundReason}</p>}
      {error && <p className="hint warn">Status check failed, retrying: {error}</p>}
      {final && <button type="button" className="primary" onClick={onDone}>Start another</button>}
    </section>
  );
}

function WalletView({ status, onStatus }: { status: WalletStatus; onStatus: (s: WalletStatus) => void }) {
  const [report, setReport] = useState<WalletReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [phrase, setPhrase] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!status.running) return;
    let alive = true;
    const tick = () => {
      wallet.report().then((r) => alive && setReport(r)).catch((e: unknown) => alive && setError(errorText(e)));
    };
    tick();
    const id = window.setInterval(tick, 5_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [status.running]);

  async function syncNow() {
    setBusy(true);
    try {
      setReport(await wallet.syncNow());
      setError(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="card">
        <h2>This device's wallet</h2>
        <dl>
          <dt>Network</dt>
          <dd>{status.network === "main" ? "Zcash mainnet" : "Zcash testnet"}</dd>
          <dt>Synced to</dt>
          <dd>{report?.synced_height ?? "not yet"}{report?.syncing ? ", syncing" : ""}</dd>
          <dt>Started at</dt>
          <dd>{status.birthday_height ?? "unknown"}</dd>
          <dt>Shielded balance</dt>
          <dd>{report ? `${formatUnits(BigInt(report.balance.ironwood_spendable), 8)} ZEC spendable, ${formatUnits(BigInt(report.balance.ironwood_total), 8)} ZEC in total` : "unknown"}</dd>
          {report && report.balance.unshielded > 0 && (
            <>
              <dt>Waiting to shield</dt>
              <dd>{formatUnits(BigInt(report.balance.unshielded), 8)} ZEC</dd>
            </>
          )}
          <dt>Landings</dt>
          <dd>{report?.landings.length ?? 0}</dd>
          <dt>Shielded</dt>
          <dd>{report?.shield_txids.length ?? 0} transaction{report?.shield_txids.length === 1 ? "" : "s"} this session</dd>
        </dl>
        {report?.last_error && <p className="hint warn">Last sync problem: {report.last_error}</p>}
        {error && <p className="hint bad">{error}</p>}
        <button type="button" className="primary" disabled={busy || !status.running} onClick={syncNow}>{busy ? "Syncing" : "Sync and shield now"}</button>
        {report && (report.shield_txids.length > 0 || report.payout_txids.length > 0) && (
          <ul className="plain">
            {report.shield_txids.map((t) => <li key={t} className="mono">shield {t}</li>)}
            {report.payout_txids.map((t) => <li key={t} className="mono">payout {t}</li>)}
          </ul>
        )}
      </section>

      <section className="card">
        <h2>Recovery phrase</h2>
        {status.backed_up ? (
          <p className="hint ok">Backed up. Keep the paper safe.</p>
        ) : (
          <p className="hint warn">Not backed up. Reveal the phrase, write it down, then confirm.</p>
        )}
        {phrase === null ? (
          <p className="hint"><button type="button" className="link" onClick={() => wallet.revealPhrase().then(setPhrase).catch((e: unknown) => setError(errorText(e)))}>Reveal the 24 words</button></p>
        ) : (
          <>
            <ol className="words">
              {phrase.split(" ").map((w, i) => <li key={i}>{w}</li>)}
            </ol>
            <p className="hint"><button type="button" className="link" onClick={() => setPhrase(null)}>Hide</button></p>
            {!status.backed_up && (
              <button type="button" className="primary" onClick={() => wallet.confirmBackup().then(onStatus).catch((e: unknown) => setError(errorText(e)))}>I wrote the words down</button>
            )}
          </>
        )}
      </section>
    </>
  );
}
