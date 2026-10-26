/**
 * A swap whose Zcash wallet runs inside this tab.
 *
 * Hop one lands at the wallet's shielded address. The wallet scans until the
 * note is spendable, waits in quiet mode, then quotes hop two and pays it
 * from Ironwood. The tab must stay open; the recovery file reopens the
 * wallet in a new tab and finishes from the pool.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ZEC_DECIMALS, formatUnits, roundDownSignificant, scheduleRelease, type QuoteInput, type QuoteResponse, type StatusResponse, type TokenInfo } from "@unpair/sdk";
import { STATE_COPY, depositDeadline, stateOf, type Mode, type SignedQuote } from "@unpair/client";
import { api, client, config, describeError, markSeed, screenAndQuote, shortCode, usePoll } from "./core";
import { Address, DoneBurst, Facts, GoButton, Mascot, OUT_WAIT, POOL_WAIT, StatusStrip, VerifyStrip, YouGet, depositWait, short, useElapsed, useEndTime, type HeroStage } from "./ui";
import { chainLabel } from "./ui/tokens";
import { offerDownload, type BrowserWallet, type Recovery, type RecoveryPlan } from "./wallet/browserWallet";
import type { Balance, Landing, Upgrade } from "./wallet/types";
import { hop2FeeReserveZat } from "./wallet/fees";

const SYNC_EVERY_MS = 30_000;

type Phase = "recover" | "deposit" | "pool" | "out" | "done";

/** Quiet mode waits a random time before hop two: exponential, mean about 3 h, capped at 12 h, the same draw as the server. */
function randomWaitMs(): number {
  return scheduleRelease(new Date()).delayMs;
}

type Props = {
  wallet: BrowserWallet;
  tokens: TokenInfo[];
  onStage: (s: HeroStage) => void;
  onDone: () => void;
} & (
  | ({ landing: Landing; outToken: TokenInfo; dest: string; slippage: number; mode: Mode; recovery?: undefined } & (
      /** Hop one through the route, paid in `token`. */
      | { quote: QuoteResponse; signed: SignedQuote | null; verified: boolean | null; token: TokenInfo }
      /** No hop one: the user pays the tab's own address with ZEC they hold. */
      | { quote?: undefined; signed?: undefined; verified?: undefined; token?: undefined }
    ))
  | { recovery: Recovery; landing?: undefined }
);

export function BrowserSwap(props: Props) {
  const { wallet, tokens, onStage, onDone } = props;
  const fresh = props.recovery === undefined;
  const plan: RecoveryPlan | null = fresh
    ? { destinationAsset: props.outToken.assetId, recipient: props.dest, mode: props.mode, slippageBps: props.slippage }
    : (props.recovery.plan ?? null);
  // the plan is rebuilt on every render, so effects read it through a ref and never re-run because of it
  const planRef = useRef(plan);
  planRef.current = plan;
  const outToken = useMemo(() => (plan ? (tokens.find((t) => t.assetId === plan.destinationAsset) ?? null) : null), [tokens, plan?.destinationAsset]);
  const zec = useMemo(() => tokens.find((t) => t.blockchain === "zec" && t.symbol === "ZEC") ?? null, [tokens]);

  const [phase, setPhase] = useState<Phase>(fresh ? "recover" : "pool");
  const [saved, setSaved] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [balance, setBalance] = useState<Balance | null>(null);
  const [upgrade, setUpgrade] = useState<Upgrade | null>(null);
  const [releaseAt, setReleaseAt] = useState<number | null>(null);
  const [hop2, setHop2] = useState<{ quote: QuoteResponse; txid: string | null; signed: SignedQuote | null; verified: boolean | null } | null>(null);
  const [hop2Final, setHop2Final] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  // what a dry hop-two quote says this swap delivers, asked once for the deposit screen
  const [estimate, setEstimate] = useState<string | null>(null);
  const estimateAsked = useRef(false);
  useEffect(() => {
    const quote0 = props.recovery === undefined ? props.quote : undefined;
    const landing0 = props.recovery === undefined ? props.landing : undefined;
    if (phase !== "deposit" || !quote0 || !landing0 || !plan || !outToken || !zec || estimateAsked.current) return;
    estimateAsked.current = true;
    let amount = BigInt(quote0.quote.amountOut) - hop2FeeReserveZat(1);
    if (plan.mode === "quiet" && amount > 0n) amount = roundDownSignificant(amount, 2).amount;
    if (amount <= 0n) return;
    const deadlineIso = new Date(Date.now() + 15 * 60_000).toISOString();
    const request: QuoteInput = {
      swapType: "EXACT_INPUT",
      slippageTolerance: plan.slippageBps,
      originAsset: zec.assetId,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: outToken.assetId,
      amount: amount.toString(),
      refundTo: landing0.transparent,
      refundType: "ORIGIN_CHAIN",
      recipient: plan.recipient,
      recipientType: "DESTINATION_CHAIN",
      deadline: new Date(deadlineIso),
      dry: true,
    };
    let alive = true;
    const ask = api ? api.quote({ ...request, deadline: deadlineIso, dry: true }).then((s) => s.quote) : client.dryQuote(request);
    ask.then((r) => alive && setEstimate(r.quote.amountOutFormatted ?? null)).catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, props, outToken, zec]);
  const outStarted = useRef(false);
  // bumped by the retry button, the only thing that may start hop two again after a failure
  const [attempt, setAttempt] = useState(0);
  // a reopened swap counts from when its recovery file was written
  const [start] = useState(() => {
    const t = fresh ? NaN : Date.parse(props.recovery.created);
    return Number.isFinite(t) ? t : Date.now();
  });
  const elapsed = useElapsed(start, useEndTime(phase === "done"));

  // leaving the tab while coins are in it loses them unless the recovery file was saved
  useEffect(() => {
    if (phase !== "pool" && phase !== "out") return;
    const guard = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [phase]);

  useEffect(() => {
    const map: Record<Phase, HeroStage> = { recover: "deposit", deposit: "deposit", pool: "pool", out: "out", done: "done" };
    onStage(phase === "deposit" && sent ? "seen" : map[phase]);
  }, [phase, sent, onStage]);

  // Hop one, tracked on the route until it lands at the wallet's address.
  const hop1 = fresh ? (props.quote ?? null) : null;
  const depositAddress = hop1?.quote.depositAddress ?? "";
  const memo = hop1?.quote.depositMemo;
  const pollHop1 = useMemo(() => (depositAddress ? () => (api ? api.status(depositAddress, memo) : client.status(depositAddress, memo)) : null), [depositAddress, memo]);
  const { value: status1, error: pollError1 } = usePoll<StatusResponse>(pollHop1, phase !== "deposit");
  const state1 = stateOf(status1);
  useEffect(() => {
    if (phase !== "deposit") return;
    if (state1 === "landed") setPhase("pool");
    else if (state1 === "refunded" || state1 === "failed") setPhase("done");
  }, [phase, state1]);
  useEffect(() => {
    if (phase === "deposit" && state1 === "routing") onStage("into");
  }, [phase, state1, onStage]);

  // In the pool: scan until the note is spendable, then wait or send. The
  // scan also runs while the deposit is awaited, so ZEC paid straight to the
  // tab's address is noticed even if hop one was never used.
  useEffect(() => {
    if (phase !== "pool" && phase !== "deposit") return;
    let alive = true;
    let timer: number | null = null;
    const tick = async () => {
      try {
        const tip = await wallet.sync();
        const b = await wallet.balance();
        const u = await wallet.upgradeNotice(tip);
        if (!alive) return;
        setBalance(b);
        setUpgrade(u);
        setError(null);
      } catch (e) {
        if (alive) setError(describeError(e));
      }
      if (alive) timer = window.setTimeout(() => void tick(), SYNC_EVERY_MS);
    };
    void tick();
    return () => {
      alive = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [phase, wallet]);

  useEffect(() => {
    if (phase === "deposit" && balance && balance.ironwood_total > 0) setPhase("pool");
  }, [phase, balance]);

  const spendable = BigInt(balance?.ironwood_spendable ?? 0);
  // the fee grows with the notes spent, so the reserve follows the note count
  const canSend = spendable > hop2FeeReserveZat(balance?.ironwood_notes ?? 1) && !(upgrade?.sending_paused ?? false);
  useEffect(() => {
    if (phase !== "pool" || !canSend || !plan) return;
    if (plan.mode === "fast") {
      setPhase("out");
      return;
    }
    if (releaseAt === null) {
      setReleaseAt(Date.now() + randomWaitMs());
      return;
    }
    const left = releaseAt - Date.now();
    if (left <= 0) {
      setPhase("out");
      return;
    }
    const t = window.setTimeout(() => setPhase("out"), Math.min(left, 2_147_000_000));
    return () => window.clearTimeout(t);
  }, [phase, canSend, plan?.mode, releaseAt]);

  // Hop two: quote ZEC to the asset the user chose, pay it from Ironwood, broadcast.
  useEffect(() => {
    if (phase !== "out" || outStarted.current) return;
    outStarted.current = true;
    const run = async () => {
      try {
        const plan = planRef.current;
        if (!plan || !outToken || !zec) throw new Error("The swap has no second hop. The recovery file names no destination.");
        // a fresh look at the balance: a retry after a failed or refunded hop two must not quote a stale amount
        setWorking("Checking the balance.");
        await wallet.sync();
        const b = await wallet.balance();
        setBalance(b);
        let amount = BigInt(b.ironwood_spendable) - hop2FeeReserveZat(b.ironwood_notes);
        if (amount <= 0n) throw new Error("Nothing to send.");
        // quiet mode sends an amount cut to two digits, so the two hops do not match to the unit; the rest, under a tenth, stays in this wallet
        if (plan.mode === "quiet") amount = roundDownSignificant(amount, 2).amount;
        setWorking("Asking the route for a quote.");
        const landing = await wallet.nextLanding();
        const request: QuoteInput = {
          swapType: "EXACT_INPUT",
          slippageTolerance: plan.slippageBps,
          originAsset: zec.assetId,
          depositType: "ORIGIN_CHAIN",
          destinationAsset: outToken.assetId,
          amount: amount.toString(),
          refundTo: landing.transparent,
          refundType: "ORIGIN_CHAIN",
          recipient: plan.recipient,
          recipientType: "DESTINATION_CHAIN",
          deadline: new Date(Date.now() + 30 * 60_000),
        };
        const r = await screenAndQuote(request, ["zec", outToken.blockchain]);
        if ("refused" in r) throw new Error(r.refused);
        const to = r.quote.quote.depositAddress;
        if (!to) throw new Error("The route gave no address to pay.");
        setHop2({ quote: r.quote, txid: null, signed: r.signed, verified: r.verified });
        setWorking("Proving and sending the Zcash transaction. This takes a minute.");
        const paid = await wallet.pay(to, BigInt(r.quote.quote.amountIn));
        setHop2((h) => (h ? { ...h, txid: paid.txid } : h));
        setWorking(null);
        // built and stored, broadcast unsure: keep the txid, watch the route, and leave the retry open
        if (paid.broadcast_error) setError("The transaction was built but sending it did not confirm. It may still be on the chain. The page keeps watching the route.");
      } catch (e) {
        setError(describeError(e));
        setWorking(null);
        outStarted.current = false;
      }
    };
    void run();
  }, [phase, attempt, outToken, zec, wallet]);

  const hop2Address = hop2?.txid ? (hop2.quote.quote.depositAddress ?? "") : "";
  const hop2Memo = hop2?.quote.quote.depositMemo;
  const pollHop2 = useMemo(() => (hop2Address ? () => (api ? api.status(hop2Address, hop2Memo) : client.status(hop2Address, hop2Memo)) : null), [hop2Address, hop2Memo]);
  const { value: status2, error: pollError2 } = usePoll<StatusResponse>(pollHop2, hop2Final);
  const state2 = stateOf(status2);
  useEffect(() => {
    if (state2 === "landed" || state2 === "refunded" || state2 === "failed") {
      setHop2Final(true);
      setPhase("done");
    }
  }, [state2]);

  async function download() {
    try {
      const f = await wallet.recovery(plan ?? undefined);
      offerDownload(f.name, f.text);
      setSaved(true);
    } catch (e) {
      setError(describeError(e));
    }
  }

  async function shieldRefund() {
    setWorking("Shielding the refund.");
    try {
      await wallet.shield();
      setHop2(null);
      setHop2Final(false);
      outStarted.current = false;
      setReleaseAt(null);
      setPhase("pool");
    } catch (e) {
      setError(describeError(e));
    } finally {
      setWorking(null);
    }
  }

  function retryOut() {
    setError(null);
    setHop2(null);
    setHop2Final(false);
    outStarted.current = false;
    setPhase("out");
    setAttempt((a) => a + 1);
  }

  const startOver = <p className="fine"><button type="button" className="link" onClick={onDone}>Start over</button></p>;

  if (phase === "recover" && fresh) {
    return (
      <div>
        <div className="wtitle"><b>SAVE THE RECOVERY FILE</b><span className="chip">before you deposit</span></div>
        <p style={{ margin: 0, font: "700 15px var(--ui)" }}>This tab now holds a one-time Zcash wallet, made for this one swap. The file holds its key and where the swap goes next. It is the only way back in if the tab closes before the swap is done.</p>
        <Mascot>Keep the file where only you can read it. Anyone with it can spend what lands in this wallet.</Mascot>
        {error && <p className="err-line">{error}</p>}
        <GoButton onClick={() => void download()}>{saved ? "DOWNLOAD IT AGAIN" : "DOWNLOAD THE RECOVERY FILE"}</GoButton>
        <GoButton ghost disabled={!saved} onClick={() => setPhase("deposit")}>I SAVED IT. SHOW THE DEPOSIT ADDRESS</GoButton>
        {startOver}
      </div>
    );
  }

  if (phase === "deposit" && fresh && !props.quote) {
    return (
      <div>
        <div className="wtitle"><b>PAY THE TAB</b><span className="chip">from your Zcash wallet</span></div>
        <p style={{ margin: 0, font: "700 15px var(--ui)" }}>Send the ZEC you want to move to this tab's shielded address, from Zodl, Zingo, Zkool or any wallet. Once it lands, the tab sends it on to {outToken?.symbol ?? "your asset"} on {chainLabel(outToken?.blockchain ?? "")} at your address.</p>
        <div className="box"><span className="lbl">One-time wallet address, shielded</span><Address value={props.landing.shielded} qr /></div>
        <Mascot>Pay from a shielded balance. Any amount works; the tab sends on what lands, minus the network fee.</Mascot>
        <GoButton onClick={() => setPhase("pool")}>I SENT IT!</GoButton>
        {startOver}
      </div>
    );
  }

  if (phase === "deposit" && fresh && props.quote) {
    const q = props.quote.quote;
    const seed = markSeed(props.signed, props.quote);
    const deadline = depositDeadline(props.quote);
    if (!sent && state1 === "waiting_for_deposit") {
      return (
        <div>
          <div className="wtitle"><b>SEND IT!</b><span className="chip">on {chainLabel(props.token.blockchain)}</span></div>
          <VerifyStrip seed={seed} code={shortCode(seed)} signedBy={props.signed && props.verified ? "Signed by Unpair" : "Signed by the route"} />
          <div className="box"><span className="lbl">Send exactly</span><div className="big">{q.amountInFormatted} {props.token.symbol}</div></div>
          {estimate && <YouGet value={`${estimate} ${outToken?.symbol ?? ""}`} />}
          <div className="box"><span className="lbl">To this address, once</span><Address value={depositAddress} qr /></div>
          {memo && <div className="box"><span className="lbl">With this memo</span><div className="code">{memo}</div></div>}
          {deadline && <p className="fine">Pay by {deadline.toLocaleTimeString()}. The address bar must say {new URL(config.officialOrigin).host}.</p>}
          <Mascot>The route pays this tab's shielded address. Keep the tab open; I do the rest here.</Mascot>
          <GoButton onClick={() => setSent(true)}>I SENT IT!</GoButton>
          <details className="det">
            <summary><span>Already hold ZEC?</span><span className="code">DIRECT</span></summary>
            <p className="fine">Send any amount of ZEC from your own wallet to this tab's shielded address instead. That skips the first hop. Once it lands, the tab sends it on to {outToken?.symbol ?? "your asset"} as planned.</p>
            <div className="box"><span className="lbl">One-time wallet address, shielded</span><Address value={props.landing.shielded} qr /></div>
            <GoButton ghost onClick={() => setPhase("pool")}>I SENT ZEC DIRECTLY</GoButton>
          </details>
          {startOver}
        </div>
      );
    }
    return (
      <div>
        <div className="wtitle"><b>IN PROGRESS</b><span className="code">{shortCode(seed)}</span></div>
        <StatusStrip current={state1 === "waiting_for_deposit" ? 0 : 1} texts={{ 0: depositWait(props.token.blockchain), 1: "The route swaps it into ZEC and pays this tab's wallet.", 2: POOL_WAIT, 3: OUT_WAIT }} />
        <Facts rows={[
          ["Send", `${q.amountInFormatted} ${props.token.symbol}`, true],
          ["Receive", `${outToken?.symbol ?? ""} on ${chainLabel(outToken?.blockchain ?? "")}`],
          ["To", short(props.dest), true],
          ["Time", elapsed],
        ]} />
        {pollError1 && <p className="err-line">Status check failed, retrying: {pollError1}</p>}
        <p className="fine">Keep this page open until the swap completes. ZEC sent straight to the tab's address is picked up here too.</p>
        <GoButton ghost onClick={() => setPhase("pool")}>I PAID THE TAB'S ADDRESS INSTEAD</GoButton>
      </div>
    );
  }

  if (phase === "pool" || phase === "out") {
    const inPool = balance ? formatUnits(BigInt(balance.ironwood_total), ZEC_DECIMALS) : null;
    const release = releaseAt ? new Date(releaseAt) : null;
    const poolText = phase === "out"
      ? (working ?? "Paying hop two.")
      : !balance
        ? "Scanning the chain for the landed note."
        : balance.ironwood_total === 0
          ? "Nothing has landed yet. Watching the chain."
          : spendable === 0n
            ? `${inPool} ZEC landed. ${POOL_WAIT}`
          : upgrade?.sending_paused
            ? `Sending pauses around the ${upgrade.name} upgrade at block ${upgrade.height}. It resumes after.`
            : release && release.getTime() > Date.now()
              ? `${inPool} ZEC in the pool. Sends on at about ${release.toLocaleTimeString()}.`
              : `${inPool} ZEC in the pool. Sending on.`;
    return (
      <div>
        <div className="wtitle"><b>{phase === "out" ? "HOP TWO" : "IN THE POOL"}</b>{balance?.scanned_to ? <span className="code">block {balance.scanned_to}</span> : null}</div>
        <StatusStrip current={phase === "out" ? 3 : 2} texts={{ 0: "Deposit seen.", 1: "Swapped into ZEC.", 2: poolText, 3: phase === "out" ? (hop2?.txid ? OUT_WAIT : poolText) : OUT_WAIT }} />
        <Facts rows={[
          inPool !== null && ["In the pool", `${inPool} ZEC`, true],
          plan && outToken && ["Receive", `${outToken.symbol} on ${chainLabel(outToken.blockchain)}`],
          plan && ["To", short(plan.recipient), true],
          hop2?.txid && ["Zcash tx", short(hop2.txid), true],
          ["Time", elapsed],
        ]} />
        {hop2?.txid && plan?.mode === "quiet" && <p className="fine">Quiet mode sent a rounded amount. The small rest stays in this wallet, and the recovery file can spend it.</p>}
        {error && <p className="err-line">{error}</p>}
        {phase === "out" && error && <GoButton onClick={retryOut}>TRY HOP TWO AGAIN</GoButton>}
        {phase === "pool" && release && canSend && <GoButton onClick={() => setPhase("out")}>SEND NOW INSTEAD</GoButton>}
        {!fresh && (
          <p className="fine">Reopened from the recovery file. {plan && outToken ? `It sends ${outToken.symbol} on ${chainLabel(outToken.blockchain)} to ${plan.recipient.slice(0, 10)}…` : "It names no destination, so nothing can be sent."}</p>
        )}
        {pollError2 && <p className="err-line">Status check failed, retrying: {pollError2}</p>}
        <p className="fine">Keep this page open. If it closes, open the recovery file here to carry on.</p>
      </div>
    );
  }

  // Done, one way or another.
  const refunded1 = fresh && (state1 === "refunded" || state1 === "failed");
  const q2 = hop2?.quote.quote;
  return (
    <div>
      {state2 === "landed" ? <DoneBurst /> : <div className="wtitle"><b>{(refunded1 ? STATE_COPY[state1] : STATE_COPY[state2]).label.toUpperCase()}</b></div>}
      <p style={{ margin: 0, font: "700 15px var(--ui)" }}>
        {state2 === "landed" && q2 && outToken
          ? `${q2.amountOutFormatted} ${outToken.symbol} arrived on ${chainLabel(outToken.blockchain)}. Nothing links it to your deposit.`
          : refunded1
            ? "The first hop did not go through. The deposit returns to your refund address, minus network fees. Nothing reached this tab's wallet."
            : state2 === "refunded"
              ? "The route refunded hop two to this tab's wallet, at its transparent address. Shield it and try again, or keep the recovery file and send out later."
              : STATE_COPY[state2].text}
      </p>
      {(status1?.swapDetails.refundReason || status2?.swapDetails.refundReason) && <p className="err-line">Reason: {status2?.swapDetails.refundReason ?? status1?.swapDetails.refundReason}</p>}
      <Facts rows={[
        state2 === "landed" && q2 && outToken && ["Got", `${q2.amountOutFormatted} ${outToken.symbol}`, true],
        plan && ["To", short(plan.recipient), true],
        hop2?.txid && ["Zcash tx", short(hop2.txid), true],
        ["Time", elapsed],
      ]} />
      {state2 === "landed" && <Mascot face="happy" red={false}>The one-time wallet is empty now. Its key is forgotten when you leave. Keep the recovery file anyway until you have checked your balance.</Mascot>}
      {error && <p className="err-line">{error}</p>}
      {working && <p className="fine">{working}</p>}
      {state2 === "refunded" && <GoButton disabled={working !== null} onClick={() => void shieldRefund()}>SHIELD THE REFUND AND TRY AGAIN</GoButton>}
      {state2 === "failed" && <GoButton onClick={retryOut}>TRY HOP TWO AGAIN</GoButton>}
      <GoButton ghost onClick={onDone}>NEW SWAP</GoButton>
    </div>
  );
}
