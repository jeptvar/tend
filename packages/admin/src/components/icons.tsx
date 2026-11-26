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
  right: <path d="m9 6 6 6-6 6" />,
  back: <path d="m15 6-6 6 6 6" />,
  undo: <path d="M8 6 4 10l4 4M4.5 10H14a5 5 0 0 1 0 10h-3" />,
  redo: <path d="m16 6 4 4-4 4M19.5 10H10a5 5 0 0 0 0 10h3" />,
  bold: (
    <path d="M8 5h5a3.4 3.4 0 0 1 0 6.8H8zM8 11.8h6a3.6 3.6 0 0 1 0 7.2H8z" strokeWidth="2.3" />
  ),
  italic: <path d="M11 5h6M7 19h6M14 5l-4 14" />,
  link: (
    <path d="M10 14a4 4 0 0 0 6 .4l2.6-2.6a4 4 0 0 0-5.7-5.7l-1.4 1.5M14 10a4 4 0 0 0-6-.4l-2.6 2.6a4 4 0 0 0 5.7 5.7l1.4-1.5" />
  ),
  history: <path d="M4 12a8 8 0 1 0 2.6-5.9L4 8.5M4 4v4.5h4.5M12 8v4.4l3 1.8" />,
  eye: (
    <>
      <path d="M2.8 12S6.2 5.8 12 5.8 21.2 12 21.2 12 17.8 18.2 12 18.2 2.8 12 2.8 12z" />
      <circle cx="12" cy="12" r="2.7" />
    </>
  ),
  upload: <path d="M12 16V5M7.5 9.5 12 5l4.5 4.5M5 19h14" />,
  computer: <path d="M4 5h16v11H4zM9 20h6M12 16v4" />,
  phone: <path d="M8 3h8v18H8zM11 18h2" />,
  panel: <path d="M4 5h16v14H4zM14.5 5v14" />,
  text: <path d="M5 7V5h14v2M12 5v14M9 19h6" />,
  heading2: <path d="M4 6v12M11 6v12M4 12h7M15.4 11a2.4 2.4 0 1 1 4.2 1.7L15.4 18H20" />,
  heading3: <path d="M4 6v12M11 6v12M4 12h7M15.4 9h4.3l-2.3 3.2a2.9 2.9 0 1 1-2.3 4.9" />,
  heading4: <path d="M4 6v12M11 6v12M4 12h7M19 18V9l-4.2 6H21" />,
  bulletList: <path d="M9 7h11M9 12h11M9 17h11M4.5 7h.01M4.5 12h.01M4.5 17h.01" />,
  orderedList: (
    <path d="M10 7h10M10 12h10M10 17h10M4 5.5 5.5 5v4.5M3.8 14.4a1.5 1.5 0 1 1 2.6 1L3.8 18.5h3" />
  ),
  quote: (
    <path
      d="M10 7.6C7 8.4 5 10.5 5 13.6V17h5v-5H7.5c.1-1.4 1-2.3 2.5-2.8zM19 7.6c-3 .8-5 2.9-5 6V17h5v-5h-2.5c.1-1.4 1-2.3 2.5-2.8z"
      className="fill-current"
      strokeWidth="0.5"
    />
  ),
  code: <path d="m8.5 8-4.5 4 4.5 4M15.5 8l4.5 4-4.5 4" />,
  divider: <path d="M4 12h16M8 6.5h8M8 17.5h8" />,
  table: <path d="M4 5h16v14H4zM4 10h16M4 14.5h16M10 5v14" />,
  button: (
    <path d="M6 8h12a3 3 0 0 1 3 3v2a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3v-2a3 3 0 0 1 3-3zM8 12h8" />
  ),
  intro: <path d="M4 5h16v14H4zM7.5 10h7M7.5 13.5h4.5" />,
  pictureText: <path d="M4 6h8v12H4zM15 8h5M15 12h5M15 16h3" />,
  contact: (
    <>
      <path d="M12 21s-6.5-5.6-6.5-10.5a6.5 6.5 0 0 1 13 0C18.5 15.4 12 21 12 21Z" />
      <circle cx="12" cy="10.5" r="2.3" />
    </>
  ),
  pencil: <path d="m5 19 .8-3.6L16.2 5a1.9 1.9 0 0 1 2.7 2.7L8.6 18.2ZM14.4 6.8l2.7 2.7" />,
  copy: <path d="M9 9h10v10H9zM5 15V5h10" />,
  trash: <path d="M5 7h14M10 7V5h4v2M7 7l.8 12h8.4L17 7M10.5 10.5v5M13.5 10.5v5" />,
  hide: (
    <path d="m4 4 16 16M9.6 6.1a9 9 0 0 1 2.4-.3c5.8 0 9.2 6.2 9.2 6.2a16 16 0 0 1-2.7 3.4M6.2 7.7A15 15 0 0 0 2.8 12S6.2 18.2 12 18.2a9 9 0 0 0 3.7-.8" />
  ),
  world: (
    <>
      <circle cx="12" cy="12" r="8.2" />
      <path d="M3.8 12h16.4M12 3.8c2.3 2.3 3.4 5 3.4 8.2s-1.1 5.9-3.4 8.2c-2.3-2.3-3.4-5-3.4-8.2s1.1-5.9 3.4-8.2Z" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.2" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  lock: <path d="M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3" />,
  download: <path d="M12 4.5v11M7.5 11 12 15.5l4.5-4.5M5 19.5h14" />,
  up: <path d="m6 15 6-6 6 6" />,
  warning: <path d="M12 4 3 19.5h18ZM12 10v4.5M12 17h.01" />,
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
