// `/?demo=<book>/<unit>/<demoId>&beat=<index>`: only the demo pane, for
// automated screenshots. Exposes window.__demoReady, window.__demoErrors and (from the
// kit's Stage) window.__stageText / __stageSize for layout checks.

import { useCallback, useEffect, useState } from "react";
import { planFor } from "./lib/data";
import { DemoPane } from "./demo/DemoPane";

declare global {
  interface Window {
    __demoReady?: boolean;
    __demoErrors?: string[];
  }
}

const push = (e: unknown) => {
  const list = (window.__demoErrors ??= []);
  const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  if (!list.includes(msg)) list.push(msg);
};

/** Collect every error the page produces into window.__demoErrors. Call once, before render. */
export function installErrorCapture() {
  window.__demoErrors = [];
  // Stages record their text boxes (window.__stageText) for the verifier's layout checks.
  window.__yagamiInstrument = true;
  window.addEventListener("error", (e) => push(e.error ?? e.message));
  window.addEventListener("unhandledrejection", (e) => push(e.reason));
  const consoleError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    push(args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(" "));
    consoleError(...args);
  };
}

export function Isolated({ demo, beat }: { demo: string; beat: number }) {
  const parts = demo.split("/");
  const [book, unit, demoId] = parts;
  const unitKey = `${book}/${unit}`;
  const spec = planFor(unitKey)?.demos.find((d) => d.id === demoId);
  const beatRef = spec && spec.beats[beat] ? { demo: spec, beat: spec.beats[beat], index: beat } : null;
  const [playing, setPlaying] = useState(true);
  const [resetKey, setResetKey] = useState(0);

  const ready = useCallback(() => {
    window.__demoReady = true;
  }, []);
  const onError = useCallback((e: unknown) => {
    push(e);
    window.__demoReady = true;
  }, []);

  useEffect(() => {
    if (!beatRef) onError(new Error(`Unknown demo or beat: ${demo} beat ${beat}`));
  }, [beatRef, demo, beat, onError]);

  return (
    <div className="isolated">
      <DemoPane
        unitKey={unitKey}
        beat={beatRef}
        playing={playing}
        resetKey={resetKey}
        onTogglePlay={() => setPlaying((p) => !p)}
        onRestart={() => setResetKey((k) => k + 1)}
        onReady={ready}
        onError={onError}
        emptyText="Unknown demo."
      />
    </div>
  );
}
