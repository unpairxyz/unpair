// A school of fish drawn as ink strokes on a canvas. One fish (index 0) can be "you": the red fish.
//   you.mode  "alone"  waits at the left edge, exposed
//             "join"   swims into the school
//             "free"   swims with the school; fades from red to ink
//   exit      a different fish leaves to the right (the payout)

export const SPOT = "#FF2E4D";

/** Ink and paper of the current theme, read from the CSS tokens. A canvas cannot use var(), so it reads them here. */
export const pal = { ink: "#000", paper: "#fff", trail: "rgba(0,0,0,.16)" };
export function readPalette(): void {
  const cs = getComputedStyle(document.documentElement);
  pal.ink = cs.getPropertyValue("--ink").trim() || "#000";
  pal.paper = cs.getPropertyValue("--paper").trim() || "#fff";
  pal.trail = cs.getPropertyValue("--trail").trim() || "rgba(0,0,0,.16)";
}

export function rng(seed: string | number): () => number {
  const s = String(seed);
  let h = 1779033703 ^ s.length;
  for (const ch of s) {
    h = Math.imul(h ^ ch.charCodeAt(0), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

export interface SchoolOptions {
  n?: number;
  seed?: string | number;
  cx?: number;
  cy?: number;
  spread?: number;
  /** Neighbour radius, px. */
  perc?: number;
  /** Separation radius, px. */
  sep?: number;
  len?: number;
  lw?: number;
  /** Stroke colour; "paper" draws in the page colour, on an ink panel. Default: ink. */
  ink?: string | undefined;
  trail?: boolean;
}

export type YouMode = "alone" | "join" | "free";

interface Sfx {
  x: number;
  y: number;
  t: string;
  life: number;
  size?: number;
  red?: boolean;
  rot?: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export class School {
  readonly cv: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly o: SchoolOptions;
  readonly cap: number;
  n: number;
  W = 1;
  H = 1;
  x: Float32Array;
  y: Float32Array;
  vx: Float32Array;
  vy: Float32Array;
  speed = 1;
  /** Circle in place (quiet mode). */
  mill = false;
  /** Area the fish keep out of, such as the headline. */
  rock: Rect | null = null;
  /** The cursor: nearby fish swim away. It draws nothing. */
  flee: { x: number; y: number; r: number; on: boolean } | null = null;
  you: { on: boolean; mode: YouMode; fade: number; fadeRate: number } = { on: false, mode: "free", fade: 0, fadeRate: 0 };
  exit: { i: number; done: boolean } | null = null;
  onExit: (() => void) | null = null;
  sfx: Sfx[] = [];

  private R: () => number;
  private dpr: number;
  private ph: Float32Array;
  private readonly HL = 5;
  private hx: Float32Array;
  private hy: Float32Array;
  private hi = 0;
  private frame = 0;
  private t: number;
  private head: Int32Array | null = null;
  private next: Int32Array;

  constructor(cv: HTMLCanvasElement, o: SchoolOptions = {}) {
    const ctx = cv.getContext("2d");
    if (!ctx) throw new Error("no 2d canvas");
    readPalette();
    this.cv = cv;
    this.ctx = ctx;
    this.o = o;
    this.R = rng(o.seed ?? 1);
    this.n = o.n ?? 600;
    this.cap = this.n;
    this.dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const F = (k = 1) => new Float32Array(this.cap * k);
    this.x = F();
    this.y = F();
    this.vx = F();
    this.vy = F();
    this.ph = F();
    this.hx = F(this.HL);
    this.hy = F(this.HL);
    this.next = new Int32Array(this.cap);
    this.t = this.R() * 100;
    this.resize();
    const cx = o.cx ?? 0.5;
    const sp = o.spread ?? 0.6;
    for (let i = 0; i < this.cap; i++) this.spawn(i, this.W * (cx + (this.R() - 0.5) * sp), this.H * (0.5 + (this.R() - 0.5) * sp));
  }

  private spawn(i: number, x: number, y: number): void {
    const a = this.R() * 6.283;
    this.x[i] = x;
    this.y[i] = y;
    this.vx[i] = Math.cos(a) * 1.5;
    this.vy[i] = Math.sin(a) * 1.5;
    this.ph[i] = this.R() * 6.283;
    for (let k = 0; k < this.HL; k++) {
      this.hx[i * this.HL + k] = x;
      this.hy[i * this.HL + k] = y;
    }
  }

  resize(): void {
    const r = this.cv.getBoundingClientRect();
    const oW = this.W;
    const oH = this.H;
    this.W = Math.max(1, r.width);
    this.H = Math.max(1, r.height);
    this.cv.width = this.W * this.dpr;
    this.cv.height = this.H * this.dpr;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (oW > 1 && oH > 1) {
      for (let i = 0; i < this.cap; i++) {
        this.x[i]! *= this.W / oW;
        this.y[i]! *= this.H / oH;
      }
    }
  }

  centre(): [number, number] {
    let mx = 0;
    let my = 0;
    let c = 0;
    for (let k = 1; k < this.n; k += 5) {
      mx += this.x[k]!;
      my += this.y[k]!;
      c++;
    }
    return [mx / c, my / c];
  }

  /** Place the red fish. */
  place(fx: number, fy: number): void {
    this.x[0] = this.W * fx;
    this.y[0] = this.H * fy;
  }

  startExit(): void {
    // any fish except you: what leaves is not what came in
    this.exit = { i: 1 + ((this.R() * (this.n - 1)) | 0), done: false };
  }

  say(t: string, fx: number, fy: number, extra: Partial<Sfx> = {}): void {
    this.sfx.push({ x: this.W * fx, y: this.H * fy, t, life: 70, ...extra });
  }

  step(): void {
    const { x, y, vx, vy, n, W, H } = this;
    const P = this.o.perc ?? 34;
    const P2 = P * P;
    const S2 = (this.o.sep ?? 10) ** 2;
    const cols = Math.ceil(W / P) + 2;
    const rows = Math.ceil(H / P) + 2;
    const cells = cols * rows;
    if (!this.head || this.head.length < cells) this.head = new Int32Array(cells);
    const head = this.head;
    const next = this.next;
    head.fill(-1, 0, cells);
    for (let i = 0; i < n; i++) {
      const gx = Math.max(0, Math.min(cols - 1, ((x[i]! / P) | 0) + 1));
      const gy = Math.max(0, Math.min(rows - 1, ((y[i]! / P) | 0) + 1));
      const c = gx + gy * cols;
      next[i] = head[c]!;
      head[c] = i;
    }
    this.t += 0.004 * this.speed;
    const ocx = this.o.cx ?? 0.5;
    const ocy = this.o.cy ?? 0.5;
    const tx = W * (ocx + 0.2 * Math.sin(this.t * 0.9) + 0.05 * Math.sin(this.t * 2.1));
    const ty = H * (ocy + 0.18 * Math.cos(this.t * 0.7));
    const mcx = W * ocx;
    const mcy = H * ocy;
    const mR = Math.min(W, H) * 0.28;
    const maxS = 2.6 * this.speed;
    const minS = 1.1 * this.speed;
    const rk = this.rock;
    const fl = this.flee;
    const ex = this.exit && !this.exit.done ? this.exit.i : -1;
    const you = this.you.on ? this.you : null;

    for (let i = 0; i < n; i++) {
      let fx = 0;
      let fy = 0;
      const xi = x[i]!;
      const yi = y[i]!;
      const special = (i === 0 && you !== null && you.mode !== "free") || i === ex;
      if (!special) {
        let ax = 0, ay = 0, cx = 0, cy = 0, sx = 0, sy = 0, c = 0;
        const gx = ((xi / P) | 0) + 1;
        const gy = ((yi / P) | 0) + 1;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const X = gx + dx;
            const Y = gy + dy;
            if (X < 0 || Y < 0 || X >= cols || Y >= rows) continue;
            for (let j = head[X + Y * cols]!; j !== -1; j = next[j]!) {
              if (j === i || j === ex) continue;
              const ex2 = x[j]! - xi;
              const ey2 = y[j]! - yi;
              const d2 = ex2 * ex2 + ey2 * ey2;
              if (d2 < S2) {
                const k = 1 / (d2 + 1);
                sx -= ex2 * k;
                sy -= ey2 * k;
              }
              if (d2 < P2 && c < 12) {
                ax += vx[j]!;
                ay += vy[j]!;
                cx += x[j]!;
                cy += y[j]!;
                c++;
              }
            }
          }
        }
        fx = sx * 2.2;
        fy = sy * 2.2;
        if (c) {
          fx += (ax / c - vx[i]!) * 0.06 + (cx / c - xi) * 0.0011;
          fy += (ay / c - vy[i]!) * 0.06 + (cy / c - yi) * 0.0011;
        }
        if (this.mill) {
          const dx = xi - mcx;
          const dy = yi - mcy;
          const d = Math.hypot(dx, dy) + 1e-3;
          fx += (-dy / d) * 0.05 + (dx / d) * (mR - d) * 0.0012;
          fy += (dx / d) * 0.05 + (dy / d) * (mR - d) * 0.0012;
        } else {
          fx += (tx - xi) * 0.00035;
          fy += (ty - yi) * 0.00035;
        }
        if (rk) {
          const l = rk.x, r = rk.x + rk.w, t = rk.y, b = rk.y + rk.h;
          if (xi > l && xi < r && yi > t && yi < b) {
            const mn = Math.min(xi - l, r - xi, yi - t, b - yi);
            if (mn === xi - l) fx -= 0.5;
            else if (mn === r - xi) fx += 0.5;
            else if (mn === yi - t) fy -= 0.5;
            else fy += 0.5;
          }
        }
        if (fl && fl.on) {
          const dx = xi - fl.x;
          const dy = yi - fl.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < fl.r * fl.r) {
            const d = Math.sqrt(d2) + 0.1;
            const k = 1 - d / fl.r;
            fx += (dx / d) * k * 1.6;
            fy += (dy / d) * k * 1.6;
          }
        }
      } else if (i === 0 && you) {
        if (you.mode === "alone") {
          // alone near the left edge: a slow, exposed idle loop
          const px = W * 0.08 + Math.sin(this.t * 3) * W * 0.025;
          const py = H * 0.7 + Math.sin(this.t * 5.3) * H * 0.04;
          fx = (px - xi) * 0.006;
          fy = (py - yi) * 0.006;
        } else if (you.mode === "join") {
          const [mx, my] = this.centre();
          fx = (mx - xi) * 0.003;
          fy = (my - yi) * 0.003;
          if (Math.hypot(mx - xi, my - yi) < 40) you.mode = "free";
        }
      } else if (i === ex && this.exit) {
        fx = (W + 60 - xi) * 0.002 + 0.08;
        fy = (H * 0.35 - yi) * 0.002;
        if (xi > W + 30) {
          this.exit.done = true;
          this.spawn(i, W * 0.4 + this.R() * W * 0.2, H * 0.5);
          this.onExit?.();
        }
      }
      const m = 30;
      if (i !== ex) {
        if (xi < m) fx += 0.14;
        else if (xi > W - m) fx -= 0.14;
        if (yi < m) fy += 0.14;
        else if (yi > H - m) fy -= 0.14;
      }
      let nvx = vx[i]! + fx * this.speed;
      let nvy = vy[i]! + fy * this.speed;
      const lim = i === 0 && you && you.mode === "alone" ? 0.5 : 1;
      const s = Math.hypot(nvx, nvy) + 1e-6;
      const mx2 = maxS * lim;
      const mn2 = minS * (lim < 1 ? 0.4 : 1);
      if (s > mx2) {
        nvx *= mx2 / s;
        nvy *= mx2 / s;
      } else if (s < mn2) {
        nvx *= mn2 / s;
        nvy *= mn2 / s;
      }
      vx[i] = nvx;
      vy[i] = nvy;
      x[i] = xi + nvx;
      y[i] = yi + nvy;
      this.ph[i]! += 0.25 + s * 0.08;
    }
    this.frame++;
    if (this.frame % 3 === 0) {
      this.hi = (this.hi + 1) % this.HL;
      for (let i = 0; i < n; i++) {
        this.hx[i * this.HL + this.hi] = x[i]!;
        this.hy[i * this.HL + this.hi] = y[i]!;
      }
    }
    if (you && you.fadeRate && you.fade < 1) you.fade = Math.min(1, you.fade + you.fadeRate);
  }

  private dash(i: number, scale: number): void {
    const { x, y, vx, vy, ctx } = this;
    const L = this.o.len ?? 8;
    const s = Math.hypot(vx[i]!, vy[i]!) + 1e-6;
    const ux = vx[i]! / s;
    const uy = vy[i]! / s;
    const len = (L + s * 1.3) * scale;
    ctx.moveTo(x[i]! + ux * len * 0.5, y[i]! + uy * len * 0.5);
    ctx.lineTo(x[i]! - ux * len * 0.5, y[i]! - uy * len * 0.5);
  }

  draw(): void {
    const { ctx, x, y, vx, vy, n, HL } = this;
    const ink = this.o.ink === "paper" ? pal.paper : (this.o.ink ?? pal.ink);
    const L = this.o.len ?? 8;
    ctx.clearRect(0, 0, this.W, this.H);
    ctx.lineCap = "round";
    const you = this.you.on ? 0 : -1;
    const ex = this.exit && !this.exit.done ? this.exit.i : -1;
    if (this.o.trail !== false) {
      ctx.strokeStyle = pal.trail;
      ctx.lineWidth = 1;
      ctx.beginPath();
      const a = (this.hi + 1) % HL;
      const b = (this.hi + 3) % HL;
      for (let i = 0; i < n; i++) {
        if (i === you || i === ex) continue;
        ctx.moveTo(this.hx[i * HL + a]!, this.hy[i * HL + a]!);
        ctx.lineTo(this.hx[i * HL + b]!, this.hy[i * HL + b]!);
      }
      ctx.stroke();
    }
    ctx.strokeStyle = ink;
    ctx.lineWidth = this.o.lw ?? 1.8;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      if (i === you || i === ex) continue;
      const s = Math.hypot(vx[i]!, vy[i]!) + 1e-6;
      const ux = vx[i]! / s;
      const uy = vy[i]! / s;
      const len = L + s * 1.3;
      const w = Math.sin(this.ph[i]!) * 1.2;
      ctx.moveTo(x[i]! + ux * len * 0.5, y[i]! + uy * len * 0.5);
      ctx.quadraticCurveTo(x[i]! - uy * w, y[i]! + ux * w, x[i]! - ux * len * 0.5, y[i]! - uy * len * 0.5);
    }
    ctx.stroke();
    if (you === 0) {
      const f = this.you.fade;
      const sc = 1.3 - 0.3 * f;
      // the red fish: black outline, red fill that fades to plain ink as it blends
      ctx.strokeStyle = pal.ink;
      ctx.lineWidth = 5 - 3.2 * f;
      ctx.beginPath();
      this.dash(0, sc);
      ctx.stroke();
      if (f < 1) {
        ctx.strokeStyle = `rgba(255,46,77,${1 - f})`;
        ctx.lineWidth = 3 * (1 - f);
        ctx.beginPath();
        this.dash(0, sc);
        ctx.stroke();
      }
      if (f < 0.6) {
        ctx.globalAlpha = 1 - f / 0.6;
        ctx.strokeStyle = pal.ink;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x[0]!, y[0]!, 13 + Math.sin(this.frame * 0.1) * 1.5, 0, 6.283);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
    if (ex > -1) {
      // the payout: a fresh fish, drawn hollow, with motion lines behind it
      ctx.strokeStyle = pal.ink;
      ctx.lineWidth = 6;
      ctx.beginPath();
      this.dash(ex, 1.6);
      ctx.stroke();
      ctx.strokeStyle = pal.paper;
      ctx.lineWidth = 3;
      ctx.beginPath();
      this.dash(ex, 1.45);
      ctx.stroke();
      const s = Math.hypot(vx[ex]!, vy[ex]!) + 1e-6;
      const ux = vx[ex]! / s;
      const uy = vy[ex]! / s;
      ctx.strokeStyle = pal.ink;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      for (let k = -1; k <= 1; k++) {
        ctx.moveTo(x[ex]! - ux * 18 + uy * k * 5, y[ex]! - uy * 18 - ux * k * 5);
        ctx.lineTo(x[ex]! - ux * 40 + uy * k * 5, y[ex]! - uy * 40 - ux * k * 5);
      }
      ctx.stroke();
    }
    for (const s of this.sfx) {
      s.life--;
      const sz = s.size ?? 46;
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate(s.rot ?? -0.14);
      ctx.font = `${sz}px Bangers, Impact, sans-serif`;
      ctx.lineJoin = "round";
      ctx.lineWidth = sz * 0.22;
      ctx.strokeStyle = pal.paper;
      ctx.strokeText(s.t, 0, 0);
      ctx.lineWidth = sz * 0.08;
      ctx.strokeStyle = pal.ink;
      ctx.strokeText(s.t, 0, 0);
      ctx.fillStyle = s.red ? SPOT : pal.paper;
      ctx.fillText(s.t, 0, 0);
      ctx.restore();
    }
    this.sfx = this.sfx.filter((s) => s.life > 0);
  }

}

/**
 * Draw the quote mark: a small school in the page colour on the ink disc, one red dot in the middle.
 * The shape comes from the seed alone. The fish are placed along one to three seeded arcs, not simulated,
 * and laid out in a unit square that is scaled to the canvas. So the same seed draws the same picture at
 * any size, on any screen and in any browser, which is what the phone check compares.
 */
export function drawMark(cv: HTMLCanvasElement, seed: string): void {
  const ctx = cv.getContext("2d");
  if (!ctx) return;
  readPalette();
  const dpr = Math.min(3, globalThis.devicePixelRatio || 1);
  const S = Math.max(1, cv.getBoundingClientRect().width || 62);
  cv.width = Math.round(S * dpr);
  cv.height = Math.round(S * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, S, S);

  const R = rng(seed);
  const N = 130;
  const px = new Float64Array(N);
  const py = new Float64Array(N);
  const ux = new Float64Array(N);
  const uy = new Float64Array(N);
  const ph = new Float64Array(N);
  // the arcs the school swims along: start, control and end point, and how wide the school is around each
  const arcs = 1 + ((R() * 3) | 0);
  const arc: number[][] = [];
  for (let a = 0; a < arcs; a++) arc.push([R(), R(), R(), R(), R(), R(), 0.03 + R() * 0.09]);
  for (let i = 0; i < N; i++) {
    const [x0, y0, x1, y1, x2, y2, w] = arc[i % arcs]! as [number, number, number, number, number, number, number];
    const t = R();
    const u = 1 - t;
    const bx = u * u * x0 + 2 * u * t * x1 + t * t * x2;
    const by = u * u * y0 + 2 * u * t * y1 + t * t * y2;
    let dx = 2 * u * (x1 - x0) + 2 * t * (x2 - x1);
    let dy = 2 * u * (y1 - y0) + 2 * t * (y2 - y1);
    const d = Math.hypot(dx, dy) || 1;
    dx /= d;
    dy /= d;
    const off = (R() + R() + R() - 1.5) * w;
    px[i] = bx - dy * off;
    py[i] = by + dx * off;
    const j = (R() - 0.5) * 0.7;
    const c = Math.cos(j);
    const s = Math.sin(j);
    ux[i] = dx * c - dy * s;
    uy[i] = dx * s + dy * c;
    ph[i] = R() * 6.283;
  }
  // centre the school and fit it to the disc
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < N; i++) {
    x0 = Math.min(x0, px[i]!);
    x1 = Math.max(x1, px[i]!);
    y0 = Math.min(y0, py[i]!);
    y1 = Math.max(y1, py[i]!);
  }
  const k = (S * 0.62) / Math.max(x1 - x0, y1 - y0, 1e-6);
  const mx = (x0 + x1) / 2;
  const my = (y0 + y1) / 2;
  const len = S * 0.08;
  const wob = S * 0.02;
  ctx.strokeStyle = pal.paper;
  ctx.lineCap = "round";
  ctx.lineWidth = Math.max(0.9, S * 0.022);
  ctx.beginPath();
  for (let i = 0; i < N; i++) {
    const x = S / 2 + (px[i]! - mx) * k;
    const y = S / 2 + (py[i]! - my) * k;
    const w = Math.sin(ph[i]!) * wob;
    ctx.moveTo(x + ux[i]! * len * 0.5, y + uy[i]! * len * 0.5);
    ctx.quadraticCurveTo(x - uy[i]! * w, y + ux[i]! * w, x - ux[i]! * len * 0.5, y - uy[i]! * len * 0.5);
  }
  ctx.stroke();
  ctx.fillStyle = SPOT;
  ctx.beginPath();
  ctx.arc(S / 2, S / 2, Math.max(2.5, S / 24), 0, 6.283);
  ctx.fill();
}

export const reducedMotion = (): boolean => globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
