// The demo pane: title, caption, stage, transport, controls and readouts for
// the active beat. Parameter merge order: preset → beat ("text values") → user edits.

import { Component, Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import type { ControlSpec, DemoProps, Params, ParamValue, Preset } from "../types";
import { loaderFor, type BeatRef } from "../lib/data";
import { templateComponent } from "./templates";
import { Inline } from "../lib/inline";
import { formatReadout } from "../lib/format";
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
    return this.state.failed ? <p className="demo-quiet">this demo failed to load.</p> : this.props.children;
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
        <p className="demo-quiet">{props.emptyText ?? "no demos for this chapter yet."}</p>
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

  // Template demos render a library component with their config; others load their generated file.
  const Template = demo.template ? templateComponent(demo.template) : null;
  const Demo = demo.template ? null : lazyComponent(unitKey, demo.component);
  // Demos are laid out for at least STAGE_MIN px; narrower stages render at that width and scale down.
  const scale = size.w > 0 && size.w < STAGE_MIN ? size.w / STAGE_MIN : 1;
  const logical = { w: Math.round(size.w / scale), h: Math.round(size.h / scale) };
  const setParam = (id: string, v: ParamValue) => setEdits((e) => ({ ...e, [id]: v }));
  const showSetup = demo.presets.length > 1 && !setupDuplicated(demo.presets, demo.controls);
  // Sliders and pickers get a full row each (a slider needs length to be usable); switches share rows after them.
  const rows = demo.controls.filter((c) => c.type !== "toggle");
  const toggles = demo.controls.filter((c) => c.type === "toggle");

  return (
    <section className="demo-pane">
      <div className={fade ? "demo-body fade-in" : "demo-body"}>
        <header className="demo-head">
          {!props.bare && <DemoTitleRow {...props} />}
          <p className="demo-caption">
            <Inline md={subscriptsMd(beat.beat.caption)} />
          </p>
          {/* Verify couldn't confirm this demo: say so, quietly. (Not in isolated mode — the checks' own view.) */}
          {/* One quiet line; the reason opens on demand. */}
          {demo.flagged && !onReady && (
            <details className="demo-flag">
              <summary>this demo may be inaccurate</summary>
              <p>{demo.flagged}</p>
            </details>
          )}
        </header>
        <div className="demo-stage" ref={stageRef}>
          {size.w > 0 && size.h > 0 && (
            <div className="stage-scale" style={scale < 1 ? { width: logical.w, height: logical.h, transform: `scale(${scale})` } : undefined}>
            <DemoBoundary key={`${demo.id}`} onError={onError}>
              {Demo || Template ? (
                <Suspense fallback={<div className="skel stage-skel" aria-label="loading the demo" />}>
                  {Template ? (
                    <Template
                      config={demo.config}
                      params={params}
                      preset={preset?.id ?? ""}
                      playing={playing}
                      resetKey={resetKey}
                      width={logical.w}
                      height={logical.h}
                      setReadouts={setReadouts}
                    />
                  ) : (
                    Demo && (
                      <Demo
                        params={params}
                        preset={preset?.id ?? ""}
                        playing={playing}
                        resetKey={resetKey}
                        width={logical.w}
                        height={logical.h}
                        setReadouts={setReadouts}
                      />
                    )
                  )}
                  <ReadySignal onReady={onReady} />
                </Suspense>
              ) : (
                <MissingDemo onError={onError} name={demo.template ? `template "${demo.template}"` : demo.component} />
              )}
            </DemoBoundary>
            </div>
          )}
        </div>
      </div>

      <div className="demo-controls">
        <div className="row transport">
          <button className="btn ghost small" onClick={onTogglePlay} aria-pressed={!playing} title="play / pause (space)">
            <Glyph d={playing ? "M5.5 4v8M10.5 4v8" : "M5 3.5v9l7.5-4.5z"} />
            {playing ? "pause" : "play"}
          </button>
          <button className="btn ghost small" onClick={onRestart} title="restart (r)">
            <Glyph d="M3.5 8a4.5 4.5 0 1 0 1.3-3.2M3.5 3v2.5H6" />
            restart
          </button>
          {dirty && (
            <button
              className="btn ghost small"
              title="put back the values this paragraph uses"
              onClick={() => {
                setEdits({});
                setPresetOverride(null);
              }}
            >
              reset to text
            </button>
          )}
        </div>

        {(showSetup || rows.length > 0) && (
          <div className="controls-grid">
            {showSetup && (
              <label className="control setup">
                <span className="control-label">setup</span>
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
            {rows.map((c) => (
              <ControlView key={c.id} spec={c} value={params[c.id]} onChange={(v) => setParam(c.id, v)} />
            ))}
          </div>
        )}
        {toggles.length > 0 && (
          <div className="controls-toggles">
            {toggles.map((c) => (
              <ControlView key={c.id} spec={c} value={params[c.id]} onChange={(v) => setParam(c.id, v)} />
            ))}
          </div>
        )}

        {demo.readouts.length > 0 && (
          <dl className="readouts">
            {demo.readouts.map((r) => (
              <div key={r.id} className="readout">
                <dt>
                  <Inline md={quietCase(r.label, true)} />
                </dt>
                <ReadoutValue id={r.id} value={readouts[r.id]} />
              </div>
            ))}
          </dl>
        )}
      </div>
    </section>
  );
}

/** A 12px transport glyph, drawn like the ui icons (1.5px round strokes). */
const Glyph = ({ d }: { d: string }) => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
);

function MissingDemo({ name, onError }: { name: string; onError?: (e: unknown) => void }) {
  useEffect(() => {
    onError?.(new Error(`Demo component not found: ${name}`));
  }, [name, onError]);
  // The verifier (isolated mode) treats this as a failure; in the reader it means the
  // demo is planned but its code isn't written yet (a build is still running).
  if (onError) return <p className="demo-quiet">this demo failed to load.</p>;
  return (
    <div className="stage-pending">
      <div className="skel stage-skel" aria-hidden />
      <p className="demo-quiet">this demo is still being made — it appears here when it's ready.</p>
    </div>
  );
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

/**
 * The pane sets its titles and labels in lower case. Only plain capitalised words are lowered ("Gambler's" →
 * "gambler's"), so acronyms (BN, RMS), code names (ChainedHashTable, LayerNorm), numerals (II) and math keep
 * their case; so does code. `firstOnly`: just a label's opening word (the rest is as written).
 */
export function quietCase(md: string, firstOnly = false): string {
  const word = /(?<![\p{L}\p{N}_\\])(\p{Lu})(\p{Ll}+)(?![\p{L}\p{N}_])/gu;
  const parts = md.split(/(\$[^$]*\$|`[^`]*`)/);
  if (firstOnly) {
    parts[0] = parts[0].replace(/^(\s*)(\p{Lu})(\p{Ll}+)(?![\p{L}\p{N}_])/u, (_, sp: string, a: string, b: string) => sp + a.toLowerCase() + b);
    return parts.join("");
  }
  return parts.map((part) => (part.startsWith("$") || part.startsWith("`") ? part : part.replace(word, (_, a: string, b: string) => a.toLowerCase() + b))).join("");
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
        <Inline md={quietCase(subscriptsMd(spec.label), true)} />
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
        <Inline md={quietCase(subscriptsMd(spec.label), true)} />
      </span>
      </label>
    );
  }
  return (
    <label className="control">
      <span className="control-label">
        <Inline md={quietCase(subscriptsMd(spec.label), true)} />
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
        <Inline md={quietCase(beat.demo.title)} />
      </h2>
      <span className="spacer" />
      {step && (step.onPrev || step.onNext) && <StepNav step={step} />}
      {/* Secondary tools: quiet until the pane is hovered or focused (always shown when on, and on touch). */}
      <span className="demo-tools">
        {onShowInText && (
          <button className="btn icon ghost" onClick={onShowInText} aria-label="Show in text" title="show this paragraph in the text">
            <Locate />
          </button>
        )}
        {onTogglePin && (
          <button className="btn icon ghost" onClick={onTogglePin} aria-pressed={pinned} aria-label="Pin demo" title={pinned ? "unpin: follow the text again (h)" : "pin: keep this demo while scrolling (h)"}>
            <Pin />
          </button>
        )}
        {onToggleFocus && (
          <button className="btn icon ghost" onClick={onToggleFocus} aria-pressed={focused} aria-label={focused ? "Exit focus" : "Focus on demo"} title={focused ? "back to reading (esc)" : "focus on the demo (f)"}>
            {focused ? <Collapse /> : <Expand />}
          </button>
        )}
      </span>
    </div>
  );
}

/** "‹ 2 / 6 ›": this step among the demo's steps. */
export function StepNav({ step }: { step: NonNullable<Props["step"]> }) {
  return (
    <div className="step-nav" aria-label={`Step ${step.index + 1} of ${step.total}`}>
      <button className="btn icon ghost" onClick={step.onPrev} disabled={!step.onPrev} aria-label="Previous step" title="previous step (k)">
        <ChevronLeft />
      </button>
      <span className="step-count">
        {step.index + 1} / {step.total}
      </span>
      <button className="btn icon ghost" onClick={step.onNext} disabled={!step.onNext} aria-label="Next step" title="next step (j)">
        <ChevronRight />
      </button>
    </div>
  );
}

/**
 * The setup picker is redundant when a select control already switches between exactly the presets: each
 * preset sets that control to a different one of its options and they agree on every other parameter.
 */
function setupDuplicated(presets: Preset[], controls: ControlSpec[]): boolean {
  return controls.some((c) => {
    if (c.type !== "select") return false;
    const values = presets.map((p) => String(p.params[c.id]));
    if (new Set(values).size !== presets.length || !values.every((v) => c.options.some((o) => o.value === v))) return false;
    const [first, ...rest] = presets;
    const keys = new Set(presets.flatMap((p) => Object.keys(p.params)));
    keys.delete(c.id);
    return rest.every((p) => [...keys].every((k) => p.params[k] === first.params[k]));
  });
}

/** A readout value; non-finite numbers show "—" to the reader but stay visible to the checks (data-broken). */
function ReadoutValue({ id, value }: { id: string; value: string | number | undefined }) {
  const broken = typeof value === "number" && !Number.isFinite(value);
  return (
    <dd data-readout={id} data-broken={broken ? "1" : undefined}>
      {value === undefined || broken ? "—" : formatReadout(value)}
    </dd>
  );
}
