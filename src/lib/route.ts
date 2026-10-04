// Hash routes: `#/` is the library, `#/<book>/<unit>/<section>` a place in a book.

export interface Route {
  book?: string;
  unit?: string;
  section?: string;
}

export function parseHash(hash = location.hash): Route {
  const m = /^#\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?\/?$/.exec(decodeURIComponent(hash));
  return m ? { book: m[1], unit: m[2], section: m[3] } : {};
}

export function hashFor(r: Route): string {
  const parts = [r.book, r.book && r.unit, r.book && r.unit && r.section].filter(Boolean) as string[];
  return `#/${parts.map(encodeURIComponent).join("/")}`;
}
