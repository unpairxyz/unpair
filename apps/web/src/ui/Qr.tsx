import { useMemo } from "react";
import qrcode from "qrcode-generator";

/** A QR code as crisp SVG squares. Always black on white, in both themes, so every phone camera reads it. */
export function Qr({ value, label }: { value: string; label?: string }) {
  const { n, d } = useMemo(() => {
    const q = qrcode(0, "M");
    q.addData(value);
    q.make();
    const size = q.getModuleCount();
    let path = "";
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (q.isDark(r, c)) path += `M${c} ${r}h1v1h-1z`;
    return { n: size, d: path };
  }, [value]);
  return (
    <div className="qr">
      <svg viewBox={`-4 -4 ${n + 8} ${n + 8}`} role="img" aria-label={label ?? `QR code for ${value}`} shapeRendering="crispEdges">
        <rect x="-4" y="-4" width={n + 8} height={n + 8} fill="#fff" />
        <path d={d} fill="#000" />
      </svg>
    </div>
  );
}
