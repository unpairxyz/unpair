import { useEffect, useMemo, useRef, useState } from "react";
import {
  OneClickClient,
  OneClickError,
  ZEC_DECIMALS,
  clearnetTransport,
  formatUnits,
  type QuoteInput,
  type QuoteResponse,
  type StatusResponse,
  type TokenInfo,
} from "@unpair/sdk";
import {
  ApiClient,
  ApiError,
  HOSTED_COPY,
  SEND_OUT_COPY,
  STATE_COPY,
  checkAddressForChain,
  checkZcashAddress,
  depositDeadline,
  describeCheck,
  describeRefundCheck,
  hostedStage,
  isHostedFinal,
  planAmount,
  stateOf,
  verifySignedQuote,
  type AddressCheck,
  type HostedInfo,
  type HostedSwap,
  type Mode,
  type SignedQuote,
} from "@unpair/client";
import { loadConfig } from "./config";
import {
  Address,
  DoneBurst,
  Footer,
  GoButton,
  Hero,
  InfoTiles,
  Mascot,
  Masthead,
  PLACEHOLDER,
  PoolDivider,
  QuoteMark,
  Sprites,
  StatusStrip,
  Story,
  Toggle,
  TokenButton,
  TokenPicker,
  WidgetPanel,
  kindOf,
  type HeroStage,
} from "./ui";
import { chainLabel } from "./ui/tokens";

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

/** Who holds the Zcash key between the hops. */
type Custody = "own" | "server";
type View = "in" | "out";
type HostedAvailability = { known: false } | { known: true; info: HostedInfo | null };

const SLIPPAGE_BPS = [50, 100, 200] as const;
const fmt = (v: number, d = 6) => v.toLocaleString("en-US", { maximumFractionDigits: d });
const feeFraction = config.fee ? config.fee.feeBps / 10_000 : 0;
const feePercent = `${(feeFraction * 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;

export function App() {
  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  const [tokensError, setTokensError] = useState<string | null>(null);
  const [hosted, setHosted] = useState<HostedAvailability>(api ? { known: false } : { known: true, info: null });
  const [view, setView] = useState<View>("in");
  const [stage, setStage] = useState<HeroStage>("form");
  const [quiet, setQuiet] = useState(false);
  const [resume] = useState<{ swap?: string; parked?: string }>(() => {
    const p = new URLSearchParams(window.location.search);
    const swap = p.get("swap");
    const parked = p.get("q");
    return {
      ...(swap && /^[0-9a-f]{32}$/.test(swap) ? { swap } : {}),
      ...(parked && /^[0-9a-f]{32}$/.test(parked) ? { parked } : {}),
    };
  });

  useEffect(() => {
    client
      .getTokens()
      .then(setTokens)
      .catch((e: unknown) => setTokensError(e instanceof Error ? e.message : String(e)));
    if (api) {
      api
        .config()
        .then((c) => setHosted({ known: true, info: c.hosted ?? null }))
        .catch(() => setHosted({ known: true, info: null }));
    }
  }, []);

  function leaveResume() {
    window.history.replaceState(null, "", window.location.pathname);
    window.location.reload();
  }

  return (
    <>
      <Sprites />
      <Masthead />
      <main className="page">
        <Hero stage={stage} quiet={quiet} />
        <WidgetPanel>
          {window.location.origin !== config.officialOrigin && (
            <p className="err-line">You are not on {config.officialOrigin}. Self-hosted copies are fine. Copies that ask for keys or passwords are not Unpair.</p>
          )}
          {tokensError && <p className="err-line">Token list failed: {tokensError}</p>}
          {resume.swap && api ? (
            <HostedTracking id={resume.swap} tokens={tokens} verified={null} onStage={setStage} onDone={leaveResume} />
          ) : resume.parked && api ? (
            <ParkedQuote id={resume.parked} tokens={tokens} onStage={setStage} onDone={leaveResume} />
          ) : view === "in" ? (
            <SwapIn tokens={tokens} hosted={hosted} onStage={setStage} onQuiet={setQuiet} onSendOut={() => setView("out")} />
          ) : (
            <SendOut tokens={tokens} onStage={setStage} onQuiet={setQuiet} onSwapIn={() => setView("in")} />
          )}
        </WidgetPanel>
        <Story />
        <InfoTiles feePercent={feePercent} capPercent="1%" />
      </main>
      <Footer />
    </>
  );
}

function sameToken(a: TokenInfo | null, b: TokenInfo | null): boolean {
  return Boolean(a && b && a.assetId === b.assetId);
}

function describeError(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof OneClickError) {
    const body = e.body as { message?: string } | null;
    const msg = body && typeof body.message === "string" ? body.message : e.message;
    if (/refundTo/i.test(msg)) return "The route did not accept the refund address. Check it and try again.";
    if (/recipient/i.test(msg)) return "The route did not accept the destination address. Check it and try again.";
    if (/amount/i.test(msg)) return `The route did not accept the amount: ${msg}`;
    return `The route said: ${msg}`;
  }
  return e instanceof Error ? e.message : String(e);
}

/** Screen both addresses and get a signed quote through the API when configured, else ask 1Click directly. */
async function screenAndQuote(request: QuoteInput, chains: [string, string]): Promise<{ quote: QuoteResponse; signed: SignedQuote | null; verified: boolean | null } | { refused: string }> {
  if (api) {
    for (const [address, chain] of [
      [request.refundTo, chains[0]],
      [request.recipient, chains[1]],
    ] as const) {
      const v = await api.screen(address, chain);
      if (!v.allowed) return { refused: v.reason ?? "This address cannot be served." };
    }
    const signed = await api.quote({ ...request, deadline: request.deadline instanceof Date ? request.deadline.toISOString() : String(request.deadline), dry: false });
    if (!config.apiPubkey) return { refused: "This page has no pinned API key, so it cannot verify the quote. Set VITE_API_PUBKEY." };
    const verified = await verifySignedQuote(signed, config.apiPubkey);
    if (!verified) return { refused: "The quote did not verify against the pinned API key. Do not pay it." };
    return { quote: signed.quote, signed, verified: true };
  }
  const quote = await client.quote(request);
  return { quote, signed: null, verified: null };
}

function useZcashCheck(address: string): AddressCheck | null {
  const [check, setCheck] = useState<AddressCheck | null>(null);
  useEffect(() => {
    let alive = true;
    if (address.trim() === "") {
      setCheck(null);
      return;
    }
    checkZcashAddress(address).then((c) => {
      if (alive) setCheck(c);
    });
    return () => {
      alive = false;
    };
  }, [address]);
  return check;
}

function Details({ a, b, amount, out, minOut, slippage, onSlippage, time }: { a: TokenInfo; b: TokenInfo; amount: number; out: number; minOut: number; slippage: number; onSlippage: (bps: number) => void; time: string }) {
  const fee = client.previewFee(a, b, "EXACT_INPUT");
  return (
    <details className="det">
      <summary>
        <span>1 {a.symbol} ≈ {amount > 0 ? fmt(out / amount) : "?"} {b.symbol}</span>
        <span className="code">DETAILS</span>
      </summary>
      <dl>
        <dt>Route</dt>
        <dd>{a.symbol} · {chainLabel(a.blockchain)} → ZEC pool → {b.symbol} · {chainLabel(b.blockchain)}</dd>
        <dt>Min. received</dt>
        <dd>{fmt(minOut)} {b.symbol} at {slippage / 100}% slippage</dd>
        <dt>Fee</dt>
        <dd>{fee.text}</dd>
        <dt>Time</dt>
        <dd>{time}</dd>
      </dl>
      <div className="slip" role="group" aria-label="Slippage">
        {SLIPPAGE_BPS.map((bps) => (
          <button key={bps} type="button" aria-pressed={slippage === bps} onClick={() => onSlippage(bps)}>{bps / 100}%</button>
        ))}
      </div>
    </details>
  );
}

function SwapIn({ tokens, hosted, onStage, onQuiet, onSendOut }: { tokens: TokenInfo[]; hosted: HostedAvailability; onStage: (s: HeroStage) => void; onQuiet: (q: boolean) => void; onSendOut: () => void }) {
  const [mode, setMode] = useState<Mode>("fast");
  const [custody, setCustody] = useState<Custody>("own");
  const [inId, setInId] = useState<string | null>(null);
  const [outId, setOutId] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [dest, setDest] = useState("");
  const [refund, setRefund] = useState("");
  const [slippage, setSlippage] = useState<number>(100);
  const [picking, setPicking] = useState<"in" | "out" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<
    | { kind: "form" }
    | { kind: "own"; quote: QuoteResponse; signed: SignedQuote | null; verified: boolean | null; token: TokenInfo; shielded: boolean }
    | { kind: "server"; swap: HostedSwap; signed: SignedQuote; verified: boolean | null; token: TokenInfo }
  >({ kind: "form" });

  const zec = useMemo(() => tokens.find((t) => t.blockchain === "zec" && t.symbol === "ZEC") ?? null, [tokens]);
  const a = useMemo(() => tokens.find((t) => t.assetId === inId) ?? null, [tokens, inId]);
  const bPicked = useMemo(() => tokens.find((t) => t.assetId === outId) ?? null, [tokens, outId]);
  const b = custody === "own" ? zec : bPicked;
  useEffect(() => {
    if (tokens.length && !inId) {
      setInId(tokens.find((t) => t.symbol === "USDC" && t.blockchain === "base")?.assetId ?? tokens[0]?.assetId ?? null);
      setOutId(tokens.find((t) => t.symbol === "ETH" && t.blockchain === "arb")?.assetId ?? tokens[1]?.assetId ?? null);
    }
  }, [tokens, inId]);
  useEffect(() => onQuiet(mode === "quiet"), [mode, onQuiet]);
  useEffect(() => {
    if (step.kind === "form") onStage("form");
  }, [step.kind, onStage]);

  const hostedInfo = hosted.known ? hosted.info : null;
  const serverOff = custody === "server" && (!api || hostedInfo === null);
  const planned = a && amount ? planAmount(amount, a, mode, true) : null;
  const planError = planned && "error" in planned ? planned.error : null;
  const plan = planned && !("error" in planned) ? planned : null;
  const sendNum = plan && a ? Number(formatUnits(plan.send, a.decimals)) : 0;
  const out = a && b && b.price > 0 ? (sendNum * a.price * (1 - feeFraction)) / b.price : 0;
  const minOut = out * (1 - slippage / 10_000);
  const same = sameToken(a, b);

  const zecCheck = useZcashCheck(custody === "own" ? dest : "");
  const zecVerdict = zecCheck ? describeCheck(zecCheck) : null;
  const destCheck = custody === "own" ? (zecVerdict ? { ok: zecVerdict.ok, text: zecVerdict.text } : null) : b && dest.trim() ? checkAddressForChain(dest, b.blockchain) : null;
  const refundCheck = a && refund.trim() ? checkAddressForChain(refund, a.blockchain) : null;

  let label = "GET DEPOSIT ADDRESS";
  if (!a || !b) label = tokens.length ? "PICK A TOKEN" : "LOADING TOKENS";
  else if (serverOff) label = "SERVER MODE IS OFF HERE";
  else if (same || (b.blockchain === "zec" && custody === "server")) label = "PICK A DIFFERENT TOKEN";
  else if (!plan) label = "ENTER AN AMOUNT";
  else if (!destCheck?.ok) label = custody === "own" ? "ADD YOUR ZCASH ADDRESS" : `ADD YOUR ${chainLabel(b.blockchain).toUpperCase()} ADDRESS`;
  else if (!refundCheck?.ok) label = "ADD A REFUND ADDRESS";
  const ready = label === "GET DEPOSIT ADDRESS" && !busy;

  let tip: [string, "" | "ok" | "err"] = [custody === "own" ? "Pick what you send. It lands as ZEC in your own shielded wallet. You send it on from there." : "Pick what you send and what you want back. The server swims it through the pool for you.", ""];
  if (error) tip = [error, "err"];
  else if (serverOff) tip = [hosted.known ? "This server does not offer the hosted path. Pick your own wallet." : "Checking whether this server offers the hosted path.", "err"];
  else if (same) tip = ["Same token on the same chain? Pick something else to receive.", "err"];
  else if (planError) tip = [planError, "err"];
  else if (destCheck && !destCheck.ok) tip = [destCheck.text, "err"];
  else if (destCheck?.ok && refundCheck && !refundCheck.ok) tip = [refundCheck.text, "err"];
  else if (destCheck?.ok && refundCheck?.ok) tip = ["Ready. Get the deposit address.", "ok"];
  else if (destCheck?.ok && a) tip = [`Got it. Now a refund address on ${chainLabel(a.blockchain)}, in case the route fails.`, "ok"];

  async function go() {
    if (!a || !b || !plan) return;
    setBusy(true);
    setError(null);
    try {
      if (custody === "server") {
        if (!api) throw new Error("The hosted path needs the Unpair API.");
        const r = await api.createHostedSwap({
          mode,
          originAsset: a.assetId,
          amount: plan.send.toString(),
          destinationAsset: b.assetId,
          recipient: dest.trim(),
          refundTo: refund.trim(),
          slippageTolerance: slippage,
        });
        const verified = config.apiPubkey ? await verifySignedQuote(r.quote, config.apiPubkey) : null;
        if (verified === false) throw new Error("The quote did not verify against the pinned API key. Do not pay it.");
        window.history.replaceState(null, "", `${window.location.pathname}?swap=${r.swap.id}`);
        setStep({ kind: "server", swap: r.swap, signed: r.quote, verified, token: a });
        onStage("deposit");
        return;
      }
      const request: QuoteInput = {
        swapType: "EXACT_INPUT",
        slippageTolerance: slippage,
        originAsset: a.assetId,
        depositType: "ORIGIN_CHAIN",
        destinationAsset: b.assetId,
        amount: plan.send.toString(),
        refundTo: refund.trim(),
        refundType: "ORIGIN_CHAIN",
        recipient: dest.trim(),
        recipientType: "DESTINATION_CHAIN",
        deadline: new Date(Date.now() + 15 * 60_000),
      };
      const r = await screenAndQuote(request, [a.blockchain, "zec"]);
      if ("refused" in r) setError(r.refused);
      else {
        setStep({ kind: "own", quote: r.quote, signed: r.signed, verified: r.verified, token: a, shielded: zecVerdict?.landing === "shielded" });
        onStage("deposit");
      }
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setStep({ kind: "form" });
    setError(null);
    window.history.replaceState(null, "", window.location.pathname);
  }

  if (step.kind === "server") {
    return <HostedTracking id={step.swap.id} first={step.swap} signed={step.signed} tokens={tokens} verified={step.verified} onStage={onStage} onDone={reset} />;
  }
  if (step.kind === "own") {
    return <OwnTracking quote={step.quote} signed={step.signed} verified={step.verified} token={step.token} direction="in" shielded={step.shielded} quiet={mode === "quiet"} onStage={onStage} onDone={reset} onSendOut={onSendOut} />;
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) void go();
      }}
      noValidate
    >
      <div className="wtitle">
        <b>UNPAIR A SWAP</b>
        <button type="button" className="tag" onClick={onSendOut}>Send out</button>
      </div>
      <div className="row2">
        <Toggle small label="Mode" value={mode} onChange={setMode} options={[{ value: "fast", title: "Fast", hint: "~5 min" }, { value: "quiet", title: "Quiet", hint: "rounded, random delay" }]} />
        <Toggle small label="Who holds the coins in between" value={custody} onChange={(c) => { setCustody(c); setDest(""); setError(null); }} options={[{ value: "own", title: "My wallet", hint: "you hold the key" }, { value: "server", title: "Unpair server", hint: "we hold it" }]} />
      </div>
      <p className={custody === "server" ? "custody-note warn" : "custody-note"}>
        {custody === "server"
          ? "Unpair's server holds your coins between the two swaps and can see both ends. You can close the tab and come back with the link."
          : "Your own Zcash wallet receives the ZEC into the shielded pool. Unpair holds nothing. You send it on from your wallet when you like."}
      </p>

      <div className="box pay">
        <div className="kv">
          <label htmlFor="amount">You send</label>
          <span className="meta" style={{ margin: 0 }}>{a && sendNum > 0 ? `$${fmt(sendNum * a.price, 2)}` : ""}</span>
        </div>
        <div className="amt">
          <input id="amount" inputMode="decimal" autoComplete="off" placeholder="0" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <TokenButton token={a} label="Token you send" onClick={() => setPicking("in")} />
        </div>
        <div className="meta"><span>{plan && a && plan.heldBack > 0n ? `Quiet mode rounds down to ${formatUnits(plan.send, a.decimals)}. The rest stays in your wallet.` : ""}</span></div>
      </div>

      <PoolDivider {...(custody === "server" ? { onFlip: () => { setInId(outId); setOutId(inId); setDest(""); setRefund(""); } } : {})} />

      <div className="box pay">
        <div className="kv">
          <span className="lbl">You receive</span>
          <span className="meta" style={{ margin: 0 }}>{out > 0 && b ? `≈ $${fmt(out * b.price, 2)}` : ""}</span>
        </div>
        <div className="amt">
          <output aria-live="polite">{out > 0 ? fmt(out) : "0"}</output>
          {custody === "own" ? <TokenButton token={zec} label="You receive ZEC" onClick={() => {}} /> : <TokenButton token={bPicked} label="Token you receive" onClick={() => setPicking("out")} />}
        </div>
        <div className="meta"><span>{custody === "own" ? "into your shielded wallet" : "from a fresh source"}</span></div>
      </div>

      {a && b && plan && !same && (
        <Details a={a} b={b} amount={sendNum} out={out} minOut={minOut} slippage={slippage} onSlippage={setSlippage} time={mode === "quiet" ? "about 5 min in, then a random wait up to 12 h" : "about 5 min"} />
      )}

      {b && (
        <div className="box field">
          <label htmlFor="dest">{custody === "own" ? "Your Zcash address (u1 shielded-only is best)" : `Send it to (${chainLabel(b.blockchain)} address)`}</label>
          <div className="row">
            <input id="dest" autoComplete="off" spellCheck={false} placeholder={custody === "own" ? "u1… or t1…" : PLACEHOLDER[kindOf(b.blockchain)]} value={dest} onChange={(e) => setDest(e.target.value)} aria-invalid={destCheck ? !destCheck.ok : false} />
          </div>
        </div>
      )}
      {a && (
        <div className="box field">
          <label htmlFor="refund">Refund address ({chainLabel(a.blockchain)}), in case the route fails</label>
          <div className="row">
            <input id="refund" autoComplete="off" spellCheck={false} placeholder={PLACEHOLDER[kindOf(a.blockchain)]} value={refund} onChange={(e) => setRefund(e.target.value)} aria-invalid={refundCheck ? !refundCheck.ok : false} />
          </div>
        </div>
      )}
      {custody === "server" && hostedInfo && (
        <p className="fine">Each hosted swap carries at most {formatUnits(BigInt(hostedInfo.max_zat), ZEC_DECIMALS)} ZEC. {hostedInfo.open} of {hostedInfo.max_open} slots in use.</p>
      )}

      <Mascot tone={tip[1]}>{tip[0]}</Mascot>
      <GoButton type="submit" disabled={!ready}>{busy ? "GETTING A QUOTE" : label}</GoButton>
      <p className="fine">{api ? "Addresses are screened and the quote is signed by the Unpair API." : "The quote comes straight from the route, from your browser."}</p>

      <TokenPicker
        open={picking !== null}
        title={picking === "in" ? "YOU SEND" : "YOU RECEIVE"}
        tokens={tokens.filter((t) => t.blockchain !== "zec")}
        value={picking === "in" ? inId : outId}
        onClose={() => setPicking(null)}
        onPick={(t) => {
          if (picking === "in") {
            if (a?.blockchain !== t.blockchain) setRefund("");
            setInId(t.assetId);
          } else {
            if (bPicked?.blockchain !== t.blockchain) setDest("");
            setOutId(t.assetId);
          }
          setPicking(null);
        }}
      />
    </form>
  );
}

/** Hop two from the user's own wallet: ZEC leaves the pool and arrives as another asset. */
function SendOut({ tokens, onStage, onQuiet, onSwapIn }: { tokens: TokenInfo[]; onStage: (s: HeroStage) => void; onQuiet: (q: boolean) => void; onSwapIn: () => void }) {
  const [mode, setMode] = useState<Mode>("fast");
  const [outId, setOutId] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [dest, setDest] = useState("");
  const [refund, setRefund] = useState("");
  const [slippage, setSlippage] = useState<number>(100);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<{ kind: "form" } | { kind: "quoted"; quote: QuoteResponse; signed: SignedQuote | null; verified: boolean | null; token: TokenInfo }>({ kind: "form" });

  const zec = useMemo(() => tokens.find((t) => t.blockchain === "zec" && t.symbol === "ZEC") ?? null, [tokens]);
  const b = useMemo(() => tokens.find((t) => t.assetId === outId) ?? null, [tokens, outId]);
  useEffect(() => {
    if (tokens.length && !outId) setOutId(tokens.find((t) => t.symbol === "USDC" && t.blockchain === "base")?.assetId ?? tokens[0]?.assetId ?? null);
  }, [tokens, outId]);
  useEffect(() => onQuiet(mode === "quiet"), [mode, onQuiet]);
  useEffect(() => {
    if (step.kind === "form") onStage("pool");
  }, [step.kind, onStage]);

  const planned = zec && amount ? planAmount(amount, zec, mode, true) : null;
  const planError = planned && "error" in planned ? planned.error : null;
  const plan = planned && !("error" in planned) ? planned : null;
  const sendNum = plan ? Number(formatUnits(plan.send, ZEC_DECIMALS)) : 0;
  const out = zec && b && b.price > 0 ? (sendNum * zec.price * (1 - feeFraction)) / b.price : 0;
  const destCheck = b && dest.trim() ? checkAddressForChain(dest, b.blockchain) : null;
  const refundZ = useZcashCheck(refund);
  const refundVerdict = refundZ ? describeRefundCheck(refundZ) : null;

  let label = "SHOW THE ROUTE'S ADDRESS";
  if (!zec || !b) label = tokens.length ? "PICK A TOKEN" : "LOADING TOKENS";
  else if (b.blockchain === "zec") label = "PICK A DIFFERENT TOKEN";
  else if (!plan) label = "ENTER AN AMOUNT";
  else if (!destCheck?.ok) label = `ADD YOUR ${chainLabel(b.blockchain).toUpperCase()} ADDRESS`;
  else if (!refundVerdict?.ok) label = "ADD A ZCASH REFUND ADDRESS";
  const ready = label === "SHOW THE ROUTE'S ADDRESS" && !busy;

  let tip: [string, "" | "ok" | "err"] = ["Send ZEC from your own shielded wallet and receive another asset at an address of your choice. On chain the two ends have no link.", ""];
  if (error) tip = [error, "err"];
  else if (planError) tip = [planError, "err"];
  else if (destCheck && !destCheck.ok) tip = [destCheck.text, "err"];
  else if (destCheck?.ok && refundVerdict && !refundVerdict.ok) tip = [refundVerdict.text, "err"];
  else if (destCheck?.ok && refundVerdict?.ok) tip = [refundVerdict.landing === "shielded" ? "Ready. A failed hop comes back straight into your shielded pool." : "Ready. A failed hop comes back to your transparent address; your wallet shields it again.", "ok"];
  else if (destCheck?.ok) tip = ["Now a fresh address from your Zcash wallet, for a refund if the route fails. A shielded-only u1 keeps the refund in the pool.", "ok"];

  async function go() {
    if (!zec || !b || !plan) return;
    setBusy(true);
    setError(null);
    try {
      const request: QuoteInput = {
        swapType: "EXACT_INPUT",
        slippageTolerance: slippage,
        originAsset: zec.assetId,
        depositType: "ORIGIN_CHAIN",
        destinationAsset: b.assetId,
        amount: plan.send.toString(),
        refundTo: refund.trim(),
        refundType: "ORIGIN_CHAIN",
        recipient: dest.trim(),
        recipientType: "DESTINATION_CHAIN",
        deadline: new Date(Date.now() + 30 * 60_000),
      };
      const r = await screenAndQuote(request, ["zec", b.blockchain]);
      if ("refused" in r) setError(r.refused);
      else {
        setStep({ kind: "quoted", quote: r.quote, signed: r.signed, verified: r.verified, token: b });
        onStage("out");
      }
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  if (step.kind === "quoted") {
    return <OwnTracking quote={step.quote} signed={step.signed} verified={step.verified} token={step.token} direction="out" shielded={false} quiet={mode === "quiet"} onStage={onStage} onDone={() => { setStep({ kind: "form" }); setError(null); }} onSendOut={() => {}} />;
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) void go();
      }}
      noValidate
    >
      <div className="wtitle">
        <b>SEND OUT</b>
        <button type="button" className="tag" onClick={onSwapIn}>Swap in</button>
      </div>
      <Toggle small label="Mode" value={mode} onChange={setMode} options={[{ value: "fast", title: "Fast", hint: "exact amount" }, { value: "quiet", title: "Quiet", hint: "rounded amount" }]} />
      <p className="custody-note">This is the second hop. Pay the route from your shielded balance, never from a transparent one, and leave time since the first hop.</p>
      <div className="box pay">
        <div className="kv">
          <label htmlFor="out-amount">You send from your shielded wallet</label>
          <span className="meta" style={{ margin: 0 }}>{zec && sendNum > 0 ? `$${fmt(sendNum * zec.price, 2)}` : ""}</span>
        </div>
        <div className="amt">
          <input id="out-amount" inputMode="decimal" autoComplete="off" placeholder="0" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <TokenButton token={zec} label="You send ZEC" onClick={() => {}} />
        </div>
        <div className="meta"><span>{plan && plan.heldBack > 0n ? `Quiet mode rounds down to ${formatUnits(plan.send, ZEC_DECIMALS)} ZEC.` : "Do not send the same amount you received."}</span></div>
      </div>
      <PoolDivider />
      <div className="box pay">
        <div className="kv">
          <span className="lbl">You receive</span>
          <span className="meta" style={{ margin: 0 }}>{out > 0 && b ? `≈ $${fmt(out * b.price, 2)}` : ""}</span>
        </div>
        <div className="amt">
          <output aria-live="polite">{out > 0 ? fmt(out) : "0"}</output>
          <TokenButton token={b} label="Token you receive" onClick={() => setPicking(true)} />
        </div>
        <div className="meta"><span>at an address with no history</span></div>
      </div>
      {zec && b && plan && b.blockchain !== "zec" && (
        <Details a={zec} b={b} amount={sendNum} out={out} minOut={out * (1 - slippage / 10_000)} slippage={slippage} onSlippage={setSlippage} time="about 8 min after your payment confirms" />
      )}
      {b && (
        <div className="box field">
          <label htmlFor="out-dest">Send it to ({chainLabel(b.blockchain)} address)</label>
          <div className="row">
            <input id="out-dest" autoComplete="off" spellCheck={false} placeholder={PLACEHOLDER[kindOf(b.blockchain)]} value={dest} onChange={(e) => setDest(e.target.value)} aria-invalid={destCheck ? !destCheck.ok : false} />
          </div>
        </div>
      )}
      <div className="box field">
        <label htmlFor="out-refund">Refund address, a fresh address of your Zcash wallet</label>
        <div className="row">
          <input id="out-refund" autoComplete="off" spellCheck={false} placeholder="u1… or t1…" value={refund} onChange={(e) => setRefund(e.target.value)} aria-invalid={refundVerdict ? !refundVerdict.ok : false} />
        </div>
      </div>
      <Mascot tone={tip[1]}>{tip[0]}</Mascot>
      <GoButton type="submit" disabled={!ready}>{busy ? "GETTING A QUOTE" : label}</GoButton>
      <TokenPicker open={picking} title="YOU RECEIVE" tokens={tokens.filter((t) => t.blockchain !== "zec")} value={outId} onClose={() => setPicking(false)} onPick={(t) => { if (b?.blockchain !== t.blockchain) setDest(""); setOutId(t.assetId); setPicking(false); }} />
    </form>
  );
}

function usePoll<T>(fn: (() => Promise<T>) | null, stop: boolean, everyMs = 7_000): { value: T | null; error: string | null } {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  useEffect(() => {
    if (!fn || stop) return;
    let alive = true;
    const tick = async () => {
      try {
        const v = await fn();
        if (alive) {
          setValue(v);
          setError(null);
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
      if (alive) timer.current = window.setTimeout(tick, everyMs);
    };
    void tick();
    return () => {
      alive = false;
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [fn, stop, everyMs]);
  return { value, error };
}

function markSeed(signed: SignedQuote | null, quote: QuoteResponse): string {
  return signed ? signed.signature.slice(0, 16) : (quote.quote.depositAddress ?? "").slice(0, 16);
}

function shortCode(seed: string): string {
  const s = seed.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return `${s.slice(0, 4)}-${s.slice(4, 8)}`;
}

/** A quote the user pays from their own wallet, tracked on 1Click until it lands or returns. */
function OwnTracking({ quote, signed, verified, token, direction, shielded, quiet, onStage, onDone, onSendOut }: {
  quote: QuoteResponse;
  signed: SignedQuote | null;
  verified: boolean | null;
  token: TokenInfo;
  direction: "in" | "out";
  shielded: boolean;
  quiet: boolean;
  onStage: (s: HeroStage) => void;
  onDone: () => void;
  onSendOut: () => void;
}) {
  const q = quote.quote;
  const depositAddress = q.depositAddress ?? "";
  const memo = q.depositMemo;
  const [sent, setSent] = useState(false);
  const [parked, setParked] = useState<string | null>(null);
  const pollFn = useMemo(() => (depositAddress ? () => (api ? api.status(depositAddress, memo) : client.status(depositAddress, memo)) : null), [depositAddress, memo]);
  const [final, setFinal] = useState(false);
  const { value: status, error } = usePoll<StatusResponse>(pollFn, final);
  const current = stateOf(status);
  useEffect(() => {
    if (current === "landed" || current === "refunded" || current === "failed") setFinal(true);
  }, [current]);
  const seed = markSeed(signed, quote);
  const deadline = depositDeadline(quote);

  useEffect(() => {
    if (current === "routing") onStage("into");
    else if (current === "landed") onStage(direction === "in" ? "pool" : "done");
    else if (current === "refunded" || current === "failed") onStage("form");
  }, [current, direction, onStage]);

  async function park() {
    if (!api || !signed) return;
    try {
      const r = await api.parkQuote(signed);
      setParked(`${window.location.origin}${window.location.pathname}?q=${r.id}`);
    } catch (e) {
      setParked(describeError(e));
    }
  }

  const copy = (direction === "out" ? SEND_OUT_COPY[current] : undefined) ?? STATE_COPY[current];
  if (final) {
    return (
      <div>
        {current === "landed" ? <DoneBurst /> : <div className="wtitle"><b>{copy.label.toUpperCase()}</b></div>}
        <p style={{ margin: 0, font: "700 15px var(--ui)" }}>
          {current === "landed" && direction === "in"
            ? shielded
              ? `${q.amountOutFormatted} ZEC arrived in the shielded pool at your address. Nothing more to do on the Zcash side.`
              : `${q.amountOutFormatted} ZEC arrived at your transparent address. Your wallet shields it from here.`
            : current === "landed"
              ? `${q.amountOutFormatted} ${token.symbol} arrived on ${chainLabel(token.blockchain)}. Nothing links it to your deposit.`
              : copy.text}
        </p>
        {status?.swapDetails.refundReason && <p className="err-line">Reason: {status.swapDetails.refundReason}</p>}
        {current === "landed" && direction === "in" && (
          <Mascot face="happy" red={false}>{quiet ? "Wait a while, a few hours is good, then send out from your wallet. Longer and less regular is better." : "When you want it somewhere else, send out from your wallet."}</Mascot>
        )}
        {current === "landed" && direction === "in" && <GoButton onClick={onSendOut}>SEND OUT LATER</GoButton>}
        <GoButton ghost onClick={onDone}>NEW SWAP</GoButton>
      </div>
    );
  }
  if (!sent && current === "waiting_for_deposit") {
    return (
      <div>
        <div className="wtitle">
          <b>{direction === "out" ? "PAY THE ROUTE" : "SEND IT!"}</b>
          <span className="chip">{direction === "out" ? "from your shielded wallet" : `on ${chainLabel(token.blockchain)}`}</span>
        </div>
        <div className="markrow">
          <QuoteMark seed={seed} />
          <div>
            <b>{signed && verified ? "Quote signed by Unpair" : "Quote signed by the route"}</b> <span className="code">{shortCode(seed)}</span>
          </div>
        </div>
        <div className="box"><span className="lbl">Send exactly</span><div className="big">{q.amountInFormatted} {direction === "out" ? "ZEC" : token.symbol}</div></div>
        <div className="box"><span className="lbl">{direction === "out" ? "To the route's Zcash address, once" : "To this address, once"}</span><Address value={depositAddress} /></div>
        {memo && <div className="box"><span className="lbl">With this memo</span><div className="code">{memo}</div></div>}
        {deadline && <p className="fine">Pay by {deadline.toLocaleTimeString()}. The address bar must say {new URL(config.officialOrigin).host}.</p>}
        <Mascot>{direction === "out" ? "Pay from your shielded balance, not from a transparent one, or the hop is linkable." : "I'm waiting at the edge. Send from any wallet you control."}</Mascot>
        {api && signed && !parked && <button type="button" className="mini" onClick={() => void park()}>Check on your phone</button>}
        {parked && <div className="box"><span className="lbl">Open this on your phone</span><Address value={parked} /><p className="fine">Anyone with the link sees this quote. It lives on the server for two hours.</p></div>}
        <GoButton onClick={() => { setSent(true); onStage("seen"); }}>I SENT IT!</GoButton>
        <p className="fine"><button type="button" className="link" onClick={onDone}>Start over</button></p>
      </div>
    );
  }
  const strip = current === "waiting_for_deposit" ? 0 : current === "routing" ? 1 : 2;
  return (
    <div>
      <div className="wtitle"><b>IN PROGRESS</b><span className="code">{shortCode(seed)}</span></div>
      <StatusStrip current={strip} texts={direction === "in" ? { 0: "Watching the deposit address.", 1: "The route swaps it into ZEC and pays your address.", 2: "Lands in your wallet's shielded pool.", 3: "That part is yours: send out from your wallet later." } : { 0: "Watching the route's address.", 1: "The route is filling your swap.", 2: "Paid from your shielded note.", 3: "Your asset arrives at your address." }} />
      {status?.swapDetails.destinationChainTxHashes.map((tx) => (
        <p key={tx.hash} className="fine">Transaction <a className="code" href={tx.explorerUrl} rel="noreferrer">{tx.hash.slice(0, 12)}…</a></p>
      ))}
      {error && <p className="err-line">Status check failed, retrying: {error}</p>}
      <p className="fine">Keep this page open until the swap completes.</p>
    </div>
  );
}

/** A hosted swap, from deposit to delivery. The tab may close and come back by link. */
function HostedTracking({ id, first, signed, tokens, verified, onStage, onDone }: { id: string; first?: HostedSwap; signed?: SignedQuote; tokens: TokenInfo[]; verified: boolean | null; onStage: (s: HeroStage) => void; onDone: () => void }) {
  const [sent, setSent] = useState(false);
  const pollFn = useMemo(() => (api ? () => api.hostedSwap(id) : null), [id]);
  const [initial] = useState<HostedSwap | null>(first ?? null);
  const [final, setFinal] = useState(false);
  const { value: polled, error } = usePoll<HostedSwap>(pollFn, final);
  const swap = polled ?? initial;
  const state = swap?.state;
  useEffect(() => {
    if (state && isHostedFinal(state)) setFinal(true);
  }, [state]);

  useEffect(() => {
    if (!state) return;
    const map: Record<HostedSwap["state"], HeroStage> = { waiting_for_deposit: "deposit", routing_in: "into", in_pool: "pool", routing_out: "out", done: "done", refunded: "form", expired: "form", failed: "form" };
    onStage(map[state]);
  }, [state, onStage]);

  if (!swap) {
    return (
      <div>
        <div className="wtitle"><b>LOADING</b></div>
        <p className="fine">{error ? `Could not load this swap: ${error}` : "Loading the swap."}</p>
        <GoButton ghost onClick={onDone}>START OVER</GoButton>
      </div>
    );
  }
  const copy = HOSTED_COPY[swap.state];
  const inToken = tokens.find((t) => t.assetId === swap.origin_asset) ?? null;
  const outToken = tokens.find((t) => t.assetId === swap.destination_asset) ?? null;
  const amountIn = inToken ? `${formatUnits(BigInt(swap.amount_in), inToken.decimals)} ${inToken.symbol}` : `${swap.amount_in} base units`;
  const link = `${window.location.origin}${window.location.pathname}?swap=${swap.id}`;
  const seed = signed ? signed.signature.slice(0, 16) : swap.id.slice(0, 16);

  if (final) {
    return (
      <div>
        {swap.state === "done" ? <DoneBurst /> : <div className="wtitle"><b>{copy.label.toUpperCase()}</b></div>}
        <p style={{ margin: 0, font: "700 15px var(--ui)" }}>
          {swap.state === "done" ? `${swap.delivered_amount ?? ""} ${outToken?.symbol ?? ""} arrived on ${chainLabel(outToken?.blockchain ?? "")}. On chain, nothing links it to your deposit.` : copy.text}
        </p>
        {swap.note && <p className="fine">{swap.note}</p>}
        {swap.state === "done" && <Mascot face="happy" red={false}>I stayed in the school. A fresh fish swam out to your address. The server saw both ends and forgets this swap in seven days.</Mascot>}
        <p className="fine">Swap id {swap.id}</p>
        <GoButton ghost onClick={onDone}>NEW SWAP</GoButton>
      </div>
    );
  }
  if (!sent && swap.state === "waiting_for_deposit") {
    return (
      <div>
        <div className="wtitle"><b>SEND IT!</b><span className="chip">on {chainLabel(inToken?.blockchain ?? "")}</span></div>
        <div className="markrow">
          <QuoteMark seed={seed} />
          <div><b>{verified ? "Quote signed by Unpair" : "Quote from the server"}</b> <span className="code">{shortCode(seed)}</span></div>
        </div>
        <div className="box"><span className="lbl">Send exactly</span><div className="big">{amountIn}</div></div>
        <div className="box"><span className="lbl">To this address, once</span><Address value={swap.deposit_address} /></div>
        {swap.deposit_memo && <div className="box"><span className="lbl">With this memo</span><div className="code">{swap.deposit_memo}</div></div>}
        <p className="fine">Pay by {new Date(swap.deposit_deadline_unix * 1000).toLocaleString()}.</p>
        <div className="box"><span className="lbl">Your link to this swap</span><Address value={link} /><p className="fine">Anyone with the link sees the progress, the deposit address and your receiving address. Keep it to yourself.</p></div>
        <Mascot>You can close the tab after you pay. The server swims it through for you.</Mascot>
        <GoButton onClick={() => setSent(true)}>I SENT IT!</GoButton>
        <p className="fine"><button type="button" className="link" onClick={onDone}>Start over</button></p>
      </div>
    );
  }
  const stage = hostedStage(swap.state);
  const release = swap.release_at_unix ? new Date(swap.release_at_unix * 1000) : null;
  const poolText = release && swap.state === "in_pool" ? (release.getTime() <= Date.now() ? "Sending on now." : `Sends on at about ${release.toLocaleTimeString()}.`) : undefined;
  return (
    <div>
      <div className="wtitle"><b>IN PROGRESS</b><span className="code">{shortCode(seed)}</span></div>
      <StatusStrip current={stage < 0 ? 0 : stage} {...(poolText ? { texts: { 2: poolText } } : {})} />
      <dl className="det" style={{ display: "block" }}>
        <dt>Receive</dt>
        <dd>{outToken?.symbol ?? swap.destination_asset} on {chainLabel(outToken?.blockchain ?? "")} at {swap.destination_address.slice(0, 10)}…</dd>
        {swap.zec_received !== null && <><dt>In the pool</dt><dd>{formatUnits(BigInt(swap.zec_received), ZEC_DECIMALS)} ZEC</dd></>}
        {swap.hop2_txid && <><dt>Zcash tx</dt><dd className="code">{swap.hop2_txid.slice(0, 12)}…</dd></>}
      </dl>
      <div className="box"><span className="lbl">Your link</span><Address value={link} /></div>
      {swap.note && <p className="fine">{swap.note}</p>}
      {error && <p className="err-line">Status check failed, retrying: {error}</p>}
      <p className="fine"><button type="button" className="link" onClick={onDone}>Leave this page</button> The swap continues on the server. Come back with the link.</p>
    </div>
  );
}

/** A quote parked for a second device. Loads it, checks the signature, then tracks like the first device. */
function ParkedQuote({ id, tokens, onStage, onDone }: { id: string; tokens: TokenInfo[]; onStage: (s: HeroStage) => void; onDone: () => void }) {
  const [signed, setSigned] = useState<{ quote: SignedQuote; verified: boolean | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!api) return;
    api
      .parkedQuote(id)
      .then(async (r) => {
        const verified = config.apiPubkey ? await verifySignedQuote(r.quote, config.apiPubkey) : null;
        if (verified === false) setError("The quote did not verify against the pinned API key. Do not pay it.");
        else setSigned({ quote: r.quote, verified });
      })
      .catch((e: unknown) => setError(describeError(e)));
  }, [id]);
  if (error) {
    return (
      <div>
        <div className="wtitle"><b>NOT FOUND</b></div>
        <p className="fine">{error}. Parked quotes last two hours.</p>
        <GoButton ghost onClick={onDone}>NEW SWAP</GoButton>
      </div>
    );
  }
  if (!signed) return <p className="fine">Loading the quote.</p>;
  const req = signed.quote.quote.quoteRequest;
  const direction = req.originAsset.includes("zec.omft") ? "out" : "in";
  const token = tokens.find((t) => t.assetId === (direction === "out" ? req.destinationAsset : req.originAsset)) ?? null;
  if (!token) return <p className="fine">Loading tokens.</p>;
  return <OwnTracking quote={signed.quote.quote} signed={signed.quote} verified={signed.verified} token={token} direction={direction} shielded={false} quiet={false} onStage={onStage} onDone={onDone} onSendOut={onDone} />;
}
