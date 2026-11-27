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
  | {
      id: string;
      type: "color";
      label: string;
      hint?: string;
      default: string;
      /** The backgrounds words in this colour go on. */
      contrastAgainst?: string[];
    }
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
  /** The theme of someone's own the site uses. Null is the one Tend comes with. */
  themeId: string | null;
  theme: Record<string, string>;
}

export interface ThemeChoice {
  id: string | null;
  name: string;
  settings: ThemeSetting[];
  problem: string | null;
  usable: boolean;
}

export interface DesignReply {
  value: Design;
  /** Every theme there is, the one Tend comes with first. */
  themes: [ThemeChoice, ...ThemeChoice[]];
  /** The theme that was chosen, if it isn't here any more. */
  missing: string | null;
  /** Where Tend runs, which decides how a theme of someone's own is started. */
  platform: "railway" | "render" | "fly" | "docker" | "local";
  updatedAt: number | null;
  undoId: string | null;
  canUndo: boolean;
  /** Only after saving: whether anything changed. */
  saved?: boolean;
}

export const DESIGN_KEY = ["design"];

/** Colours to start from, each of which reads wherever Meadow puts it. */
export const ACCENTS = [
  { id: "brown", value: "#8a4b1f" },
  { id: "green", value: "#1f6f4a" },
  { id: "teal", value: "#0f6b75" },
  { id: "blue", value: "#2451b8" },
  { id: "purple", value: "#6b3fa0" },
  { id: "rose", value: "#b03a5b" },
] as const;

/** The choice made for a theme's setting, or the theme's own if that isn't one it offers. */
export function themeValue(setting: ThemeSetting, chosen: Record<string, string>): string {
  const value = chosen[setting.id];
  if (value === undefined) return setting.default;
  const offered =
    setting.type === "color"
      ? /^#[0-9a-f]{6}$/i.test(value)
      : setting.options.some((option) => option.value === value);
  return offered ? value : setting.default;
}

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

export const STATS_SERVICES = ["plausible", "fathom", "umami", "cloudflare"] as const;

/** Settings → Visitor stats: a service that counts visitors without cookies, and its ID. */
export interface VisitorStats {
  service: (typeof STATS_SERVICES)[number] | null;
  id: string | null;
  /** Umami on a server of someone's own: where its script is. */
  script: string | null;
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

/** The first of these backgrounds words in this colour would be hard to read on, if any. */
export function hardToReadOn(color: string, backgrounds: readonly string[]): string | null {
  return backgrounds.find((background) => contrast(color, background) < READABLE) ?? null;
}

/**
 * The colour darkened or lightened just enough to read on every one of these backgrounds, for
 * the "Use … instead?" suggestion. One that reads on all of them already comes back as it was.
 */
export function readableOn(color: string, backgrounds: readonly string[]): string {
  const start = channels(color);
  if (!start || hardToReadOn(color, backgrounds) === null) return color.toLowerCase();
  // Towards whichever end reads on them: black on light ones, white on dark ones.
  const [end, hex] =
    hardToReadOn("#000000", backgrounds) === null ? [0, "#000000"] : [255, "#ffffff"];
  for (let step = 1; step <= 20; step++) {
    const mix = step / 20;
    const candidate = `#${start
      .map((value) =>
        Math.round(value * (1 - mix) + end * mix)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")}`;
    if (hardToReadOn(candidate, backgrounds) === null) return candidate;
  }
  return hex;
}

/** Settings → Backups: the copies Tend keeps, the disk, and the last download. */
export interface BackupsInfo {
  snapshots: {
    id: string;
    kind: "daily" | "update" | "restore" | "manual";
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

/** Where one of the copies kept on the server is downloaded from. Only the Owner may. */
export function copyDownloadUrl(id: string): string {
  return `/api/admin/backups/${encodeURIComponent(id)}/download`;
}
