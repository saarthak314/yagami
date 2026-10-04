import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "katex/dist/katex.min.css";
import "./styles.css";
import { App } from "./App";
import { Isolated, installErrorCapture } from "./Isolated";
import { applyTheme, savedTheme } from "./theme/apply";
import { parseHash } from "./lib/route";
import { RESUME } from "./lib/store";

const params = new URLSearchParams(location.search);
const demo = params.get("demo");
if (demo) installErrorCapture();
// The pipeline's screenshot mode (?demo=) stays on yagami dark unless &theme= asks otherwise.
applyTheme(demo ? params.get("theme") : savedTheme());

// If a build forces a full reload while you read, come back to the exact spot.
import.meta.hot?.on("vite:beforeFullReload", () => {
  const { book } = parseHash();
  if (book && book !== "build") sessionStorage.setItem(RESUME, book);
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>{demo ? <Isolated demo={demo} beat={Number(params.get("beat") ?? 0)} /> : <App />}</StrictMode>,
);
