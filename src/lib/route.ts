// Hash routes: `#/` is the library, `#/<book>/<unit>/<section>` a place in a book,
// `#/build/<job>` a build in progress (or finished).

export interface Route {
  book?: string;
  unit?: string;
  section?: string;
  job?: string;
}

export function parseHash(hash = location.hash): Route {
  const m = /^#\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?\/?$/.exec(decodeURIComponent(hash));
  if (!m) return {};
  if (m[1] === "build" && m[2]) return { job: m[2] };
  return { book: m[1], unit: m[2], section: m[3] };
}

export const buildHash = (job: string) => `#/build/${encodeURIComponent(job)}`;

export function hashFor(r: Route): string {
  const parts = [r.book, r.book && r.unit, r.book && r.unit && r.section].filter(Boolean) as string[];
  return `#/${parts.map(encodeURIComponent).join("/")}`;
}
