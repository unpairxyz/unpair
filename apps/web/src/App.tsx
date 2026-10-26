import { useEffect, useMemo, useRef, useState } from "react";
import { ZEC_DECIMALS, formatUnits, type QuoteInput, type QuoteResponse, type StatusResponse, type TokenInfo } from "@unpair/sdk";
import {
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
import { BrowserSwap } from "./BrowserSwap";
import { SLIPPAGE_BPS, api, client, config, describeError, feeFraction, feePercent, fmt, markSeed, screenAndQuote, shortCode, usePoll } from "./core";
import { BrowserWallet, parseRecovery, type Recovery } from "./wallet/browserWallet";
import type { Landing } from "./wallet/types";
import { hop2FeeReserveZat } from "./wallet/fees";
import {
  Address,
  AddressRow,
  AddressRows,
  CardHead,
  DoneBurst,
  Facts,
  Footer,
  GoButton,
  Hero,
  Hint,
  InfoTiles,
  Keeper,
  Leg,
  Legs,
  Mascot,
  Masthead,
  PhoneCheck,
  QuickPicks,
  VerifyHero,
  VerifyStrip,
  Sprites,
  StatusStrip,
  Story,
  Summary,
  TokenButton,
  TxLink,
  YouGet,
  depositWait,
  short,
  useElapsed,
  useEndTime,
  OUT_WAIT,
  POOL_WAIT,
  TokenPicker,
  WidgetPanel,
  type Fact,
  type HeroStage,
} from "./ui";
import { chainLabel } from "./ui/tokens";

type Custody = "own" | "browser" | "server";
type View = "in" | "out";
type HostedAvailability = { known: false } | { known: true; info: HostedInfo | null };

export function App() {
  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  const [tokensError, setTokensError] = useState<string | null>(null);
  const [hosted, setHosted] = useState<HostedAvailability>(api ? { known: false } : { known: true, info: null });
  const [view, setView] = useState<View>("in");
  const [stage, setStage] = useState<HeroStage>("form");
  const [quiet, setQuiet] = useState(false);
  const [resume] = useState<{ swap?: string; parked?: string; check?: boolean }>(() => {
    const p = new URLSearchParams(window.location.search);
    const swap = p.get("swap");
    const parked = p.get("q");
    return {
      ...(swap && /^[0-9a-f]{32}$/.test(swap) ? { swap, check: p.get("check") === "1" } : {}),
      ...(parked && /^[0-9a-f]{32}$/.test(parked) ? { parked } : {}),
    };
  });

  useEffect(() => {
    // with an API the token list comes from it, so the route sees no visitor before a swap
    (api ? api.tokens() : client.getTokens())
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
            <HostedTracking id={resume.swap} tokens={tokens} verified={null} second={resume.check ?? false} onStage={setStage} onDone={leaveResume} />
          ) : resume.parked && api ? (
            <ParkedQuote id={resume.parked} tokens={tokens} onStage={setStage} onDone={leaveResume} />
          ) : view === "in" ? (
            <SwapIn tokens={tokens} hosted={hosted} onStage={setStage} onQuiet={setQuiet} onSendOut={() => setView("out")} />
          ) : (
            <SendOut tokens={tokens} onStage={setStage} onQuiet={setQuiet} onSwapIn={() => setView("in")} />
          )}
        </WidgetPanel>
        <Story />
        <InfoTiles feePercent={feePercent} capPercent="1%" chips={KEEPER_CHIPS} />
      </main>
      <Footer />
    </>
  );
}

function sameToken(a: TokenInfo | null, b: TokenInfo | null): boolean {
  return Boolean(a && b && a.assetId === b.assetId);
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

function Details({ a, b, amount, out, minOut, eta, time, fee: feeLabel = feePercent }: { a: TokenInfo; b: TokenInfo; amount: number; out: number; minOut: number; eta: string; time: string; fee?: string }) {
  const fee = client.previewFee(a, b, "EXACT_INPUT");
  return (
    <Summary
      rate={`1 ${a.symbol} ≈ ${amount > 0 ? fmt(out / amount) : "?"} ${b.symbol}`}
      meta={`fee ${feeLabel} · ${eta}`}
      rows={[
        ["Route", `${a.symbol} · ${chainLabel(a.blockchain)} → ZEC pool → ${b.symbol} · ${chainLabel(b.blockchain)}`],
        ["Min. received", `${fmt(minOut)} ${b.symbol}`],
        ["Fee", fee.text],
        ["Time", time],
      ]}
    />
  );
}

const pct = (f: number): string => `${(f * 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
// fee and time for each keeper, shown as two chips: one-time wallet pays the Unpair fee on both hops,
// the server on hop one only, your own wallet now and again if you send out later
const KEEPER_CHIPS: Record<Custody, [string, string]> = {
  browser: [`about ${pct(feeFraction * 2)}`, "about 40 min, tab open"],
  server: [feePercent, "about 30 min"],
  own: [`${feePercent} now`, "about 10 min"],
};

const MODES: { value: Mode; title: string; hint: string }[] = [
  { value: "fast", title: "Fast", hint: "Exact amount. About 5 minutes." },
  { value: "quiet", title: "Quiet", hint: "Rounds the amount and waits a random time, up to 12 h. Harder to match." },
];

function SwapIn({ tokens, hosted, onStage, onQuiet, onSendOut }: { tokens: TokenInfo[]; hosted: HostedAvailability; onStage: (s: HeroStage) => void; onQuiet: (q: boolean) => void; onSendOut: () => void }) {
  const [mode, setMode] = useState<Mode>("fast");
  // one-time wallet first; a page built without a Zcash wallet server starts on your own wallet
  const [custody, setCustody] = useState<Custody>(config.lwdGrpcWebUrl ? "browser" : "own");
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
    | { kind: "browser"; wallet: BrowserWallet; landing: Landing; quote: QuoteResponse; signed: SignedQuote | null; verified: boolean | null; token: TokenInfo; outToken: TokenInfo; dest: string }
    | { kind: "browser-resume"; wallet: BrowserWallet; recovery: Recovery }
  >({ kind: "form" });
  const fileRef = useRef<HTMLInputElement>(null);

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
  const browserOff = custody === "browser" && !config.lwdGrpcWebUrl;
  const planned = a && amount ? planAmount(amount, a, mode, true) : null;
  const planError = planned && "error" in planned ? planned.error : null;
  const plan = planned && !("error" in planned) ? planned : null;
  const sendNum = plan && a ? Number(formatUnits(plan.send, a.decimals)) : 0;
  // the one-time wallet quotes both hops from the tab, so the routing fee is taken twice
  const hops = custody === "browser" ? 2 : 1;
  // what the button says while the form works: the one-time wallet has a loading step before the quote
  const [busyText, setBusyText] = useState("GETTING A QUOTE");
  // the two-hop keepers keep a network fee reserve back from the ZEC before hop two; it comes off the estimate too
  const reserveOut = custody !== "own" && zec && b && b.price > 0 ? (Number(formatUnits(hop2FeeReserveZat(1), ZEC_DECIMALS)) * zec.price) / b.price : 0;
  const priceOut = a && b && b.price > 0 ? Math.max(0, (sendNum * a.price * (1 - feeFraction) ** hops) / b.price - reserveOut) : 0;
  const small = a !== null && sendNum > 0 && sendNum * a.price < 20;
  // the same token in and out is fine through the pool: two hops, and only the link is gone
  const same = sameToken(a, b);
  const pickable = useMemo(() => tokens.filter((t) => t.blockchain !== "zec"), [tokens]);
  // a new chain makes the old address wrong, so it is cleared
  function pickToken(side: "in" | "out", t: TokenInfo) {
    if (side === "in") {
      if (a?.blockchain !== t.blockchain) setRefund("");
      setInId(t.assetId);
    } else {
      if (bPicked?.blockchain !== t.blockchain) setDest("");
      setOutId(t.assetId);
    }
  }

  const zecCheck = useZcashCheck(custody === "own" ? dest : "");
  const zecVerdict = zecCheck ? describeCheck(zecCheck) : null;
  const destCheck = custody === "own" ? (zecVerdict ? { ok: zecVerdict.ok, text: zecVerdict.text } : null) : b && dest.trim() ? checkAddressForChain(dest, b.blockchain) : null;
  const refundCheck = a && refund.trim() ? checkAddressForChain(refund, a.blockchain) : null;
  // Once the form is complete, the route itself says what you get: the same dry quotes the deposit screen shows.
  // Until then, and when the route does not answer, the price estimate stands.
  const estimateKey = a && b && plan && destCheck?.ok && refundCheck?.ok && api ? [custody, mode, a.assetId, b.assetId, plan.send.toString(), dest.trim(), refund.trim(), slippage].join("|") : null;
  const [live, setLive] = useState<{ key: string; out: number } | null>(null);
  useEffect(() => {
    if (!estimateKey || !api || !a || !b || !plan) return;
    const key = estimateKey;
    const ask = api;
    const t = setTimeout(() => {
      ask
        .estimate({ mode, originAsset: a.assetId, amount: plan.send.toString(), destinationAsset: b.assetId, recipient: dest.trim(), refundTo: refund.trim(), slippageTolerance: slippage, ...(custody !== "own" ? { custody } : {}) })
        .then((e) => {
          const n = Number(e.estimate_out);
          if (Number.isFinite(n) && n > 0) setLive({ key, out: n });
        })
        .catch(() => {});
    }, 700);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [estimateKey]);
  const out = live && live.key === estimateKey ? live.out : priceOut;
  const minOut = out * (1 - slippage / 10_000);

  let label = "GET DEPOSIT ADDRESS";
  if (!a || !b) label = tokens.length ? "PICK A TOKEN" : "LOADING TOKENS";
  else if (serverOff) label = "SERVER MODE IS OFF HERE";
  else if (browserOff) label = "ONE-TIME WALLET IS OFF HERE";
  else if ((same && custody === "own") || (b.blockchain === "zec" && custody !== "own")) label = "PICK A DIFFERENT TOKEN";
  else if (!plan) label = "ENTER AN AMOUNT";
  else if (!destCheck?.ok) label = custody === "own" ? "ADD YOUR ZCASH ADDRESS" : `ADD YOUR ${chainLabel(b.blockchain).toUpperCase()} ADDRESS`;
  else if (!refundCheck?.ok) label = "ADD A REFUND ADDRESS";
  const ready = label === "GET DEPOSIT ADDRESS" && !busy;

  let hint: string | null = null;
  if (error) hint = error;
  else if (serverOff) hint = hosted.known ? "This server does not offer the hosted path. Pick your own wallet." : "Checking whether this server offers the hosted path.";
  else if (browserOff) hint = "This page was built without a Zcash wallet server, so the one-time wallet is off. Pick your own Zcash wallet.";
  else if (same && custody === "own") hint = "Same token on the same chain. Pick something else to get.";
  else if (planError) hint = planError;
  else if (destCheck && !destCheck.ok) hint = destCheck.text;
  else if (refundCheck && !refundCheck.ok) hint = refundCheck.text;

  async function go() {
    if (!a || !b || !plan) return;
    setBusy(true);
    setBusyText("GETTING A QUOTE");
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
      if (custody === "browser") {
        if (!config.lwdGrpcWebUrl || !zec) throw new Error("The one-time wallet needs a Zcash wallet server.");
        setBusyText("LOADING THE WALLET");
        const wallet = await BrowserWallet.create(config.zcashNetwork, config.lwdGrpcWebUrl);
        try {
          const landing = await wallet.nextLanding();
          setBusyText("GETTING A QUOTE");
          const request: QuoteInput = {
            swapType: "EXACT_INPUT",
            slippageTolerance: slippage,
            originAsset: a.assetId,
            depositType: "ORIGIN_CHAIN",
            destinationAsset: zec.assetId,
            amount: plan.send.toString(),
            refundTo: refund.trim(),
            refundType: "ORIGIN_CHAIN",
            recipient: landing.shielded,
            recipientType: "DESTINATION_CHAIN",
            deadline: new Date(Date.now() + 15 * 60_000),
          };
          const r = await screenAndQuote(request, [a.blockchain, "zec"]);
          if ("refused" in r) throw new Error(r.refused);
          setStep({ kind: "browser", wallet, landing, quote: r.quote, signed: r.signed, verified: r.verified, token: a, outToken: b, dest: dest.trim() });
          onStage("deposit");
        } catch (e) {
          wallet.close();
          throw e;
        }
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
    if (step.kind === "browser" || step.kind === "browser-resume") step.wallet.close();
    setStep({ kind: "form" });
    setError(null);
    window.history.replaceState(null, "", window.location.pathname);
  }

  async function resumeFromFile(file: File) {
    if (!config.lwdGrpcWebUrl) return;
    setBusy(true);
    setError(null);
    try {
      const recovery = parseRecovery(await file.text(), config.zcashNetwork);
      const wallet = await BrowserWallet.recover(recovery, config.lwdGrpcWebUrl);
      // the worker holds the key from here; the page keeps the plan only
      setStep({ kind: "browser-resume", wallet, recovery: { ...recovery, phrase: "" } });
      onStage("pool");
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  if (step.kind === "browser") {
    return <BrowserSwap wallet={step.wallet} landing={step.landing} quote={step.quote} signed={step.signed} verified={step.verified} token={step.token} outToken={step.outToken} dest={step.dest} slippage={slippage} mode={mode} tokens={tokens} onStage={onStage} onDone={reset} />;
  }
  if (step.kind === "browser-resume") {
    return <BrowserSwap wallet={step.wallet} recovery={step.recovery} tokens={tokens} onStage={onStage} onDone={reset} />;
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
      <CardHead tab="in" onTab={(t) => t === "out" && onSendOut()} mode={mode} modes={MODES} onMode={setMode} slippage={slippage} slippages={SLIPPAGE_BPS} onSlippage={setSlippage} />
      <Keeper
        label="Held by"
        value={custody}
        onChange={(c) => { setCustody(c); setDest(""); setError(null); }}
        options={[{ value: "browser", title: "One-time wallet" }, { value: "server", title: "Unpair server" }, { value: "own", title: "My Zcash wallet" }]}
        warn={custody === "server"}
        chips={KEEPER_CHIPS[custody]}
        note={custody === "server"
          ? "Our server holds the coins between the swaps, mixed with other people's coins. That is harder to trace on chain, but our server sees both ends. You can close the tab and come back with the link."
          : custody === "browser"
            ? "A fresh Zcash wallet, made in this tab for this one swap. It pays out itself. Unpair never holds your coins in this mode. Keep the tab open, or save the recovery file."
            : "ZEC lands in your own Zcash wallet app, shielded. Unpair never holds your coins in this mode. Move it on later with Send out."}
      />
      <Legs
        {...(custody !== "own" ? { onFlip: () => { setInId(outId); setOutId(inId); setDest(""); setRefund(""); } } : {})}
        send={
          <Leg
            label="You send"
            htmlFor="amount"
            usd={a && sendNum > 0 ? `$${fmt(sendNum * a.price, 2)}` : ""}
            amount={<input id="amount" inputMode="decimal" autoComplete="off" placeholder="0" value={amount} onChange={(e) => setAmount(e.target.value)} />}
            token={<TokenButton token={a} label="Token you send" onClick={() => setPicking("in")} />}
            note={plan && a && plan.heldBack > 0n ? `Quiet sends ${formatUnits(plan.send, a.decimals)} ${a.symbol}. The rest stays with you.` : null}
            picks={<QuickPicks tokens={pickable} value={inId} onPick={(t) => pickToken("in", t)} label="Quick picks to send" />}
          />
        }
        get={
          <Leg
            second
            label="You get"
            usd={out > 0 && b ? `≈ $${fmt(out * b.price, 2)}` : ""}
            amount={<output aria-live="polite" className={out > 0 ? undefined : "zero"}>{out > 0 ? fmt(out) : "0"}</output>}
            token={custody === "own" ? <TokenButton fixed token={zec} label="You get ZEC" /> : <TokenButton token={bPicked} label="Token you receive" onClick={() => setPicking("out")} />}
            note={custody === "own" ? "into your shielded wallet" : null}
            picks={custody === "own" ? null : <QuickPicks tokens={pickable} value={outId} onPick={(t) => pickToken("out", t)} label="Quick picks to get" />}
          />
        }
      />
      <AddressRows>
        {b && <AddressRow id="dest" label="To" value={dest} onChange={setDest} placeholder={custody === "own" ? "Your shielded u1… address" : `Your ${chainLabel(b.blockchain)} address`} invalid={destCheck ? !destCheck.ok : false} />}
        {a && <AddressRow id="refund" label="Refund" value={refund} onChange={setRefund} placeholder={`Your ${chainLabel(a.blockchain)} address`} invalid={refundCheck ? !refundCheck.ok : false} />}
      </AddressRows>
      <Hint>{hint}</Hint>
      {a && b && plan && !(same && custody === "own") && (
        <Details a={a} b={b} amount={sendNum} out={out} minOut={minOut} fee={KEEPER_CHIPS[custody][0]} eta={mode === "quiet" ? "random wait" : custody === "browser" ? "~40 min" : custody === "server" ? "~30 min" : "~10 min"} time={mode === "quiet" ? (custody === "own" ? "about 10 min in. Wait a while before you send out, up to 12 h" : "about 30 min in, then a random wait up to 12 h") : custody === "browser" ? "about 40 min: the tab proves hop two" : custody === "server" ? "about 30 min for both hops" : "about 10 min"} />
      )}
      {small && a && b && plan && <p className="fine">Small swaps lose more to fixed network fees. The exact amount comes with the quote.</p>}
      {custody === "server" && hostedInfo && (
        <p className="fine">
          Each hosted swap carries at most {formatUnits(BigInt(hostedInfo.max_zat), ZEC_DECIMALS)} ZEC. {hostedInfo.open} of {hostedInfo.max_open} slots in use.
          {mode === "quiet" && hostedInfo.split && " Quiet mode sends on in standard sizes. Up to 0.02 ZEC can stay behind."}
        </p>
      )}
      {custody === "browser" && !browserOff && (
        <p className="fine">The one-time wallet reads the chain through {new URL(config.lwdGrpcWebUrl ?? "https://x").host}, which sees this tab's IP.</p>
      )}
      <GoButton type="submit" disabled={!ready}>{busy ? busyText : label}</GoButton>
      <p className="fine">
        {api ? "Addresses are screened and the quote is signed by the Unpair API." : "The quote comes straight from the route, from your browser."}
        {config.lwdGrpcWebUrl && (
          <>
            {" "}
            <button type="button" className="link" disabled={busy} onClick={() => fileRef.current?.click()}>Have a recovery file?</button>
            <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void resumeFromFile(f); }} />
          </>
        )}
      </p>

      <TokenPicker
        open={picking !== null}
        title={picking === "in" ? "YOU SEND" : "YOU RECEIVE"}
        tokens={pickable}
        value={picking === "in" ? inId : outId}
        onClose={() => setPicking(null)}
        onPick={(t) => {
          if (picking) pickToken(picking, t);
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
  const [step, setStep] = useState<
    | { kind: "form" }
    | { kind: "quoted"; quote: QuoteResponse; signed: SignedQuote | null; verified: boolean | null; token: TokenInfo }
  >({ kind: "form" });

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
  const outPickable = useMemo(() => tokens.filter((t) => t.blockchain !== "zec"), [tokens]);
  function pickOut(t: TokenInfo) {
    if (b?.blockchain !== t.blockchain) setDest("");
    setOutId(t.assetId);
  }
  const refundZ = useZcashCheck(refund);
  const refundVerdict = refundZ ? describeRefundCheck(refundZ) : null;

  const goLabel = "SHOW THE ROUTE'S ADDRESS";
  let label = goLabel;
  if (!zec || !b) label = tokens.length ? "PICK A TOKEN" : "LOADING TOKENS";
  else if (b.blockchain === "zec") label = "PICK A DIFFERENT TOKEN";
  else if (!plan) label = "ENTER AN AMOUNT";
  else if (!destCheck?.ok) label = `ADD YOUR ${chainLabel(b.blockchain).toUpperCase()} ADDRESS`;
  else if (!refundVerdict?.ok) label = "ADD A ZCASH REFUND ADDRESS";
  const ready = label === goLabel && !busy;

  let hint: string | null = null;
  if (error) hint = error;
  else if (planError) hint = planError;
  else if (destCheck && !destCheck.ok) hint = destCheck.text;
  else if (refundVerdict && !refundVerdict.ok) hint = refundVerdict.text;

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

  function reset() {
    setStep({ kind: "form" });
    setError(null);
  }

  if (step.kind === "quoted") {
    return <OwnTracking quote={step.quote} signed={step.signed} verified={step.verified} token={step.token} direction="out" shielded={false} quiet={mode === "quiet"} onStage={onStage} onDone={reset} onSendOut={() => {}} />;
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) void go();
      }}
      noValidate
    >
      <CardHead tab="out" onTab={(t) => t === "in" && onSwapIn()} mode={mode} modes={MODES} onMode={setMode} slippage={slippage} slippages={SLIPPAGE_BPS} onSlippage={setSlippage} />
      <p className="knote">The second hop, from your own Zcash wallet. Pay from your shielded balance, never a transparent one, and wait a while after the first hop.</p>
      <Legs
        send={
          <Leg
            label="You send"
            htmlFor="out-amount"
            usd={zec && sendNum > 0 ? `$${fmt(sendNum * zec.price, 2)}` : ""}
            amount={<input id="out-amount" inputMode="decimal" autoComplete="off" placeholder="0" value={amount} onChange={(e) => setAmount(e.target.value)} />}
            token={<TokenButton fixed token={zec} label="You send ZEC" />}
            note={plan && plan.heldBack > 0n ? `Quiet sends ${formatUnits(plan.send, ZEC_DECIMALS)} ZEC.` : "Not the same amount you received."}
          />
        }
        get={
          <Leg
            second
            label="You get"
            usd={out > 0 && b ? `≈ $${fmt(out * b.price, 2)}` : ""}
            amount={<output aria-live="polite" className={out > 0 ? undefined : "zero"}>{out > 0 ? fmt(out) : "0"}</output>}
            token={<TokenButton token={b} label="Token you receive" onClick={() => setPicking(true)} />}
            picks={<QuickPicks tokens={outPickable} value={outId} onPick={pickOut} label="Quick picks to get" />}
          />
        }
      />
      <AddressRows>
        {b && <AddressRow id="out-dest" label="To" value={dest} onChange={setDest} placeholder={`Your ${chainLabel(b.blockchain)} address`} invalid={destCheck ? !destCheck.ok : false} />}
        <AddressRow id="out-refund" label="Refund" value={refund} onChange={setRefund} placeholder="A fresh address of your Zcash wallet" invalid={refundVerdict ? !refundVerdict.ok : false} />
      </AddressRows>
      <Hint>{hint}</Hint>
      {zec && b && plan && b.blockchain !== "zec" && (
        <Details a={zec} b={b} amount={sendNum} out={out} minOut={out * (1 - slippage / 10_000)} eta="~8 min" time="about 8 min after your payment confirms" />
      )}
      <GoButton type="submit" disabled={!ready}>{busy ? "GETTING A QUOTE" : label}</GoButton>
      <TokenPicker open={picking} title="YOU RECEIVE" tokens={outPickable} value={outId} onClose={() => setPicking(false)} onPick={(t) => { pickOut(t); setPicking(false); }} />
    </form>
  );
}

/** A quote the user pays from their own wallet, tracked on 1Click until it lands or returns. */
function OwnTracking({ quote, signed, verified, token, direction, shielded, quiet, onStage, onDone, onSendOut, second = false }: {
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
  /** Opened from a parked link on a second device: the check comes first, and no QR to scan. */
  second?: boolean;
}) {
  const q = quote.quote;
  const depositAddress = q.depositAddress ?? "";
  const memo = q.depositMemo;
  const [sent, setSent] = useState(false);
  const [parked, setParked] = useState<string | null>(null);
  const [parkError, setParkError] = useState<string | null>(null);
  const [phone, setPhone] = useState(false);
  const pollFn = useMemo(() => (depositAddress ? () => (api ? api.status(depositAddress, memo) : client.status(depositAddress, memo)) : null), [depositAddress, memo]);
  const [final, setFinal] = useState(false);
  const { value: status, error } = usePoll<StatusResponse>(pollFn, final);
  const current = stateOf(status);
  useEffect(() => {
    if (current === "landed" || current === "refunded" || current === "failed") setFinal(true);
  }, [current]);
  const seed = markSeed(signed, quote);
  const deadline = depositDeadline(quote);
  // the clock starts when the route made the quote, so a second device shows the same time
  const [start] = useState(() => {
    const t = Date.parse(quote.timestamp);
    return Number.isFinite(t) ? t : Date.now();
  });
  const elapsed = useElapsed(start, useEndTime(final));
  const inSym = direction === "out" ? "ZEC" : token.symbol;
  const outSym = direction === "in" ? "ZEC" : token.symbol;
  const txRows = (status?.swapDetails.destinationChainTxHashes ?? []).map((tx, i, all): Fact => [all.length > 1 ? `Transaction ${i + 1}` : "Transaction", <TxLink hash={tx.hash} url={tx.explorerUrl} />, true]);
  // a deposit that never comes: stop polling a while after the deadline and say so
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!deadline || final) return;
    const check = () => {
      if (Date.now() > deadline.getTime() + 20 * 60_000) {
        setLate(true);
        setFinal(true);
      }
    };
    check();
    const t = window.setInterval(check, 60_000);
    return () => window.clearInterval(t);
  }, [deadline, final]);

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
      setParkError(describeError(e));
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
        <Facts rows={[
          ["Sent", `${q.amountInFormatted} ${inSym}`, true],
          current === "landed" && ["Got", `${q.amountOutFormatted} ${outSym}`, true],
          ["To", short(quote.quoteRequest.recipient), true],
          ...txRows,
          ["Time", elapsed],
        ]} />
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
        {second ? (
          <VerifyHero seed={seed} code={shortCode(seed)} verified={Boolean(signed && verified)} />
        ) : (
          <VerifyStrip
            seed={seed}
            code={shortCode(seed)}
            signedBy={signed && verified ? "Signed by Unpair" : "Signed by the route"}
            {...(api && signed ? { onPhone: () => { setPhone(true); if (!parked) void park(); } } : {})}
          />
        )}
        <div className="box"><span className="lbl">Send exactly</span><div className="big">{q.amountInFormatted} {direction === "out" ? "ZEC" : token.symbol}</div></div>
        <div className="box"><span className="lbl">You get</span><div className="big">{q.amountOutFormatted} {direction === "out" ? token.symbol : "ZEC"}</div></div>
        <div className="box"><span className="lbl">{direction === "out" ? "To the route's Zcash address, once" : "To this address, once"}</span><Address value={depositAddress} qr={!second} /></div>
        {memo && <div className="box"><span className="lbl">With this memo</span><div className="code">{memo}</div></div>}
        {deadline && <p className="fine">Pay by {deadline.toLocaleTimeString()}. The address bar must say {new URL(config.officialOrigin).host}.</p>}
        <Mascot>{direction === "out" ? "Pay from your shielded balance, not from a transparent one, or the hop is linkable." : "I'm waiting at the edge. Send from any wallet you control."}</Mascot>
        <PhoneCheck open={phone} url={parked} error={parkError} seed={seed} code={shortCode(seed)} onClose={() => setPhone(false)} />
        <GoButton onClick={() => { setSent(true); onStage("seen"); }}>I SENT IT!</GoButton>
        <p className="fine"><button type="button" className="link" onClick={onDone}>Start over</button></p>
      </div>
    );
  }
  const strip = current === "waiting_for_deposit" ? 0 : current === "routing" ? 1 : 2;
  return (
    <div>
      <div className="wtitle"><b>IN PROGRESS</b><span className="code">{shortCode(seed)}</span></div>
      <StatusStrip current={strip} texts={direction === "in"
        ? { 0: depositWait(token.blockchain), 1: "The route swaps it into ZEC and pays your address.", 2: `Lands in your wallet. ${POOL_WAIT}`, 3: "Yours. Send out from your wallet later." }
        : { 0: "Waits for your Zcash payment to confirm.", 1: "Credited about 10 min after it confirms.", 2: "The route fills your swap.", 3: "Your asset arrives at your address." }} />
      <Facts rows={[
        ["Send", `${q.amountInFormatted} ${inSym}`, true],
        ["Get about", `${q.amountOutFormatted} ${outSym}`, true],
        ["To", short(quote.quoteRequest.recipient), true],
        ...txRows,
        ["Time", elapsed],
      ]} />
      {error && <p className="err-line">Status check failed, retrying: {error}</p>}
      {late ? (
        <p className="fine">The deadline passed and nothing arrived. If you paid late, the route refunds your deposit to the refund address.</p>
      ) : (
        <p className="fine">Keep this page open until the swap completes.</p>
      )}
      <p className="fine"><button type="button" className="link" onClick={onDone}>Start over</button></p>
    </div>
  );
}

/** A hosted swap, from deposit to delivery. The tab may close and come back by link. `second` is the phone check, opened from the QR. */
function HostedTracking({ id, first, signed, tokens, verified, second = false, onStage, onDone }: { id: string; first?: HostedSwap; signed?: SignedQuote; tokens: TokenInfo[]; verified: boolean | null; second?: boolean; onStage: (s: HeroStage) => void; onDone: () => void }) {
  const [sent, setSent] = useState(false);
  const [phone, setPhone] = useState(false);
  const pollFn = useMemo(() => {
    const a = api;
    return a ? () => a.hostedSwap(id) : null;
  }, [id]);
  const [initial] = useState<HostedSwap | null>(first ?? null);
  const [final, setFinal] = useState(false);
  const { value: polled, error } = usePoll<HostedSwap>(pollFn, final);
  const swap = polled ?? initial;
  const state = swap?.state;
  useEffect(() => {
    if (state && isHostedFinal(state)) setFinal(true);
  }, [state]);
  const elapsed = useElapsed(swap ? swap.created_unix * 1000 : null, final && swap ? swap.updated_unix * 1000 : null);

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
  // the mark comes from the deposit address, which the phone reads from the server too, so both screens draw the same one
  const seed = swap.deposit_address.slice(0, 16);
  const outLabel = `${outToken?.symbol ?? ""} on ${chainLabel(outToken?.blockchain ?? "")}`;

  if (final) {
    return (
      <div>
        {swap.state === "done" ? <DoneBurst /> : <div className="wtitle"><b>{copy.label.toUpperCase()}</b></div>}
        <p style={{ margin: 0, font: "700 15px var(--ui)" }}>
          {swap.state === "done"
            ? swap.parts_total > 1
              ? `${outToken?.symbol ?? ""} arrived on ${chainLabel(outToken?.blockchain ?? "")} in ${swap.parts_total} parts. On chain, nothing links them to your deposit or to each other.`
              : `${swap.delivered_amount ?? ""} ${outToken?.symbol ?? ""} arrived on ${chainLabel(outToken?.blockchain ?? "")}. On chain, nothing links it to your deposit.`
            : copy.text}
        </p>
        <Facts rows={[
          ["Sent", amountIn, true],
          swap.delivered_amount && ["Got", `${swap.delivered_amount} ${outToken?.symbol ?? ""}`, true],
          !swap.delivered_amount && ["Receive", outLabel],
          ["To", short(swap.destination_address), true],
          swap.parts_total > 1 && ["Parts", `${swap.parts_delivered} of ${swap.parts_total}`, true],
          swap.delivered_tx && ["Transaction", short(swap.delivered_tx), true],
          ["Time", elapsed],
          ["Swap id", short(swap.id), true],
        ]} />
        {swap.note && <p className="fine">{swap.note}</p>}
        {swap.dust_zat !== null && swap.dust_zat > 0 && <p className="fine">{formatUnits(BigInt(swap.dust_zat), ZEC_DECIMALS)} ZEC under the smallest size stays behind.</p>}
        {swap.state === "done" && <Mascot face="happy" red={false}>I stayed in the school. A fresh fish swam out to your address. The server saw both ends and forgets this swap in seven days.</Mascot>}
        <GoButton ghost onClick={onDone}>NEW SWAP</GoButton>
      </div>
    );
  }
  if (!sent && swap.state === "waiting_for_deposit") {
    return (
      <div>
        <div className="wtitle"><b>SEND IT!</b><span className="chip">on {chainLabel(inToken?.blockchain ?? "")}</span></div>
        {second ? (
          <VerifyHero seed={seed} code={shortCode(seed)} verified={null} note="Loaded from the Unpair server. Same mark and code on both screens means the same swap and the same deposit address." />
        ) : (
          <VerifyStrip seed={seed} code={shortCode(seed)} signedBy={verified ? "Signed by Unpair" : "Quote from the server"} {...(api ? { onPhone: () => setPhone(true) } : {})} />
        )}
        <div className="box"><span className="lbl">Send exactly</span><div className="big">{amountIn}</div></div>
        {swap.estimate_out && <YouGet value={`${fmt(Number(swap.estimate_out))} ${outToken?.symbol ?? ""}`} />}
        <div className="box"><span className="lbl">To this address, once</span><Address value={swap.deposit_address} qr={!second} /></div>
        {swap.deposit_memo && <div className="box"><span className="lbl">With this memo</span><div className="code">{swap.deposit_memo}</div></div>}
        <p className="fine">Pay by {new Date(swap.deposit_deadline_unix * 1000).toLocaleString()}.</p>
        <div className="box"><span className="lbl">Your link to this swap</span><Address value={link} /><p className="fine">Anyone with the link sees the progress, the deposit address and your receiving address. Keep it to yourself.</p></div>
        <Mascot>You can close the tab after you pay. The server swims it through for you.</Mascot>
        <PhoneCheck open={phone} url={`${link}&check=1`} error={null} seed={seed} code={shortCode(seed)} onClose={() => setPhone(false)} />
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
      <StatusStrip current={stage < 0 ? 0 : stage} texts={{
        0: depositWait(inToken?.blockchain ?? ""),
        1: "The route swaps it into ZEC for the server.",
        2: poolText ?? (swap.mode === "quiet" ? `${POOL_WAIT} Then a random wait.` : POOL_WAIT),
        3: swap.parts_total > 1 ? `${swap.parts_delivered} of ${swap.parts_total} parts paid. ${OUT_WAIT}` : OUT_WAIT,
      }} />
      <Facts rows={[
        ["Sent", amountIn, true],
        ["Receive", outLabel],
        swap.estimate_out && !swap.delivered_amount && ["Get about", `${fmt(Number(swap.estimate_out))} ${outToken?.symbol ?? ""}`, true],
        ["To", short(swap.destination_address), true],
        swap.zec_received !== null && ["In the pool", `${formatUnits(BigInt(swap.zec_received), ZEC_DECIMALS)} ZEC`, true],
        swap.parts_total > 1 && ["Parts", `${swap.parts_delivered} of ${swap.parts_total} delivered`, true],
        swap.hop2_txid && ["Zcash tx", short(swap.hop2_txid), true],
        ["Time", elapsed],
      ]} />
      {swap.dust_zat !== null && swap.dust_zat > 0 && <p className="fine">{formatUnits(BigInt(swap.dust_zat), ZEC_DECIMALS)} ZEC under the smallest size stays behind.</p>}
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
  return <OwnTracking quote={signed.quote.quote} signed={signed.quote} verified={signed.verified} token={token} direction={direction} shielded={false} quiet={false} onStage={onStage} onDone={onDone} onSendOut={onDone} second />;
}
