// 16px stroke icons, drawn to match the Geist UI weight (1.5px, round caps).

import type { ReactNode } from "react";

function Icon({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  );
}

export const ChevronLeft = () => (
  <Icon>
    <path d="M10 4L6 8l4 4" />
  </Icon>
);
export const ChevronRight = () => (
  <Icon>
    <path d="M6 4l4 4-4 4" />
  </Icon>
);
export const ChevronUp = () => (
  <Icon>
    <path d="M4 10l4-4 4 4" />
  </Icon>
);
export const ChevronDown = () => (
  <Icon>
    <path d="M4 6l4 4 4-4" />
  </Icon>
);
export const Search = () => (
  <Icon>
    <circle cx="7" cy="7" r="4.25" />
    <path d="M10.25 10.25L13.5 13.5" />
  </Icon>
);
/** Contents: a list. */
export const ListIcon = () => (
  <Icon>
    <path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01" />
  </Icon>
);
/** Demo pane: a window with its right part split off. */
export const PanelRight = () => (
  <Icon>
    <rect x="2" y="3" width="12" height="10" rx="1.5" />
    <path d="M9.5 3v10" />
  </Icon>
);
export const Expand = () => (
  <Icon>
    <path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5L9 7M2.5 13.5L7 9" />
  </Icon>
);
export const Collapse = () => (
  <Icon>
    <path d="M13 7H9V3M3 9h4v4M9 7l4.5-4.5M7 9l-4.5 4.5" />
  </Icon>
);
/** "Show in text": a crosshair. */
export const Locate = () => (
  <Icon>
    <circle cx="8" cy="8" r="4.5" />
    <path d="M8 1.5v2.5M8 12v2.5M1.5 8H4M12 8h2.5" />
  </Icon>
);
export const Pin = () => (
  <Icon>
    <path d="M6 2.5h4M7 2.5v4L4.5 9h7L9 6.5v-4M8 9v4.5" />
  </Icon>
);
/** Page size menu (phones). */
export const ZoomIcon = () => (
  <Icon>
    <circle cx="7" cy="7" r="4.25" />
    <path d="M10.25 10.25L13.5 13.5M5 7h4M7 5v4" />
  </Icon>
);
export const Minus = () => (
  <Icon>
    <path d="M3.5 8h9" />
  </Icon>
);
export const Plus = () => (
  <Icon>
    <path d="M3.5 8h9M8 3.5v9" />
  </Icon>
);
export const Copy = () => (
  <Icon>
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
    <path d="M10.5 3.5V3a1 1 0 00-1-1H3a1 1 0 00-1 1v6.5a1 1 0 001 1h.5" />
  </Icon>
);
export const Check = () => (
  <Icon>
    <path d="M3 8.5l3 3 7-7" />
  </Icon>
);
export const Close = () => (
  <Icon>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Icon>
);
