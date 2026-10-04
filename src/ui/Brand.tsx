// The yagami mark (a page beside a demo) and wordmark. Links to the library.

export function Mark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden className="mark">
      <rect x="1.75" y="2.75" width="6" height="10.5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <rect x="9.25" y="2" width="5.25" height="12" rx="1" fill="currentColor" />
    </svg>
  );
}

export function Brand({ wordmark = true }: { wordmark?: boolean }) {
  return (
    <a className="brand" href="#/" aria-label="yagami library">
      <Mark />
      {wordmark && <span className="wordmark">yagami</span>}
    </a>
  );
}
