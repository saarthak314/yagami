// Hash routes: `#/` is the library, `#/<book>/<unit>/<section>` a place in a book,
// `#/build/<job>` a build in progress (or finished), `#/connect` setting up a model.

export interface Route {
  book?: string;
  unit?: string;
  section?: string;
  job?: string;
  connect?: boolean;
}

export function parseHash(hash = location.hash): Route {
  const m = /^#\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?\/?$/.exec(decodeURIComponent(hash));
  if (!m) return {};
  if (m[1] === "build" && m[2]) return { job: m[2] };
  if (m[1] === "connect" && !m[2]) return { connect: true };
  return { book: m[1], unit: m[2], section: m[3] };
}

export const buildHash = (job: string) => `#/build/${encodeURIComponent(job)}`;
export const CONNECT_HASH = "#/connect";

export function hashFor(r: Route): string {
  const parts = [r.book, r.book && r.unit, r.book && r.unit && r.section].filter(Boolean) as string[];
  return `#/${parts.map(encodeURIComponent).join("/")}`;
}

// A fresh install (no model set up) is sent to the connect page once per browser session: after
// that (visited or skipped) the library stays the library.
const CONNECT_SEEN = "yagami:connect-seen";

export function connectSeen(): boolean {
  try {
    return sessionStorage.getItem(CONNECT_SEEN) === "1";
  } catch {
    return true; // no storage: never redirect (it couldn't be remembered)
  }
}

export function markConnectSeen() {
  try {
    sessionStorage.setItem(CONNECT_SEEN, "1");
  } catch {
    // storage unavailable
  }
}
