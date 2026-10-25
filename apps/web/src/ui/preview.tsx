// UI preview at /ui.html in dev. It shows every part with a fake swap. Nothing is sent anywhere
// except the public 1Click token list.
import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { OneClickClient, type TokenInfo } from "@unpair/sdk";
import { chainLabel } from "./tokens";
import "./theme.css";
import {
  Address, DoneBurst, Footer, GoButton, Hero, InfoTiles, Mascot, Masthead, PLACEHOLDER, PoolDivider, QuoteMark,
  Sprites, StatusStrip, Story, Toggle, TokenButton, TokenPicker, WidgetPanel, checkShape, kindOf, type HeroStage,
} from "./index";

type Mode = "fast" | "quiet";
type Custody = "browser" | "server";
type View = "form" | "deposit" | "status" | "done";

const fmt = (v: number, d = 4) => v.toLocaleString("en-US", { maximumFractionDigits: d });
const round125 = (v: number) => {
  if (v <= 0) return 0;
  const e = 10 ** Math.floor(Math.log10(v));
  const m = v / e;
  return (m >= 5 ? 5 : m >= 2 ? 2 : 1) * e;
};
const STAGES: HeroStage[] = ["seen", "into", "pool", "out"];

function Preview() {
  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    new OneClickClient().getTokens().then(setTokens, (e: unknown) => setError(String(e)));
  }, []);
  const find = (sym: string, chain: string) => tokens.find((t) => t.symbol === sym && t.blockchain === chain) ?? null;

  const [mode, setMode] = useState<Mode>("fast");
  const [custody, setCustody] = useState<Custody>("browser");
  const [inId, setInId] = useState<string | null>(null);
  const [outId, setOutId] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [dest, setDest] = useState("");
  const [refund, setRefund] = useState("");
  const [picking, setPicking] = useState<"in" | "out" | null>(null);
  const [view, setView] = useState<View>("form");
  const [step, setStep] = useState(-1);

  useEffect(() => {
    if (tokens.length && !inId) {
      setInId(find("USDC", "base")?.assetId ?? tokens[0]!.assetId);
      setOutId(find("SOL", "sol")?.assetId ?? tokens[1]!.assetId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokens]);

  const a = useMemo(() => tokens.find((t) => t.assetId === inId) ?? null, [tokens, inId]);
  const b = useMemo(() => tokens.find((t) => t.assetId === outId) ?? null, [tokens, outId]);
  const raw = parseFloat(amount.replace(",", ".")) || 0;
  const amt = mode === "quiet" ? round125(raw) : raw;
  const out = a && b && b.price ? (amt * a.price * 0.995) / b.price : 0;
  const d = b ? checkShape(dest, b.blockchain, "receiving") : null;
  const r = a ? checkShape(refund, a.blockchain, "refund") : null;
  const same = !!a && a.assetId === b?.assetId;

  let label = "GET DEPOSIT ADDRESS";
  if (!a || !b) label = "LOADING TOKENS";
  else if (same) label = "PICK A DIFFERENT TOKEN";
  else if (!(amt > 0)) label = "ENTER AN AMOUNT";
  else if (!d?.ok) label = `ADD YOUR ${chainLabel(b.blockchain).toUpperCase()} ADDRESS`;
  else if (!r?.ok) label = "ADD A REFUND ADDRESS";
  const ready = label === "GET DEPOSIT ADDRESS";

  let tip: [string, "" | "ok" | "err"] = ["Pick what you send and what you want back. I swim through the pool in between.", ""];
  if (same) tip = ["Same token on the same chain? Pick something else to receive.", "err"];
  else if (d && !d.ok && !d.empty) tip = [d.message, "err"];
  else if (d?.ok && r && !r.ok && !r.empty) tip = [r.message, "err"];
  else if (d?.ok && r?.ok) tip = ["Ready! Get the deposit address.", "ok"];
  else if (d?.ok) tip = [`Got it! Now a refund address on ${chainLabel(a!.blockchain)}, just in case.`, "ok"];

  // fake status: one panel every 3.4 s; the hero's exiting fish ends it
  useEffect(() => {
    if (view !== "status" || step >= 3) return;
    const t = setTimeout(() => setStep((s) => s + 1), 3400);
    return () => clearTimeout(t);
  }, [view, step]);

  const stage: HeroStage = view === "form" ? "form" : view === "deposit" ? "deposit" : view === "done" ? "done" : STAGES[Math.max(0, step)]!;
  const code = "7Q4K-2M9X";
  const depositAddr = "0x8b1d0e2a77c4f9e03b5a61d2c8e4f07a9b3c2d10";

  return (
    <>
      <Sprites />
      <Masthead />
      <main className="page">
        <Hero stage={stage} quiet={mode === "quiet"} onOut={() => setView("done")} />
        <WidgetPanel>
          {error && <p className="err-line">Token list failed: {error}</p>}
          {view === "form" && (
            <form onSubmit={(e) => { e.preventDefault(); if (ready) setView("deposit"); }} noValidate>
              <div className="wtitle"><b>UNPAIR A SWAP</b><span className="code">FEE 0.5%</span></div>
              <div className="row2">
                <Toggle small label="Mode" value={mode} onChange={setMode} options={[{ value: "fast", title: "Fast", hint: "~5 min" }, { value: "quiet", title: "Quiet", hint: "random delay" }]} />
                <Toggle small label="Who holds the coins in between" value={custody} onChange={setCustody} options={[{ value: "browser", title: "My browser", hint: "you hold it" }, { value: "server", title: "Unpair server", hint: "we hold it" }]} />
              </div>
              <p className={custody === "server" ? "custody-note warn" : "custody-note"}>
                {custody === "server" ? "Our server holds your coins between the two swaps and can see both ends. You can close the tab." : "Your browser holds the key. Keep this tab open until OUT!, or save the recovery file."}
              </p>
              <div className="box pay">
                <div className="kv"><label htmlFor="amount">You send</label><span className="meta" style={{ margin: 0 }}>${fmt(raw * (a?.price ?? 0), 2)}</span></div>
                <div className="amt">
                  <input id="amount" inputMode="decimal" autoComplete="off" placeholder="0" value={amount} onChange={(e) => setAmount(e.target.value)} />
                  <TokenButton token={a} label="Token you send" onClick={() => setPicking("in")} />
                </div>
                <div className="meta"><span>{mode === "quiet" && raw > 0 && amt !== raw ? `Quiet mode rounds down to ${fmt(amt, 8)}` : ""}</span></div>
              </div>
              <PoolDivider onFlip={() => { setInId(outId); setOutId(inId); setDest(""); setRefund(""); }} />
              <div className="box pay">
                <div className="kv"><span className="lbl">You receive</span><span className="meta" style={{ margin: 0 }}>{out > 0 && b ? `≈ $${fmt(out * b.price, 2)}` : ""}</span></div>
                <div className="amt">
                  <output aria-live="polite">{out > 0 ? fmt(out) : "0"}</output>
                  <TokenButton token={b} label="Token you receive" onClick={() => setPicking("out")} />
                </div>
                <div className="meta"><span>from a fresh source</span></div>
              </div>
              {a && b && amt > 0 && !same && (
                <details className="det">
                  <summary><span>1 {a.symbol} ≈ {fmt((a.price * 0.995) / b.price, 6)} {b.symbol}</span><span className="code">DETAILS</span></summary>
                  <dl>
                    <dt>Route</dt><dd>{a.symbol} · {chainLabel(a.blockchain)} → ZEC pool → {b.symbol} · {chainLabel(b.blockchain)}</dd>
                    <dt>Min. received</dt><dd>{fmt(out * 0.99)} {b.symbol}</dd>
                    <dt>Unpair fee</dt><dd>0.5% · ${fmt(amt * a.price * 0.005, 2)}</dd>
                    <dt>Time</dt><dd>{mode === "quiet" ? "random, up to 12 h" : "~5 min"}</dd>
                  </dl>
                </details>
              )}
              {b && (
                <div className="box field"><label htmlFor="dest">Send it to ({chainLabel(b.blockchain)} address)</label>
                  <div className="row"><input id="dest" autoComplete="off" spellCheck={false} placeholder={PLACEHOLDER[kindOf(b.blockchain)]} value={dest} onChange={(e) => setDest(e.target.value)} aria-invalid={d ? !d.ok && !d.empty : false} /></div></div>
              )}
              {a && d?.ok && (
                <div className="box field"><label htmlFor="refund">Refund address ({chainLabel(a.blockchain)})</label>
                  <div className="row"><input id="refund" autoComplete="off" spellCheck={false} placeholder={PLACEHOLDER[kindOf(a.blockchain)]} value={refund} onChange={(e) => setRefund(e.target.value)} /></div></div>
              )}
              <Mascot tone={tip[1]}>{tip[0]}</Mascot>
              <GoButton type="submit" disabled={!ready}>{label}</GoButton>
              <p className="fine">UI preview. No real swap happens here.</p>
            </form>
          )}
          {view === "deposit" && a && (
            <div>
              <div className="wtitle"><b>SEND IT!</b><span className="chip">on {chainLabel(a.blockchain)}</span></div>
              <div className="markrow"><QuoteMark seed={code} /><div><b>Quote signed by Unpair</b> <span className="code">{code}</span></div></div>
              <div className="box"><span className="lbl">Send exactly</span><div className="big">{amt.toFixed(Math.min(a.decimals, 8))} {a.symbol}</div></div>
              <div className="box"><span className="lbl">To this address, once</span><Address value={depositAddr} /></div>
              <Mascot>I'm waiting at the edge. The address bar must say unpair.xyz.</Mascot>
              <GoButton onClick={() => { setStep(0); setView("status"); }}>I SENT IT!</GoButton>
            </div>
          )}
          {view === "status" && (
            <div>
              <div className="wtitle"><b>IN PROGRESS</b><span className="code">{code}</span></div>
              <StatusStrip current={step} />
            </div>
          )}
          {view === "done" && b && (
            <div>
              <DoneBurst />
              <p style={{ margin: 0, font: "700 15px var(--ui)" }}>{fmt(out)} {b.symbol} arrived on {chainLabel(b.blockchain)}. Nothing links it to your deposit.</p>
              <Mascot face="happy" red={false}>I stayed in the school. A fresh fish swam out to your address.</Mascot>
              <GoButton ghost onClick={() => { setView("form"); setStep(-1); }}>NEW SWAP</GoButton>
            </div>
          )}
        </WidgetPanel>
        <Story />
        <InfoTiles />
      </main>
      <Footer />
      <TokenPicker
        open={picking !== null}
        title={picking === "in" ? "YOU SEND" : "YOU RECEIVE"}
        tokens={tokens}
        value={picking === "in" ? inId : outId}
        onClose={() => setPicking(null)}
        onPick={(t) => {
          if (picking === "in") { if (a?.blockchain !== t.blockchain) setRefund(""); setInId(t.assetId); }
          else { if (b?.blockchain !== t.blockchain) setDest(""); setOutId(t.assetId); }
          setPicking(null);
        }}
      />
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Preview />
  </StrictMode>,
);
