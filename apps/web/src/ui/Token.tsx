import { useEffect, useMemo, useRef, useState } from "react";
import type { TokenInfo } from "@unpair/sdk";
import { chainIcon, chainLabel, formatPrice, isNative, monogram, quickPicks, recentTokens, rememberToken, searchTokens, sortChains, tokenIcon } from "./tokens";

function Img({ src, label, badge = false }: { src: string | null; label: string; badge?: boolean }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  const cls = badge ? "cb" : "";
  if (!src || failed) return <span className={`mono-ic ${cls}`} aria-hidden="true">{monogram(label, badge ? 1 : undefined)}</span>;
  return <img src={src} alt="" className={cls} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
}

/** Token logo with a small chain badge, like other aggregators. */
export function TokenIcon({ token }: { token: TokenInfo }) {
  return (
    <span className="ti">
      <Img src={tokenIcon(token)} label={token.symbol} />
      {!isNative(token) && <Img src={chainIcon(token.blockchain)} label={chainLabel(token.blockchain)} badge />}
    </span>
  );
}

export function ChainIcon({ chain }: { chain: string }) {
  return (
    <span className="ti">
      <Img src={chainIcon(chain)} label={chainLabel(chain)} />
    </span>
  );
}

export function TokenButton({ token, onClick, label, fixed = false }: { token: TokenInfo | null; onClick?: () => void; label: string; fixed?: boolean }) {
  // a token that cannot change shows as a plain label: no frame, no caret, not clickable
  return (
    <button type="button" className={fixed ? "tok fixed" : "tok"} disabled={fixed} onClick={onClick} aria-label={token ? `${label}: ${token.symbol} on ${chainLabel(token.blockchain)}${fixed ? "" : ". Change"}` : label}>
      {token ? (
        <>
          <TokenIcon token={token} />
          <span className="tt"><b>{token.symbol}</b><small>{chainLabel(token.blockchain)}</small></span>
        </>
      ) : (
        <span className="tt"><b>Pick</b><small>a token</small></span>
      )}
      <span className="car" aria-hidden="true" />
    </button>
  );
}

/** Small token buttons under a leg, for one-tap picks. */
export function QuickPicks({ tokens, value, onPick, label }: { tokens: TokenInfo[]; value: string | null; onPick: (t: TokenInfo) => void; label: string }) {
  const picks = useMemo(() => quickPicks(tokens, value), [tokens, value]);
  if (!picks.length) return null;
  return (
    <div className="qpicks" role="group" aria-label={label}>
      {picks.map((t) => (
        <button type="button" key={t.assetId} onClick={() => { rememberToken(t); onPick(t); }} title={`${t.symbol} on ${chainLabel(t.blockchain)}`} aria-label={`${t.symbol} on ${chainLabel(t.blockchain)}`}>
          <TokenIcon token={t} />
          <span>{t.symbol}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * Token picker dialog: chains as an icon column on the left, search, recent picks and the token list on the right.
 * `open` drives the native <dialog>; Escape and the close button call onClose.
 */
export function TokenPicker({ open, title, tokens, value, onPick, onClose }: {
  open: boolean;
  title: string;
  tokens: TokenInfo[];
  /** assetId of the current choice. */
  value: string | null;
  onPick: (t: TokenInfo) => void;
  onClose: () => void;
}) {
  const dlg = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState("");
  const [chain, setChain] = useState<string | null>(null);
  const [recent, setRecent] = useState<TokenInfo[]>([]);
  const chains = useMemo(() => sortChains(tokens.map((t) => t.blockchain)), [tokens]);
  const rows = useMemo(() => searchTokens(tokens, query, chain), [tokens, query, chain]);
  const shownRecent = recent.filter((t) => !chain || t.blockchain === chain);

  useEffect(() => {
    const d = dlg.current;
    if (!d) return;
    if (open && !d.open) {
      setQuery("");
      setRecent(recentTokens(tokens));
      d.showModal();
    } else if (!open && d.open) d.close();
  }, [open, tokens]);

  const pick = (t: TokenInfo) => {
    rememberToken(t);
    onPick(t);
  };

  return (
    <dialog ref={dlg} className="picker" aria-labelledby="picker-title" onClose={onClose}>
      <div className="ph">
        <h3 id="picker-title">{title}</h3>
        <button type="button" className="x" aria-label="Close" onClick={onClose}>✕</button>
      </div>
      <div className="pbody">
        <div className="prail" role="group" aria-label="Chains">
          <button type="button" className="pall" aria-pressed={chain === null} onClick={() => setChain(null)}>ALL</button>
          {chains.map((c) => (
            <button type="button" key={c} aria-pressed={chain === c} aria-label={chainLabel(c)} title={chainLabel(c)} onClick={() => setChain(c)}>
              <ChainIcon chain={c} />
            </button>
          ))}
        </div>
        <div className="pmain">
          <input className="psearch" type="search" autoComplete="off" autoFocus placeholder="Search token or chain" aria-label="Search tokens" value={query} onChange={(e) => setQuery(e.target.value)} />
          <div className="pscope">{chain ? <><ChainIcon chain={chain} /><b>{chainLabel(chain)}</b></> : <b>All chains</b>}<span>{rows.length} tokens</span></div>
          {!query && shownRecent.length > 0 && (
            <div className="precent" role="group" aria-label="Recent">
              <span className="plbl">Recent</span>
              {shownRecent.map((t) => (
                <button type="button" key={t.assetId} onClick={() => pick(t)} title={`${t.symbol} on ${chainLabel(t.blockchain)}`}>
                  <TokenIcon token={t} />
                  <span>{t.symbol}</span>
                </button>
              ))}
            </div>
          )}
          <div className="plist" role="group" aria-label="Tokens">
            {rows.length === 0 && <div className="empty">No token found. Try another name, or pick ALL.</div>}
            {rows.map((t) => (
              <button type="button" aria-current={t.assetId === value || undefined} key={t.assetId} onClick={() => pick(t)}>
                <TokenIcon token={t} />
                <span className="pt"><b>{t.symbol}</b><small>{chainLabel(t.blockchain)}</small></span>
                <span className="pp">{formatPrice(t.price)}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="pcount">{tokens.length} tokens on {chains.length} chains.</div>
    </dialog>
  );
}
