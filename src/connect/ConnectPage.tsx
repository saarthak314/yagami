// `#/connect`: setting up a model, for a fresh install (sent here once per session when nothing is
// set up) — the same rows as the header's model panel, as larger cards, then "you're set".

import { useEffect, useRef } from "react";
import type { Health } from "../lib/api";
import { markConnectSeen } from "../lib/route";
import { Mark } from "../ui/Brand";
import { HelpButton } from "../ui/Help";
import { ThemeMenu } from "../ui/ThemeMenu";
import { Check } from "../ui/icons";
import { LABEL, ModelChooser, activeReady, useModelAccess } from "../ui/ModelChooser";

export function ConnectPage({ health, help, onHelp }: { health: Health | null | undefined; help: boolean; onHelp: (v: boolean) => void }) {
  const m = useModelAccess(health);
  const heading = useRef<HTMLHeadingElement>(null);
  const go = useRef<HTMLAnchorElement>(null);
  const done = activeReady(m.view);
  const wasDone = useRef<boolean | null>(null);
  const { clearFinished } = m;

  useEffect(() => {
    markConnectSeen();
    document.title = "connect a model · yagami";
    heading.current?.focus({ preventScroll: true });
    return () => {
      document.title = "yagami";
      clearFinished();
    };
  }, [clearFinished]);

  // Set up just now (not on arrival): focus moves to the next step.
  useEffect(() => {
    if (!m.view) return;
    if (wasDone.current === false && done) go.current?.focus({ preventScroll: true });
    wasDone.current = done;
  }, [done, m.view]);

  // What the page shows changed (the view arrived, the server answered) and took focus with it: back to the heading.
  const branch = health === null ? "static" : done && m.view?.active ? "done" : "choose";
  useEffect(() => {
    const a = document.activeElement;
    if (!a || a === document.body) heading.current?.focus({ preventScroll: true });
  }, [branch]);

  const active = m.view?.active;
  const who = active ? (active === "anthropic" || active === "openai" ? `your ${LABEL[active]}` : LABEL[active]) : "";

  return (
    <div className="app connect-app">
      <header className="connect-top">
        <span className="spacer" />
        <ThemeMenu />
        <HelpButton open={help} onOpenChange={onHelp} context="library" />
      </header>
      <main className="connect">
        <div className="connect-inner">
          <a className="connect-brand" href="#/" aria-label="yagami library">
            <Mark size={18} />
            <span className="wordmark">yagami</span>
          </a>
          {health === null ? (
            <>
              <h1 tabIndex={-1} ref={heading}>
                connect a model
              </h1>
              <p className="connect-static">connecting a model needs yagami running on your computer. this copy is read-only.</p>
              <a className="connect-skip" href="#/">
                go to the library
              </a>
            </>
          ) : done && active ? (
            <div className="connect-done">
              <span className="connect-check" aria-hidden>
                <Check />
              </span>
              <h1 tabIndex={-1} ref={heading}>
                you're set
              </h1>
              <p className="connect-lede" id="connect-done-what">
                {who} will build your books.
              </p>
              <a className="btn primary connect-go" href="#/" ref={go} aria-describedby="connect-done-what">
                go to the library
              </a>
            </div>
          ) : (
            <>
              <h1 tabIndex={-1} ref={heading}>
                connect a model
              </h1>
              <p className="connect-lede">yagami writes its demos with a model. use a plan you already have, or an api key.</p>
              <ModelChooser m={m} variant="page" />
              <a className="connect-skip" href="#/">
                skip — just read
              </a>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
