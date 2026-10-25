import { useEffect, useMemo, useRef, useState } from "react";
import type { TokenInfo } from "@unpair/sdk";
import { chainIcon, chainLabel, formatPrice, isNative, monogram, searchTokens, sortChains, tokenIcon } from "./tokens";

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

/**
 * Token picker dialog: search, chain chips, popular tokens first.
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
  const chains = useMemo(() => sortChains(tokens.map((t) => t.blockchain)), [tokens]);
  const rows = useMemo(() => searchTokens(tokens, query, chain), [tokens, query, chain]);

  useEffect(() => {
    const d = dlg.current;
    if (!d) return;
    if (open && !d.open) {
      setQuery("");
      d.showModal();
    } else if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog ref={dlg} className="picker" aria-labelledby="picker-title" onClose={onClose}>
      <div className="ph">
        <h3 id="picker-title">{title}</h3>
        <button type="button" className="x" aria-label="Close" onClick={onClose}>✕</button>
      </div>
      <input className="psearch" type="search" autoComplete="off" autoFocus placeholder="Search name, symbol or chain" aria-label="Search tokens" value={query} onChange={(e) => setQuery(e.target.value)} />
      <div className="pchains" role="group" aria-label="Filter by chain">
        <button type="button" aria-pressed={chain === null} onClick={() => setChain(null)}>All chains</button>
        {chains.map((c) => (
          <button type="button" key={c} aria-pressed={chain === c} onClick={() => setChain(c)}>
            <ChainIcon chain={c} />
            {chainLabel(c)}
          </button>
        ))}
      </div>
      <div className="plist" role="listbox" aria-label="Tokens">
        {rows.length === 0 && <div className="empty">No token found. Try another name, or pick "All chains".</div>}
        {rows.map((t) => (
          <button type="button" role="option" aria-selected={t.assetId === value} key={t.assetId} onClick={() => onPick(t)}>
            <TokenIcon token={t} />
            <span className="pt"><b>{t.symbol}</b><small>{chainLabel(t.blockchain)}</small></span>
            <span className="pp">{formatPrice(t.price)}</span>
          </button>
        ))}
      </div>
      <div className="pcount">{tokens.length} tokens on {chains.length} chains, from NEAR Intents.</div>
    </dialog>
  );
}
