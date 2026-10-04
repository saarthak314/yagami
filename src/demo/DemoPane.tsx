// The demo pane: title, caption, stage, transport, controls and readouts for
// the active beat. Parameter merge order: preset → beat ("text values") → user edits.

import { Component, Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import type { ControlSpec, DemoProps, Params, ParamValue } from "../types";
import { loaderFor, type BeatRef } from "../lib/data";
import { Inline } from "../lib/inline";
import { ChevronLeft, ChevronRight, Collapse, Expand, Locate, Pin } from "../ui/icons";

/** Narrowest width a demo is laid out at (wider than the phone sheet and the smallest pane). */
const STAGE_MIN = 480;

const lazyCache = new Map<string, ComponentType<DemoProps>>();
function lazyComponent(unitKey: string, name: string): ComponentType<DemoProps> | null {
  const key = `${unitKey}/${name}`;
  let c = lazyCache.get(key);
  if (!c) {
    const load = loaderFor(unitKey, name);
    if (!load) return null;
    c = lazy(load);
    lazyCache.set(key, c);
  }
  return c;
}

class DemoBoundary extends Component<{ children: ReactNode; onError?: (e: unknown) => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    this.props.onError?.(error);
  }
  render() {
    return this.state.failed ? <p className="demo-quiet">This demo failed to load.</p> : this.props.children;
  }
}

/** Mounted inside Suspense next to the demo: fires once the demo has painted and readouts have flushed. */
function ReadySignal({ onReady }: { onReady?: () => void }) {
  useEffect(() => {
    if (!onReady) return;
    let a = 0;
    let b = 0;
    let t = 0;
    a = requestAnimationFrame(() => {
      b = requestAnimationFrame(() => {
        t = window.setTimeout(onReady, 250);
      });
    });
    return () => {
      cancelAnimationFrame(a);
      cancelAnimationFrame(b);
      clearTimeout(t);
    };
  }, [onReady]);
  return null;
}

interface Props {
  /** "<book>/<unit>" the demos belong to. */
  unitKey: string;
  beat: BeatRef | null;
  playing: boolean;
  resetKey: number;
  onTogglePlay: () => void;
  onRestart: () => void;
  /** This step's place among the demo's steps, with navigation between them. */
  step?: { index: number; total: number; onPrev?: () => void; onNext?: () => void };
  /** Scroll the text to this step's paragraph. */
  onShowInText?: () => void;
  pinned?: boolean;
  onTogglePin?: () => void;
  focused?: boolean;
  onToggleFocus?: () => void;
  /** Hide the title row (the phone sheet shows it in its own bar). */
  bare?: boolean;
  onReady?: () => void;
  onError?: (e: unknown) => void;
  emptyText?: string;
}

export function DemoPane(props: Props) {
  const { beat } = props;
  // Fade only when the demo itself changes, not between beats of one demo.
  const lastDemo = useRef<string | null>(null);
  const fade = beat !== null && lastDemo.current !== null && lastDemo.current !== beat.demo.id;
  useEffect(() => {
    lastDemo.current = beat?.demo.id ?? null;
  });
  if (!beat) {
    return (
      <section className="demo-pane">
        <p className="demo-quiet">{props.emptyText ?? "No demos for this unit yet."}</p>
      </section>
    );
  }
  // Remount the inner state whenever the beat changes, so user edits reset.
  return <BeatView key={`${beat.demo.id}#${beat.index}`} {...props} beat={beat} fade={fade} />;
}

function BeatView(props: Props & { beat: BeatRef; fade: boolean }) {
  const { fade, unitKey, beat, playing, resetKey, onTogglePlay, onRestart, onReady, onError } = props;
  const { demo } = beat;
  const [presetOverride, setPresetOverride] = useState<string | null>(null);
  const [edits, setEdits] = useState<Params>({});
  const presetId = presetOverride ?? beat.beat.preset;
  const preset = demo.presets.find((p) => p.id === presetId) ?? demo.presets[0];

  const params = useMemo<Params>(
    () => ({ ...preset?.params, ...(presetOverride ? {} : beat.beat.params), ...edits }),
    [preset, presetOverride, beat.beat.params, edits],
  );
  const dirty = presetOverride !== null || Object.keys(edits).length > 0;

  // Readouts: demos may publish every frame; flush to React at ~10 Hz.
  const pending = useRef<Record<string, string | number> | null>(null);
  const [readouts, setReadoutState] = useState<Record<string, string | number>>({});
  const setReadouts = useCallback((v: Record<string, string | number>) => {
    pending.current = { ...pending.current, ...v };
  }, []);
  useEffect(() => {
    const id = setInterval(() => {
      if (pending.current) {
        const next = pending.current;
        pending.current = null;
        setReadoutState((prev) => ({ ...prev, ...next }));
      }
    }, 100);
    return () => clearInterval(id);
  }, []);

  // Stage size.
  const stageRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const set = () => setSize({ w: Math.floor(el.clientWidth), h: Math.floor(el.clientHeight) });
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const Demo = lazyComponent(unitKey, demo.component);
  // Demos are laid out for at least STAGE_MIN px; narrower stages render at that width and scale down.
  const scale = size.w > 0 && size.w < STAGE_MIN ? size.w / STAGE_MIN : 1;
  const logical = { w: Math.round(size.w / scale), h: Math.round(size.h / scale) };
  const setParam = (id: string, v: ParamValue) => setEdits((e) => ({ ...e, [id]: v }));

  return (
    <section className="demo-pane">
      <div className={fade ? "demo-body fade-in" : "demo-body"}>
        <header className="demo-head">
          {!props.bare && <DemoTitleRow {...props} />}
          <p className="demo-caption">
            <Inline md={subscriptsMd(beat.beat.caption)} />
          </p>
        </header>
        <div className="demo-stage" ref={stageRef}>
          {size.w > 0 && size.h > 0 && (
            <div className="stage-scale" style={scale < 1 ? { width: logical.w, height: logical.h, transform: `scale(${scale})` } : undefined}>
            <DemoBoundary key={`${demo.id}`} onError={onError}>
              {Demo ? (
                <Suspense fallback={null}>
                  <Demo
                    params={params}
                    preset={preset?.id ?? ""}
                    playing={playing}
                    resetKey={resetKey}
                    width={logical.w}
                    height={logical.h}
                    setReadouts={setReadouts}
                  />
                  <ReadySignal onReady={onReady} />
                </Suspense>
              ) : (
                <MissingDemo onError={onError} name={demo.component} />
              )}
            </DemoBoundary>
            </div>
          )}
        </div>
      </div>

      <div className="demo-controls">
        <div className="row">
          <button className="btn" onClick={onTogglePlay} aria-pressed={!playing}>
            {playing ? "Pause" : "Play"}
          </button>
          <button className="btn" onClick={onRestart}>
            Restart
          </button>
          {dirty && (
            <button
              className="btn"
              title="Put back the values this paragraph uses"
              onClick={() => {
                setEdits({});
                setPresetOverride(null);
              }}
            >
              Reset to text
            </button>
          )}
        </div>

        {(demo.presets.length > 1 || demo.controls.length > 0) && (
          <div className="controls-grid">
            {demo.presets.length > 1 && (
              <label className="control setup">
                <span className="control-label">Setup</span>
                <select
                  className="select"
                  aria-label="Setup"
                  value={preset?.id}
                  onChange={(e) => {
                    setPresetOverride(e.target.value);
                    setEdits({});
                  }}
                >
                  {demo.presets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {demo.controls.map((c) => (
              <ControlView key={c.id} spec={c} value={params[c.id]} onChange={(v) => setParam(c.id, v)} />
            ))}
          </div>
        )}

        {demo.readouts.length > 0 && (
          <dl className="readouts">
            {demo.readouts.map((r) => (
              <div key={r.id} className="readout">
                <dt>
                  <Inline md={r.label} />
                </dt>
                <dd data-readout={r.id}>{readouts[r.id] ?? "—"}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </section>
  );
}

function MissingDemo({ name, onError }: { name: string; onError?: (e: unknown) => void }) {
  useEffect(() => {
    onError?.(new Error(`Demo component not found: ${name}`));
  }, [name, onError]);
  return <p className="demo-quiet">This demo failed to load.</p>;
}

/**
 * Plan text sometimes writes bare subscripts ("ρ_max", "C_x"); typeset those
 * as math. Text already inside $…$ is left alone.
 */
function subscriptsMd(md: string): string {
  return md
    .split(/(\$[^$]*\$)/)
    .map((part) =>
      part.startsWith("$")
        ? part
        : part.replace(/(?<![A-Za-z0-9_])([A-Za-zα-ωΑ-Ω])_(\{[^}]+\}|[A-Za-z0-9]+)/g, (_, base: string, sub: string) => `$${base}_{${sub.replace(/^\{|\}$/g, "")}}$`),
    )
    .join("");
}

/** Label text without $…$ math markup, for screen readers. */
const plainLabel = (md: string) => md.replace(/\$([^$]*)\$/g, (_, m: string) => m.replace(/[\\{}]/g, "").replace(/_/g, " ")).trim();

function ControlView({ spec, value, onChange }: { spec: ControlSpec; value: ParamValue | undefined; onChange: (v: ParamValue) => void }) {
  if (spec.type === "slider") {
    const v = Number(value ?? spec.min);
    const decimals = Math.max(0, (String(spec.step).split(".")[1] ?? "").length);
    return (
      <label className="control">
        <span className="control-label">
          <Inline md={subscriptsMd(spec.label)} />
        </span>
        <input type="range" className="range" aria-label={plainLabel(spec.label)} aria-valuetext={`${v.toFixed(decimals)}${spec.unit ? ` ${spec.unit}` : ""}`} min={spec.min} max={spec.max} step={spec.step} value={v} onChange={(e) => onChange(Number(e.target.value))} />
        <span className="control-value">
          {v.toFixed(decimals)}
          {spec.unit ? ` ${spec.unit}` : ""}
        </span>
      </label>
    );
  }
  if (spec.type === "toggle") {
    return (
      <label className="control toggle">
        <input type="checkbox" className="check" aria-label={plainLabel(spec.label)} checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
        <span className="control-label">
          <Inline md={subscriptsMd(spec.label)} />
        </span>
      </label>
    );
  }
  return (
    <label className="control">
      <span className="control-label">
          <Inline md={subscriptsMd(spec.label)} />
        </span>
      <select className="select" aria-label={plainLabel(spec.label)} value={String(value ?? spec.options[0]?.value)} onChange={(e) => onChange(e.target.value)}>
        {spec.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Title row: demo name, then show-in-text, pin and focus. */
export function DemoTitleRow({ beat, step, onShowInText, pinned, onTogglePin, focused, onToggleFocus }: Props) {
  if (!beat) return null;
  return (
    <div className="demo-title-row">
      <h2 className="demo-title">
        <Inline md={beat.demo.title} />
      </h2>
      <span className="spacer" />
      {step && step.total > 1 && <StepNav step={step} />}
      {onShowInText && (
        <button className="btn icon ghost" onClick={onShowInText} aria-label="Show in text" title="Show this paragraph in the text">
          <Locate />
        </button>
      )}
      {onTogglePin && (
        <button className="btn icon ghost" onClick={onTogglePin} aria-pressed={pinned} aria-label="Pin demo" title={pinned ? "Unpin: follow the text again (h)" : "Pin: keep this demo while scrolling (h)"}>
          <Pin />
        </button>
      )}
      {onToggleFocus && (
        <button className="btn icon ghost" onClick={onToggleFocus} aria-pressed={focused} aria-label={focused ? "Exit focus" : "Focus on demo"} title={focused ? "Back to reading (Esc)" : "Focus on the demo (f)"}>
          {focused ? <Collapse /> : <Expand />}
        </button>
      )}
    </div>
  );
}

/** "‹ 2 / 6 ›": this step among the demo's steps. */
export function StepNav({ step }: { step: NonNullable<Props["step"]> }) {
  return (
    <div className="step-nav" aria-label={`Step ${step.index + 1} of ${step.total}`}>
      <button className="btn icon ghost" onClick={step.onPrev} disabled={!step.onPrev} aria-label="Previous step" title="Previous step">
        <ChevronLeft />
      </button>
      <span className="step-count">
        {step.index + 1} / {step.total}
      </span>
      <button className="btn icon ghost" onClick={step.onNext} disabled={!step.onNext} aria-label="Next step" title="Next step">
        <ChevronRight />
      </button>
    </div>
  );
}
