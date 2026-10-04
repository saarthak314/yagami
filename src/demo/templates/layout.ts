// Label layout for template demos: text drawn during a frame is collected and placed at the end of
// the frame so that no label is clipped by the stage edge or collides with another label.
//
// Rules, per label (highest priority first; earlier-drawn first among equals):
//   1. wider than the stage → shortened with "…";
//   2. outside the stage → shifted in;
//   3. colliding with an already placed label →
//        number-only labels (ticks, cell values) are dropped (thinning);
//        others try small nudges (up/down, then sideways), then a smaller font, then are shortened
//        with "…" to the free space, and are dropped only as a last resort.
// Text keeps its own font, colour, alignment and transform; rotated text is drawn as is.
// Everything is drawn at the end of the frame in the original order, through whatever fillText the
// context had (so the isolated-mode text recorder sees the final positions).

interface Req {
  s: string;
  x: number;
  y: number;
  maxWidth?: number;
  stroke: boolean;
  font: string;
  fill: CanvasRenderingContext2D["fillStyle"];
  strokeStyle: CanvasRenderingContext2D["strokeStyle"];
  lineWidth: number;
  align: CanvasTextAlign;
  baseline: CanvasTextBaseline;
  alpha: number;
  tf: DOMMatrix;
  order: number;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const NUMERIC = /^[\s\d.,−\-+×e^%·/:()[\]]*$/i;
const ELLIPSIS = "…";

/** Overlap rule slightly stricter than the checker's (so anything placed here passes it). */
function collides(a: Box, b: Box): boolean {
  const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (ix <= 1 || iy <= 1) return false;
  return (ix * iy) / Math.max(1, Math.min(a.w * a.h, b.w * b.h)) >= 0.08;
}

const inside = (b: Box, W: number, H: number) => b.x >= 0.5 && b.y >= 0.5 && b.x + b.w <= W - 0.5 && b.y + b.h <= H - 0.5;

/**
 * Wrap a frame callback: text drawn inside it is laid out at the end of the frame.
 * `W`/`H` are the stage size in CSS px.
 */
export function laidOut<F extends { width: number; height: number }>(onFrame: (ctx: CanvasRenderingContext2D, frame: F) => void): (ctx: CanvasRenderingContext2D, frame: F) => void {
  return (ctx, frame) => {
    const fill = ctx.fillText;
    const strokeT = ctx.strokeText;
    const reqs: Req[] = [];
    const capture = (stroke: boolean) =>
      function (this: CanvasRenderingContext2D, s: string, x: number, y: number, maxWidth?: number) {
        reqs.push({
          s: String(s),
          x,
          y,
          maxWidth,
          stroke,
          font: ctx.font,
          fill: ctx.fillStyle,
          strokeStyle: ctx.strokeStyle,
          lineWidth: ctx.lineWidth,
          align: ctx.textAlign,
          baseline: ctx.textBaseline,
          alpha: ctx.globalAlpha,
          tf: ctx.getTransform(),
          order: reqs.length,
        });
      };
    ctx.fillText = capture(false);
    ctx.strokeText = capture(true);
    try {
      onFrame(ctx, frame);
    } finally {
      ctx.fillText = fill;
      ctx.strokeText = strokeT;
      flush(ctx, reqs, frame.width, frame.height, fill, strokeT);
    }
  };
}

function flush(
  ctx: CanvasRenderingContext2D,
  reqs: Req[],
  W: number,
  H: number,
  fill: CanvasRenderingContext2D["fillText"],
  strokeT: CanvasRenderingContext2D["strokeText"],
) {
  if (!reqs.length) return;
  ctx.save();
  // A stroke immediately followed by a fill of the same text at the same spot is one label (a halo).
  type Group = { reqs: Req[]; s: string; scale: number; dx: number; dy: number; rotated: boolean; box: Box; prio: number; keep: boolean; order: number };
  const groups: Group[] = [];
  for (const r of reqs) {
    const g = groups[groups.length - 1];
    if (g && g.s === r.s && g.reqs.every((q) => q.x === r.x && q.y === r.y) && g.reqs.some((q) => q.stroke !== r.stroke)) g.reqs.push(r);
    else groups.push({ reqs: [r], s: r.s, scale: 1, dx: 0, dy: 0, rotated: false, box: { x: 0, y: 0, w: 0, h: 0 }, prio: 0, keep: true, order: r.order });
  }

  const dpr = ctx.canvas.width / W || 1;
  // Box of a group's (possibly shortened, scaled, shifted) text, in stage CSS px.
  const measure = (g: Group, s = g.s, scale = g.scale, dx = g.dx, dy = g.dy): Box => {
    const r = g.reqs[0];
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.font = scaleFont(r.font, scale);
    ctx.textAlign = r.align;
    ctx.textBaseline = r.baseline;
    const m = ctx.measureText(s);
    const kx = r.maxWidth !== undefined && m.width > r.maxWidth ? r.maxWidth / m.width : 1;
    const t = r.tf;
    const sx = Math.hypot(t.a, t.b) / dpr;
    const sy = Math.hypot(t.c, t.d) / dpr;
    const ox = (t.a * r.x + t.c * r.y + t.e) / dpr;
    const oy = (t.b * r.x + t.d * r.y + t.f) / dpr;
    const l = -m.actualBoundingBoxLeft * kx * sx;
    const rr = m.actualBoundingBoxRight * kx * sx;
    const top = -m.actualBoundingBoxAscent * sy;
    const bot = m.actualBoundingBoxDescent * sy;
    return { x: ox + l + dx, y: oy + top + dy, w: rr - l, h: bot - top };
  };

  for (const g of groups) {
    const t = g.reqs[0].tf;
    g.rotated = Math.abs(t.b) > 1e-6 || Math.abs(t.c) > 1e-6;
    g.box = measure(g);
    // Words matter more than bare numbers; bigger type more than small; fainter text less.
    g.prio = (NUMERIC.test(g.s) ? 0 : 10) + Math.min(9, g.box.h / 3) + (g.reqs[0].alpha < 0.6 ? -3 : 0);
  }

  const placed: Box[] = [];
  const order = groups.filter((g) => !g.rotated && g.s.trim()).sort((a, b) => b.prio - a.prio || a.order - b.order);
  for (const g of order) {
    // 1. Too wide for the stage: shorten.
    if (g.box.w > W - 4) g.s = shorten(g, W - 4, measure);
    g.box = measure(g);
    // 2. Shift inside the stage.
    const shiftIn = () => {
      const b = measure(g);
      let dx = 0;
      let dy = 0;
      if (b.x < 1) dx = 1 - b.x;
      else if (b.x + b.w > W - 1) dx = W - 1 - (b.x + b.w);
      if (b.y < 1) dy = 1 - b.y;
      else if (b.y + b.h > H - 1) dy = H - 1 - (b.y + b.h);
      g.dx += dx;
      g.dy += dy;
      g.box = measure(g);
    };
    shiftIn();
    // 3. Collisions.
    const free = (b: Box) => inside(b, W, H) && !placed.some((p) => collides(b, p));
    if (!free(g.box)) {
      const numeric = NUMERIC.test(g.s);
      let ok = false;
      if (!numeric) {
        // A label in the same row as the one it hits (column headers, a row of names): shorten it in
        // place — stacking a row of labels upward reads worse than "…".
        const hit = placed.find((p) => collides(g.box, p));
        const sibling = !!hit && Math.abs(hit.y + hit.h / 2 - (g.box.y + g.box.h / 2)) < g.box.h / 2 && Math.abs(hit.h - g.box.h) < g.box.h * 0.2;
        const tryShorten = () => {
          if (g.s.length <= 4) return false;
          for (let n = g.s.length - 1; n >= 3; n--) {
            const s = g.s.slice(0, n).trimEnd() + ELLIPSIS;
            const b = measure(g, s);
            if (free(b)) {
              g.s = s;
              g.box = b;
              return true;
            }
          }
          return false;
        };
        const tryMove = () => {
          const h = g.box.h + 2;
          const w = g.box.w;
          const tries: [number, number][] = [
            [0, 0],
            [0, -h],
            [0, h],
            [-w * 0.35, 0],
            [w * 0.35, 0],
          ];
          for (const scale of [1, 0.85])
            for (const [ddx, ddy] of tries) {
              const b = measure(g, g.s, scale, g.dx + ddx, g.dy + ddy);
              if (free(b)) {
                g.scale = scale;
                g.dx += ddx;
                g.dy += ddy;
                g.box = b;
                return true;
              }
            }
          return false;
        };
        ok = sibling ? tryShorten() || tryMove() : tryMove() || tryShorten();
      }
      if (!ok) {
        g.keep = false;
        continue;
      }
    }
    placed.push(g.box);
  }

  // Draw in the original order with each label's own state.
  for (const g of groups) {
    if (!g.keep) continue;
    for (const r of g.reqs) {
      ctx.setTransform(r.tf);
      ctx.font = scaleFont(r.font, g.scale);
      ctx.fillStyle = r.fill;
      ctx.strokeStyle = r.strokeStyle;
      ctx.lineWidth = r.lineWidth;
      ctx.textAlign = r.align;
      ctx.textBaseline = r.baseline;
      ctx.globalAlpha = r.alpha;
      // Shift is in stage px; convert to the text's local units.
      const t = r.tf;
      const det = t.a * t.d - t.b * t.c || 1;
      const lx = ((g.dx * dpr) * t.d - (g.dy * dpr) * t.c) / det;
      const ly = (-(g.dx * dpr) * t.b + (g.dy * dpr) * t.a) / det;
      const draw = r.stroke ? strokeT : fill;
      if (r.maxWidth === undefined) draw.call(ctx, g.s, r.x + lx, r.y + ly);
      else draw.call(ctx, g.s, r.x + lx, r.y + ly, r.maxWidth);
    }
  }
  ctx.restore();
}

function scaleFont(font: string, scale: number): string {
  if (scale === 1) return font;
  return font.replace(/(\d+(?:\.\d+)?)px/, (_, n: string) => `${Math.max(8, Math.round(Number(n) * scale * 10) / 10)}px`);
}

function shorten(g: { s: string }, maxW: number, measure: (g: never, s: string) => Box): string {
  let lo = 1;
  let hi = g.s.length;
  let best = g.s.slice(0, 1) + ELLIPSIS;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = g.s.slice(0, mid).trimEnd() + ELLIPSIS;
    if (measure(g as never, s).w <= maxW) {
      best = s;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}
