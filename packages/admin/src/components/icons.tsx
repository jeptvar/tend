import type { ReactNode } from "react";

// Small line drawings beside the names in the menu. Every one sits next to words that say the
// same, so they're all hidden from screen readers.

const DRAWINGS = {
  overview: <path d="M4 11.5 12 5l8 6.5M6 10v9h12v-9M10 19v-5h4v5" />,
  posts: <path d="M5 5h14v14H5zM8 9h8M8 12h8M8 15h5" />,
  pages: <path d="M7 4h7l4 4v12H7zM14 4v4h4" />,
  media: (
    <>
      <path d="M4 6h16v12H4zM4 15l4.5-4 4 4 2.5-2 5 4" />
      <circle cx="15.5" cy="9.5" r="1.25" />
    </>
  ),
  menu: <path d="M9 7h11M9 12h11M9 17h11M4.5 7h.01M4.5 12h.01M4.5 17h.01" />,
  design: (
    <>
      <path d="M12 4a8 8 0 1 0 0 16c1.6 0 1.9-1 1.4-2-.6-1.2.2-2.5 1.6-2.5h2.2A2.8 2.8 0 0 0 20 12.7C20 7.8 16.4 4 12 4Z" />
      <path d="M8 11h.01M11 8h.01M15 8.5h.01" />
    </>
  ),
  people: (
    <>
      <circle cx="9" cy="9" r="3" />
      <path d="M3.5 19c.4-3 2.7-4.5 5.5-4.5s5.1 1.5 5.5 4.5M15.5 6.5a2.8 2.8 0 0 1 0 5.2M17 14.8c2 .5 3.2 1.9 3.5 4.2" />
    </>
  ),
  settings: (
    <>
      <path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h7M15 17h5" />
      <circle cx="15" cy="7" r="1.75" />
      <circle cx="9" cy="12" r="1.75" />
      <circle cx="13" cy="17" r="1.75" />
    </>
  ),
  view: <path d="M13 5h6v6M19 5l-8 8M17 14v5H5V7h5" />,
  help: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M9.7 9.7a2.4 2.4 0 1 1 3.4 2.2c-.7.3-1.1.8-1.1 1.6M12 16.5h.01" />
    </>
  ),
  account: (
    <>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 20c.6-3.6 3.4-5.5 7-5.5s6.4 1.9 7 5.5" />
    </>
  ),
  signOut: <path d="M10 5H5v14h5M14 8l4 4-4 4M18 12H9" />,
  add: <path d="M12 5v14M5 12h14" />,
  open: <path d="M4 7h16M4 12h16M4 17h16" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  narrow: <path d="m11 7-5 5 5 5M18 7l-5 5 5 5" />,
  widen: <path d="m13 7 5 5-5 5M6 7l5 5-5 5" />,
  down: <path d="m6 9 6 6 6-6" />,
  done: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="5.5" />
      <path d="m15 15 4.5 4.5" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof DRAWINGS;

export function Icon({ name, className = "size-5" }: { name: IconName; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className={`shrink-0 fill-none stroke-current ${className}`}
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {DRAWINGS[name]}
    </svg>
  );
}
