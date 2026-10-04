// Stress audit (isolated mode `?demo=<book>/<unit>/<id>&stress=1`): renders the demo
// component with controlled props and steps its frames by hand — long runs on every
// beat, every preset, every control value (min/max/mid/…), extreme combinations,
// pause/restart and resizes — collecting crashes, broken readouts and blank stages.
// Deterministic (no wall clock, seeded choices) and model-free. Results land on
// `window.__stress` for the verifier, which turns them into ordinary check notes.

import { Component, Suspense, lazy, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import type { ControlSpec, DemoProps, DemoSpec, Params, ParamValue } from "../types";
import { loaderFor } from "../lib/data";
import { templateComponent } from "./templates";

export interface StressResult {
  done: boolean;
  /** Scenarios in which fmt() got non-finite numbers (diagnostic; see the audit notes). */
  nonFinite?: { ctx: string; n: number }[];
  notes: string[];
  scenarios: number;
  frames: number;
  ms: number;
}

declare global {
  interface Window {
    __stress?: StressResult;
  }
}

type AnyDemo = ComponentType<DemoProps & { config?: unknown }>;

/** Total wall-time budget for the frames of one demo (ms). Scenario lengths scale down for slow demos. */
const BUDGET_MS = 3000;
const FRAME = 1 / 30;
const SIZES = [
  { w: 480, h: 300, label: "a short 480×300 stage" },
  { w: 480, h: 900, label: "a tall 480×900 stage" },
  { w: 1200, h: 400, label: "a wide 1200×400 stage" },
];
const BASE_SIZE = { w: 560, h: 420 };
const BROKEN = /\b(NaN|Infinity|undefined|null)\b/;

class Boundary extends Component<{ children: ReactNode; onError: (e: unknown) => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(e: unknown) {
    this.props.onError(e);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

const errText = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).split("\n")[0].slice(0, 220);

/** Deterministic PRNG (mulberry32) for the "random" control values. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const snap = (c: Extract<ControlSpec, { type: "slider" }>, v: number) => {
  const k = Math.round((v - c.min) / (c.step || 1));
  const s = c.min + k * (c.step || 1);
  return Math.min(c.max, Math.max(c.min, Number(s.toFixed(10))));
};

/** The values a control is swept through, each with a short description. */
function sweep(c: ControlSpec, rnd: () => number): { v: ParamValue; what: string }[] {
  const q = `"${c.label.replace(/\$/g, "")}"`;
  if (c.type === "toggle") return [true, false].map((v) => ({ v, what: `${q} ${v ? "on" : "off"}` }));
  if (c.type === "select") return c.options.map((o) => ({ v: o.value, what: `${q} = "${o.value}"` }));
  const mid = snap(c, (c.min + c.max) / 2);
  const r = snap(c, c.min + rnd() * (c.max - c.min));
  const out = [
    { v: c.min, what: `${q} at min (${c.min})` },
    { v: c.max, what: `${q} at max (${c.max})` },
    { v: mid, what: `${q} = ${mid}` },
    { v: r, what: `${q} = ${r}` },
  ];
  return out.filter((x, i) => out.findIndex((y) => y.v === x.v) === i);
}

interface Harness {
  params: Params;
  preset: string;
  playing: boolean;
  resetKey: number;
  w: number;
  h: number;
  mount: number;
}

export function StressHarness({ unitKey, demo }: { unitKey: string; demo: DemoSpec }) {
  const Demo = useMemo<AnyDemo | null>(() => {
    if (demo.template) return templateComponent(demo.template) as AnyDemo | null;
    const load = loaderFor(unitKey, demo.component);
    return load ? (lazy(load) as unknown as AnyDemo) : null;
  }, [unitKey, demo]);

  const presetParams = (id: string) => demo.presets.find((p) => p.id === id)?.params ?? demo.presets[0]?.params ?? {};
  const base = (b: number): Params => ({ ...presetParams(demo.beats[b]?.preset ?? ""), ...(demo.beats[b]?.params ?? {}) });

  const [h, setH] = useState<Harness>({ params: base(0), preset: demo.beats[0]?.preset ?? demo.presets[0]?.id ?? "", playing: true, resetKey: 0, w: BASE_SIZE.w, h: BASE_SIZE.h, mount: 0 });
  const readouts = useRef<Record<string, string | number>>({});
  const renderError = useRef<unknown>(null);
  const committed = useRef<(() => void) | null>(null);
  const version = useRef(0);
  const [tick, setTick] = useState(0);

  // Resolve the pending `apply` after React has committed (child effects — the Stage registering — run first).
  useEffect(() => {
    committed.current?.();
    committed.current = null;
  }, [tick]);

  useEffect(() => {
    let cancelled = false;
    const t0 = performance.now();
    const result: StressResult = { done: false, notes: [], scenarios: 0, frames: 0, ms: 0 };
    window.__stress = result;
    // Findings keyed by message (without context) so one bug is reported once.
    const found = new Map<string, { ctx: string; more: number }>();
    const note = (ctx: string, msg: string) => {
      const f = found.get(msg);
      if (f) f.more++;
      else found.set(msg, { ctx, more: 0 });
    };
    const ever = new Set<string>();
    // fmt(NaN/Infinity) calls per scenario (they render as "—", so they hide behind the readout check).
    const nonFinite: { ctx: string; n: number }[] = [];
    let cur: Harness = h;

    const apply = (patch: Partial<Harness>) =>
      new Promise<void>((resolve) => {
        cur = { ...cur, ...patch };
        committed.current = resolve;
        version.current++;
        setH(cur);
        setTick(version.current);
      });
    const stages = () => [...(window.__stressStages ?? [])];
    const waitStage = async () => {
      for (let i = 0; i < 200 && !stages().length && !renderError.current; i++) await new Promise((r) => setTimeout(r, 25));
      return stages().length > 0;
    };
    // Errors the page logged (console.error, window errors) since the last call.
    const drainErrors = () => {
      const list = window.__demoErrors ?? [];
      const out = list.splice(0, list.length);
      return out.filter((m) => !/The above error occurred|React will try to recreate|Consider adding an error boundary/.test(m));
    };

    let perFrame = 0.4; // ms, measured on the first scenario
    const framesFor = (seconds: number, share = 1) => {
      const want = Math.round(seconds / FRAME);
      const cap = Math.max(15, Math.round(((BUDGET_MS * share) / Math.max(0.05, perFrame)) | 0));
      return Math.min(want, cap);
    };

    /** Step `n` frames (dt from `dts`, cycled); returns false when a frame threw. */
    const run = (ctx: string, n: number, dts: number[] = [FRAME]) => {
      let t = 0;
      const list = stages();
      for (let i = 0; i < n; i++) {
        const dt = dts[i % dts.length];
        try {
          for (const s of list) s.frame(dt);
        } catch (e) {
          note(ctx, `crashed at t≈${(t + dt).toFixed(1)} s: ${errText(e)}`);
          return false;
        }
        t += cur.playing ? dt : 0;
        result.frames++;
      }
      return true;
    };

    const inkOf = () => {
      const c = stages()[0]?.canvas;
      if (!c || !c.width || !c.height) return 1;
      const g = c.getContext("2d");
      if (!g) return 1;
      const { data } = g.getImageData(0, 0, c.width, c.height);
      let ink = 0;
      let n = 0;
      for (let i = 3; i < data.length; i += 4 * 7) {
        n++;
        if (data[i] > 16) ink++;
      }
      return n ? ink / n : 1;
    };

    let baseInk = 0;
    const inspect = (ctx: string) => {
      for (const m of drainErrors()) note(ctx, `console error: ${m.slice(0, 200)}`);
      for (const r of demo.readouts) {
        const v = readouts.current[r.id];
        if (v === undefined) continue;
        const text = String(v);
        if ((typeof v === "number" && !Number.isFinite(v)) || BROKEN.test(text)) note(ctx, `readout "${r.label.replace(/\$/g, "")}" (${r.id}) shows "${text}"`);
        else if (text.trim() && text.trim() !== "—") ever.add(r.id);
      }
      const ink = inkOf();
      if (baseInk > 0.004 && ink < 0.0002) note(ctx, "the stage goes blank (nothing drawn)");
    };

    /** One scenario: apply props, (re)mount after a render crash, run frames, inspect. */
    const scenario = async (ctx: string, patch: Partial<Harness>, seconds: number, opts: { dts?: number[]; share?: number } = {}) => {
      if (cancelled) return;
      result.scenarios++;
      if (renderError.current) {
        renderError.current = null;
        await apply({ ...patch, mount: cur.mount + 1 });
      } else await apply(patch);
      if (!(await waitStage())) {
        if (renderError.current) note(ctx, `failed to render: ${errText(renderError.current)}`);
        return;
      }
      drainErrors();
      window.__fmtNonFinite = 0;
      run(ctx, framesFor(seconds, opts.share), opts.dts);
      const nf = window.__fmtNonFinite ?? 0;
      nonFinite.push({ ctx, n: nf });
      if (nf > 0) note(ctx, `fmt() was given NaN/Infinity (the readout shows "—" but its value is broken)`);
      inspect(ctx);
      if (renderError.current) note(ctx, `failed to render: ${errText(renderError.current)}`);
    };

    (async () => {
      await new Promise((r) => setTimeout(r, 0));
      if (cancelled) return;
      if (!(await waitStage())) {
        note(`beat 0`, renderError.current ? `failed to render: ${errText(renderError.current)}` : "never drew a stage");
        return;
      }
      // Measure the frame cost to size the scenarios to the budget.
      const m0 = performance.now();
      run("beat 0", 20);
      perFrame = (performance.now() - m0) / 20;
      baseInk = inkOf();
      inspect("beat 0");

      // Every beat, run long (step-throughs wrap and hold; simulations drift), with a restart mid-way.
      for (let b = 0; b < demo.beats.length && !cancelled; b++) {
        const p = { params: base(b), preset: demo.beats[b].preset, playing: true, w: BASE_SIZE.w, h: BASE_SIZE.h };
        await scenario(`beat ${b}`, { ...p, resetKey: cur.resetKey + 1 }, b === 0 ? 40 : 20, { share: 0.12 });
        await scenario(`beat ${b} after a restart`, { resetKey: cur.resetKey + 1 }, 6, { share: 0.03 });
      }
      // Irregular frame times (within the kit's clamp), pause/play.
      await scenario("irregular frame times", { params: base(0), preset: demo.beats[0]?.preset ?? "", resetKey: cur.resetKey + 1 }, 6, { dts: [0, 1e-4, FRAME, 1 / 240, FRAME, 0, FRAME / 3], share: 0.04 });
      await scenario("while paused", { playing: false }, 1, { share: 0.01 });
      await scenario("after resuming", { playing: true }, 2, { share: 0.02 });
      // Every preset from a fresh start.
      for (const pr of demo.presets) await scenario(`preset "${pr.id}"`, { params: { ...pr.params }, preset: pr.id, resetKey: cur.resetKey + 1 }, 4, { share: 0.03 });
      // Every control value, changed live (no restart), from beat 0's state.
      const rnd = prng(0x5eed + demo.id.length);
      const start = base(0);
      for (const c of demo.controls) {
        for (const { v, what } of sweep(c, rnd)) await scenario(what, { params: { ...start, [c.id]: v }, preset: demo.beats[0]?.preset ?? "" }, 2.5, { share: 0.02 });
      }
      // Extremes of up to three sliders together.
      const sliders = demo.controls.filter((c): c is Extract<ControlSpec, { type: "slider" }> => c.type === "slider").slice(0, 3);
      if (sliders.length > 1) {
        const all = (f: (c: (typeof sliders)[number], i: number) => number) => Object.fromEntries(sliders.map((c, i) => [c.id, f(c, i)]));
        const names = sliders.map((c) => `"${c.label.replace(/\$/g, "")}"`).join(", ");
        await scenario(`${names} all at min`, { params: { ...start, ...all((c) => c.min) }, resetKey: cur.resetKey + 1 }, 2.5, { share: 0.02 });
        await scenario(`${names} all at max`, { params: { ...start, ...all((c) => c.max) }, resetKey: cur.resetKey + 1 }, 2.5, { share: 0.02 });
        await scenario(`${names} at alternating extremes`, { params: { ...start, ...all((c, i) => (i % 2 ? c.max : c.min)) }, resetKey: cur.resetKey + 1 }, 2.5, { share: 0.02 });
      }
      // Resizes mid-run.
      await apply({ params: start, preset: demo.beats[0]?.preset ?? "", resetKey: cur.resetKey + 1 });
      for (const s of SIZES) await scenario(s.label, { w: s.w, h: s.h }, 1.5, { share: 0.02 });
      await scenario("back at the normal size", { w: BASE_SIZE.w, h: BASE_SIZE.h }, 1, { share: 0.01 });

      for (const r of demo.readouts) {
        if (!ever.has(r.id) && readouts.current[r.id] !== undefined) note("every case", `readout "${r.label.replace(/\$/g, "")}" (${r.id}) never shows a value`);
      }
      result.nonFinite = nonFinite.filter((x) => x.n > 0);
    })()
      .catch((e) => note("the audit", `stopped: ${errText(e)}`))
      .finally(() => {
        if (cancelled) return;
        result.notes = [...found.entries()].map(([msg, { ctx, more }]) => `stress: ${ctx}${/^(crashed|failed to render|never drew|stopped)/.test(msg) ? " " : ": "}${msg}${more ? ` (and ${more} more case${more > 1 ? "s" : ""})` : ""}`);
        result.ms = Math.round(performance.now() - t0);
        result.done = true;
      });
    return () => {
      cancelled = true;
    };
    // Runs once per mount; the harness state is driven from inside.
  }, []);

  if (!Demo) return <p>unknown demo component</p>;
  return (
    <div style={{ width: h.w, height: h.h }}>
      <Boundary key={h.mount} onError={(e) => (renderError.current = e)}>
        <Suspense fallback={null}>
          <Demo
            config={demo.config}
            params={h.params}
            preset={h.preset}
            playing={h.playing}
            resetKey={h.resetKey}
            width={h.w}
            height={h.h}
            setReadouts={(v) => {
              Object.assign(readouts.current, v);
            }}
          />
        </Suspense>
      </Boundary>
    </div>
  );
}
