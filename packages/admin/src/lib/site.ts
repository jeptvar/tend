// What the Site menu, Design and Settings screens work with (tendcms content/settings.ts).

export type MenuTarget =
  | { type: "entry"; id: string }
  | { type: "tag"; id: string }
  | { type: "blog" }
  | { type: "home" }
  | { type: "url"; url: string };

export interface MenuLeaf {
  id: string;
  /** Null uses what it links to: a page's title, say. */
  label: string | null;
  target: MenuTarget;
}

export interface MenuItem extends MenuLeaf {
  children: MenuLeaf[];
}

export interface StoredMenu {
  items: MenuItem[];
  automatic: boolean;
  updatedAt: number | null;
  undoId: string | null;
  canUndo: boolean;
}

export interface MenusReply {
  main: StoredMenu;
  footer: StoredMenu;
  /** Only after saving: whether anything changed. */
  saved?: boolean;
  /** Where each link goes now. A null address means visitors don't see it. */
  links: Record<string, { title: string | null; url: string | null }>;
}

export const MENUS_KEY = ["menus"];

export type ThemeSetting =
  | { id: string; type: "color"; label: string; hint?: string; default: string }
  | {
      id: string;
      type: "select";
      label: string;
      hint?: string;
      default: string;
      options: { value: string; label: string; hint?: string }[];
    };

export const SOCIAL_NETWORKS = [
  "instagram",
  "facebook",
  "tiktok",
  "youtube",
  "x",
  "linkedin",
  "pinterest",
  "threads",
  "bluesky",
  "mastodon",
  "whatsapp",
  "other",
] as const;
export type SocialNetwork = (typeof SOCIAL_NETWORKS)[number];

export interface Design {
  logoId: string | null;
  iconId: string | null;
  footerText: string | null;
  social: { network: SocialNetwork; url: string | null }[];
  customCss: string | null;
  theme: Record<string, string>;
}

export interface DesignReply {
  value: Design;
  schema: ThemeSetting[];
  updatedAt: number | null;
  undoId: string | null;
  canUndo: boolean;
  /** Only after saving: whether anything changed. */
  saved?: boolean;
}

export const DESIGN_KEY = ["design"];

export interface Stored<T> {
  value: T;
  updatedAt: number | null;
  /** The change Undo would take back. It has to be named, so it can't undo a newer one. */
  undoId: string | null;
  canUndo: boolean;
}

export interface General {
  name: string;
  tagline: string;
  locale: string;
  timezone: string;
}

export const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

export interface DayHours {
  day: (typeof DAYS)[number];
  closed: boolean;
  opens: string;
  closes: string;
}

export interface Business {
  address: string | null;
  phone: string | null;
  email: string | null;
  mapUrl: string | null;
  hours: DayHours[] | null;
  hoursNote: string | null;
}

export interface Visibility {
  mode: "public" | "coming_soon" | "private";
}

export interface SearchSettings {
  description: string | null;
  imageId: string | null;
}

export interface CodeSettings {
  head: string | null;
  bodyEnd: string | null;
}

export interface Redirect {
  fromPath: string;
  toPath: string;
  source: "auto" | "manual" | "import";
  hits: number;
  createdAt: number;
}

export function settingKey(name: string) {
  return ["settings", name];
}

/** A new name for a menu link, unique enough within one menu. */
export function newLinkId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// WCAG contrast, the same rule as the site's: text needs 4.5:1.
const READABLE = 4.5;

/**
 * The light backgrounds Meadow puts words in the accent colour on: the page, and sections with
 * a Soft background, which lay 6% of the text colour (#1d2420) over the page. Buttons need no
 * entry: their words are the page's colour on the accent, the same pair as a link on the page.
 * The site works out its own dark-mode accent. If theme.css changes these, change them here
 * too; test/accent.test.ts reads it and fails until they match.
 */
export const LIGHT_BACKGROUNDS = { page: "#ffffff", soft: "#f1f2f2" } as const;
export type LightBackground = keyof typeof LIGHT_BACKGROUNDS;

function channels(hex: string): [number, number, number] | undefined {
  const match = hex.match(/^#([0-9a-f]{6})$/i)?.[1];
  if (!match) return undefined;
  return [0, 2, 4].map((start) => Number.parseInt(match.slice(start, start + 2), 16)) as [
    number,
    number,
    number,
  ];
}

function luminance([r, g, b]: [number, number, number]): number {
  const linear = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

export function contrast(a: string, b: string): number {
  const first = channels(a);
  const second = channels(b);
  if (!first || !second) return 1;
  const [light, dark] = [luminance(first), luminance(second)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (light + 0.05) / (dark + 0.05);
}

/**
 * The first light background words in this colour would be hard to read on, or null if they
 * read on all of them. A colour that only just reads on white is under 4.5:1 on the grey of a
 * Soft section, so white alone isn't enough.
 */
export function hardToReadOn(color: string): LightBackground | null {
  for (const [name, background] of Object.entries(LIGHT_BACKGROUNDS)) {
    if (contrast(color, background) < READABLE) return name as LightBackground;
  }
  return null;
}

/**
 * The colour darkened just enough to read on every light background, for the "Use … instead?"
 * suggestion. One that reads on all of them already comes back as it was.
 */
export function readableOnLight(color: string): string {
  const start = channels(color);
  if (!start || hardToReadOn(color) === null) return color.toLowerCase();
  for (let step = 1; step <= 20; step++) {
    const mix = 1 - step / 20;
    const candidate = `#${start
      .map((value) =>
        Math.round(value * mix)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")}`;
    if (hardToReadOn(candidate) === null) return candidate;
  }
  return "#000000";
}

/** Settings → Backups: the copies Tend keeps, the disk, and the last download. */
export interface BackupsInfo {
  snapshots: {
    id: string;
    kind: "daily" | "update" | "restore";
    takenAt: number;
    bytes: number;
  }[];
  disk: { total: number; free: number };
  lastDownloadAt: number | null;
  setUpAt: number | null;
}

export const BACKUPS_KEY = ["backups"];

/** Where the browser downloads the whole site from. Only the Owner may. */
export const BACKUP_DOWNLOAD_URL = "/api/admin/backups/download";
