import { createReadStream, existsSync, statSync, watch } from "node:fs";
import { relative } from "node:path";
import { Readable } from "node:stream";
import { domainToUnicode } from "node:url";
import { type Context, Hono } from "hono";
import { ApiError } from "../api/errors.ts";
import { currentUser } from "../auth/current-user.ts";
import { isLocalAddress } from "../config.ts";
import { entryPath } from "../content/address.ts";
import { type Doc, type EntryData, isMediaId } from "../content/doc.ts";
import {
  countLivePosts,
  findLiveEntry,
  findLiveHome,
  findLiveHomeSlug,
  findLivePaths,
  findLivePosts,
  type LiveEntry,
  type LiveSummary,
  listLiveForSitemap,
  listLivePosts,
} from "../content/entries.ts";
import { followRedirect } from "../content/redirects.ts";
import {
  leadText,
  placeholderIds,
  renderDoc,
  resolvePlaceholders,
  summarize,
} from "../content/render-doc.ts";
import {
  type BusinessSettings,
  type DesignSettings,
  settingValue,
  type VisibilitySettings,
} from "../content/settings.ts";
import {
  countLivePostsWithTag,
  findTag,
  listLivePostIdsWithTag,
  liveTagsFor,
  type Tag,
  usedTags,
} from "../content/tags.ts";
import type { Orm } from "../db/client.ts";
import { getSetting, type SiteSettings } from "../db/repo/settings.ts";
import { ownerExists } from "../db/repo/users.ts";
import {
  downloadName,
  findMedia,
  getMedia,
  type Media,
  mediaHash,
  mediaWidths,
  originalUrl,
  variantUrl,
} from "../media/library.ts";
import { isIconSize, makeIcon, makeVariant, pictureError } from "../media/process.ts";
import type { MediaStore } from "../media/store.ts";
import type { SiteAddress } from "../site-address.ts";
import {
  etagOf,
  hasAlready,
  preferredEncoding,
  resolveInside,
  StaticFiles,
} from "../static-files.ts";
import { type CachedPage, PageCache, type RenderedPage } from "./cache.ts";
import { readableOn } from "./color.ts";
import { type FeedItem, robots, rss, type SitemapEntry, sitemap } from "./feeds.ts";
import { siteMenus } from "./menus.ts";
import {
  BUSINESS_PLACEHOLDER,
  mediaPlaceholderIds,
  resolveMediaPlaceholders,
} from "./placeholders.ts";
import { buildHead, type SharedImage } from "./seo.ts";
import type { Theme } from "./theme.ts";
import { createThemes, mistakeIn, type Themes } from "./themes.ts";

export interface SiteOptions {
  orm: Orm;
  store: MediaStore;
  /** The theme Tend comes with. */
  themeDir: string;
  /** Where themes of people's own are. */
  themeFolders?: string[] | undefined;
  /**
   * Shows a mistake in a theme of someone's own instead of the page, to whoever is working on
   * it on their own computer. Visitors get the page with the theme Tend comes with.
   */
  showThemeMistakes?: boolean | undefined;
  /** How much memory the page cache may use. 0 turns it off, as on a local site. */
  pageCacheBytes: number;
  /** The site's own address, which pages name in links that other sites keep, like canonical. */
  address: SiteAddress;
  /** How many proxies sit in front, so their X-Forwarded-Proto can be believed. */
  trustProxy?: number;
  now?: (() => number) | undefined;
  /** Which Tend this is, for the versions a theme says it's made for. */
  version?: string | undefined;
  /** Watches the theme's folder, so an edited template shows straight away (PLAN.md §10). */
  watchTheme?: boolean;
  /**
   * Told of work the site does after a change without anyone waiting on it, like making the
   * homepage ready again. Tests use it to wait for that work instead of guessing how long it
   * takes, which no fixed wait can know on a slow machine.
   */
  onBackgroundWork?: ((work: Promise<unknown>) => void) | undefined;
}

export interface Site {
  app: Hono;
  themes: Themes;
  /** Purges the page cache after a change, then refills the pages most likely to be asked for. */
  changed(path?: string): void;
  /** How something would look on the site, whether or not it's published. Never cached. */
  preview(input: PreviewInput): Promise<string>;
  /** The homepage with a design that isn't saved yet. */
  previewDesign(design: DesignSettings): Promise<string>;
  /** What the admin needs for what's written in it to look as it will on the site. */
  style(): Promise<SiteStyle>;
  /** Each choice of fonts a theme has, as CSS, by its name. */
  fontChoices(themeId: string | null): Promise<Record<string, string>>;
}

export interface SiteStyle {
  /** The theme's fonts, as CSS that loads them and says what they're for. */
  css: string;
  /** The accent colour, and one to use in its place on a dark background. */
  accent: string | null;
  accentDark: string | null;
}

export interface PreviewInput {
  type: string;
  isHome: number;
  title: string;
  slug: string;
  data: EntryData;
  firstPublishedAt: number | null;
  now: number;
}

const POSTS_PER_PAGE = 10;
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const THEME_SETTLE_MS = 100;
const FEED_SIZE = 20;
const FALLBACK_SITE: SiteSettings = {
  name: "Tend",
  tagline: "",
  address: null,
  address_confirmed: false,
  locale: "en",
  timezone: "UTC",
};
// Every missing address gets the same page, so this is cached once, not once per typo.
const NOT_FOUND_KEY = "not-found";
const COMING_SOON_KEY = "coming-soon";
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FOREVER = "public, max-age=31536000, immutable";
/** The same for one person: a browser keeps it, a shared cache never does. */
const PRIVATELY_FOREVER = "private, max-age=31536000, immutable";
const VARIANT_FILE = /^(\d{1,5})\.webp$/;
const FONT = /\.(?:woff2?|ttf|otf)$/i;
const ICON_FILE = /^icon-(\d{2,3})\.png$/;
/** The size shared pictures are, when there's one that big: what sharing sites ask for. */
const SHARE_WIDTH = 1600;
/**
 * Meadow's dark backgrounds are made from the accent, so no two sites have quite the same. An
 * accent that can be read on both of these can be read on every one made from it: the page,
 * Muted sections, and the cards the business details are on (test/meadow.test.ts).
 */
const DARK_BACKGROUNDS = ["#161312", "#241f1e"];
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
/** Networks named by Tend. Any other link is named after its site. */
const SOCIAL_NAMES: Record<string, string> = {
  instagram: "Instagram",
  facebook: "Facebook",
  tiktok: "TikTok",
  youtube: "YouTube",
  x: "X",
  linkedin: "LinkedIn",
  pinterest: "Pinterest",
  threads: "Threads",
  bluesky: "Bluesky",
  mastodon: "Mastodon",
  whatsapp: "WhatsApp",
};

class NotFound extends Error {}

/** The homepage has one address: its own would only split up links to it. */
class MovedToHome extends Error {}

/** A mistake in a theme of someone's own, where they're the one to show it to. */
class ThemeMistake extends Error {}

function pageNumber(c: Context): number {
  const page = Number(c.req.query("page"));
  return Number.isSafeInteger(page) && page > 0 ? page : 1;
}

function pagedPath(path: string, page: number): string {
  return page === 1 ? path : `${path}?page=${page}`;
}

function trimSlashes(path: string): string {
  // A loop on purpose. A regex here backtracks badly over a long run of slashes, which
  // would let one small request tie up the only thread.
  let start = 0;
  let end = path.length;
  while (start < end && path[start] === "/") start++;
  while (end > start && path[end - 1] === "/") end--;
  return path.slice(start, end);
}

/**
 * A changed accent's dark-mode version: readable wherever Meadow shows links in dark mode.
 * Readable on the page alone isn't enough, because links on a card sit on a lighter one.
 */
export function darkAccent(accent: string): string {
  return readableOn(accent, DARK_BACKGROUNDS);
}

/**
 * What a social link says. One to a network Tend doesn't name is called after its site, like
 * "yelp.com", so two of them never both just say "Link".
 */
function socialName(link: { network: string; url: string }): string {
  const known = SOCIAL_NAMES[link.network];
  if (known) return known;
  try {
    // An address in another script is stored in its ASCII form, which nobody would recognise.
    const host = domainToUnicode(new URL(link.url).hostname).replace(/^www\./, "");
    return host || "Link";
  } catch {
    return "Link";
  }
}

/** The picture the site's icon is made from: the one chosen in Design, or else the logo. */
function siteIconId(design: DesignSettings): string | null {
  return design.iconId ?? design.logoId;
}

/** A phone number as a link: digits and one leading +, which is all tel: needs. */
export function phoneHref(phone: string): string {
  const digits = phone.replace(/[^\d+]/g, "");
  const plus = digits.startsWith("+") ? "+" : "";
  return `tel:${plus}${digits.replace(/\+/g, "")}`;
}

interface HoursSummary {
  /** One day, or the first and last of several that are the same. */
  days: string;
  closed: boolean;
  opens: string;
  closes: string;
}

/** Opening hours in as few lines as they take: the same days in a row go together. */
export function hoursSummary(
  hours: NonNullable<BusinessSettings["hours"]>,
  dayName: (index: number) => string,
  time: (value: string) => string,
): HoursSummary[] {
  const lines: (HoursSummary & { key: string; from: number })[] = [];
  for (const [index, day] of hours.entries()) {
    const key = day.closed ? "closed" : `${day.opens}-${day.closes}`;
    const last = lines.at(-1);
    if (last?.key === key) {
      last.days = `${dayName(last.from)} – ${dayName(index)}`;
      continue;
    }
    lines.push({
      key,
      from: index,
      days: dayName(index),
      closed: day.closed,
      opens: time(day.opens),
      closes: time(day.closes),
    });
  }
  return lines.map(({ days, closed, opens, closes }) => ({ days, closed, opens, closes }));
}

/** Everything the whole site shares, read once per page that isn't cached. */
interface SiteData {
  theme: Theme;
  site: SiteSettings;
  design: DesignSettings;
  business: BusinessSettings;
  seo: { description: string | null; imageId: string | null };
  code: { head: string | null; bodyEnd: string | null };
  menus: Awaited<ReturnType<typeof siteMenus>>;
  hasPosts: boolean;
}

/** What a page tells search engines and sharing sites about itself. */
interface PageFacts {
  path: string;
  title: string;
  description: string | null;
  type: "website" | "article";
  imageId: string | null;
  imageAlt?: string | null;
  noindex: boolean;
  publishedAt?: number | null;
  modifiedAt?: number | null;
  structured?: object[];
  /** Shows the business details, so structured data says so too. */
  showsBusiness?: boolean;
}

/** What every template of a page is given, and the theme they're from. */
interface PageBase {
  theme: Theme;
  /** Whether a mistake in the theme is shown instead of the page. */
  strict: boolean;
  context: Record<string, unknown>;
}

type Access = "public" | "signedIn" | "comingSoon" | "private";

/** The public website: everything that isn't the admin or the API. */
export function createSite(options: SiteOptions): Site {
  const { orm, store: files } = options;
  const now = options.now ?? Date.now;
  const cache = new PageCache(options.pageCacheBytes);
  const cacheOn = options.pageCacheBytes > 0;
  // Goes up with every change, so a render that began before one is never stored after it.
  let generation = 0;
  let site = FALLBACK_SITE;
  // Kept in memory, because every request needs it and a cache hit should touch no database.
  // Every change to settings goes through changed(), which forgets it.
  let visibility: VisibilitySettings | undefined;
  // Once there's an Owner, there always is, so the homepage only asks until then.
  let setUp = false;

  const themes = createThemes({
    bundledDir: options.themeDir,
    folders: options.themeFolders ?? [],
    cache: cacheOn,
    timezone: () => site.timezone,
    locale: () => site.locale,
    version: options.version,
  });

  async function loadSite(): Promise<SiteSettings> {
    site = (await getSetting(orm, "site")) ?? FALLBACK_SITE;
    return site;
  }

  /**
   * The address this site goes by. Only one it was told counts as the site's own: without
   * one, a page names the address it was asked for, and is cached apart for that address,
   * so a visitor sending another Host can't change the links everyone else gets.
   */
  function originOf(c: Context | undefined): string {
    const known = options.address.url;
    if (known) return known;
    if (!c) return "http://localhost";
    const url = new URL(c.req.url);
    const forwarded = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim();
    const secure =
      options.address.secure || ((options.trustProxy ?? 0) > 0 && forwarded === "https");
    return `${secure ? "https:" : url.protocol}//${url.host}`;
  }

  /** Addresses pages have been cached for, when the site's own isn't known. Kept few. */
  const cachedOrigins = new Set<string>();
  const ORIGINS_CACHED = 4;

  /** The cache key for a page, or nothing if this request's copy shouldn't be shared. */
  function cacheKey(c: Context, key: string): string | undefined {
    if (options.address.url) return key;
    const origin = originOf(c).toLowerCase();
    if (!cachedOrigins.has(origin)) {
      // Endless made-up hosts would only push real pages out of the cache.
      if (cachedOrigins.size >= ORIGINS_CACHED) return undefined;
      cachedOrigins.add(origin);
    }
    return `${origin} ${key}`;
  }

  async function loadSiteData(design?: DesignSettings): Promise<SiteData> {
    await loadSite();
    const chosen = design ?? (await settingValue(orm, "design"));
    const theme = themes.chosen(chosen.themeId);
    return {
      theme,
      site,
      design: { ...chosen, theme: theme.designValues(chosen.theme) },
      business: await settingValue(orm, "business"),
      seo: await settingValue(orm, "seo"),
      code: await settingValue(orm, "code_injection"),
      menus: await siteMenus(orm),
      hasPosts: (await countLivePosts(orm)) > 0,
    };
  }

  function businessJson(business: BusinessSettings) {
    const dayName = (index: number) =>
      new Intl.DateTimeFormat(site.locale, { weekday: "long", timeZone: "UTC" }).format(
        // 5 January 1970 was a Monday.
        Date.UTC(1970, 0, 5 + index),
      );
    const time = (value: string) => {
      const [hours = 0, minutes = 0] = value.split(":").map(Number);
      return new Intl.DateTimeFormat(site.locale, { timeStyle: "short", timeZone: "UTC" }).format(
        Date.UTC(1970, 0, 1, hours, minutes),
      );
    };
    return {
      address_lines: business.address?.split(/\r?\n/).filter((line) => line.trim() !== "") ?? [],
      phone: business.phone,
      phone_href: business.phone ? phoneHref(business.phone) : null,
      email: business.email,
      email_href: business.email ? `mailto:${business.email}` : null,
      map_url: business.mapUrl,
      hours:
        business.hours?.map((day, index) => ({
          day: day.day,
          day_name: dayName(index),
          closed: day.closed,
          opens: time(day.opens),
          closes: time(day.closes),
          opens_24: day.opens,
          closes_24: day.closes,
        })) ?? null,
      hours_summary: business.hours ? hoursSummary(business.hours, dayName, time) : null,
      hours_note: business.hoursNote,
      has_any: Boolean(
        business.address ||
          business.phone ||
          business.email ||
          business.hours ||
          business.hoursNote,
      ),
    };
  }

  /** schema.org's LocalBusiness: search engines can show the business's own details. */
  function localBusiness(data: SiteData, origin: string): object | undefined {
    const { business } = data;
    if (!business.address && !business.phone && !business.email) return undefined;
    return {
      "@context": "https://schema.org",
      "@type": "LocalBusiness",
      name: data.site.name,
      url: `${origin}/`,
      ...(business.address ? { address: business.address.replace(/\r?\n/g, ", ") } : {}),
      ...(business.phone ? { telephone: business.phone } : {}),
      ...(business.email ? { email: business.email } : {}),
      ...(business.hours
        ? {
            openingHoursSpecification: business.hours.flatMap((day, index) =>
              day.closed
                ? []
                : [
                    {
                      "@type": "OpeningHoursSpecification",
                      dayOfWeek: `https://schema.org/${WEEKDAYS[index]}`,
                      opens: day.opens,
                      closes: day.closes,
                    },
                  ],
            ),
          }
        : {}),
    };
  }

  /** A picture for sharing: the biggest size that isn't too big, with a full address. */
  function sharedImage(
    item: Media | undefined,
    origin: string,
    alt?: string | null,
  ): SharedImage | null {
    if (item?.kind !== "image" || item.trashedAt !== null || !item.width || !item.height) {
      return null;
    }
    const widths = mediaWidths(item);
    const width = widths.filter((size) => size <= SHARE_WIDTH).pop() ?? widths[0];
    if (width === undefined) return null;
    return {
      url: `${origin}${variantUrl(item, width)}`,
      width,
      height: Math.round((item.height * width) / item.width),
      alt: alt ?? (item.decorative ? "" : (item.alt ?? "")),
    };
  }

  /** Everything every template gets: the site, its menus, its design and its <head>. */
  async function pageBase(
    c: Context | undefined,
    facts: PageFacts,
    extra: { design?: DesignSettings; preview?: boolean } = {},
  ): Promise<PageBase> {
    const data = await loadSiteData(extra.design);
    const origin = originOf(c);
    const { design, theme } = data;
    const iconId = siteIconId(design);
    const pictures = await findMedia(
      orm,
      [facts.imageId, data.seo.imageId, iconId, design.logoId].filter((id): id is string =>
        Boolean(id),
      ),
    );
    const icon = iconId ? pictures.get(iconId) : undefined;
    // A logo in the Trash, or deleted, shows the site's name instead of nothing at all.
    const logo = design.logoId ? pictures.get(design.logoId) : undefined;
    const image =
      sharedImage(
        facts.imageId ? pictures.get(facts.imageId) : undefined,
        origin,
        facts.imageAlt,
      ) ?? sharedImage(data.seo.imageId ? pictures.get(data.seo.imageId) : undefined, origin);
    const business = facts.showsBusiness ? localBusiness(data, origin) : undefined;
    // The theme's own dark-mode colours are chosen with care, so only a changed accent needs
    // a dark-mode version worked out for it.
    const accent = design.theme.accent;
    const themeAccent = theme.settings.find((setting) => setting.id === "accent")?.default;
    const accentDark = accent && accent !== themeAccent ? darkAccent(accent) : null;
    const chosen = theme.styleFor(design.theme);
    const siteIcon =
      icon?.kind === "image"
        ? {
            small: `/media/${icon.id}/${mediaHash(icon)}/icon-32.png`,
            touch: `/media/${icon.id}/${mediaHash(icon)}/icon-180.png`,
          }
        : null;
    const head = buildHead({
      origin,
      path: facts.path,
      title: facts.title,
      description: facts.description,
      siteName: data.site.name,
      locale: data.site.locale,
      type: facts.type,
      image,
      noindex: facts.noindex || extra.preview === true,
      publishedAt: facts.publishedAt ?? null,
      modifiedAt: facts.modifiedAt ?? null,
      structured: [...(facts.structured ?? []), ...(business ? [business] : [])],
      icon: siteIcon,
      hasFeed: data.hasPosts,
      themeCss: [
        chosen && `:root { ${chosen} }`,
        accentDark &&
          `@media (prefers-color-scheme: dark) { :root { --tend-accent: ${accentDark}; } }`,
      ]
        .filter(Boolean)
        .join(" "),
      customCss: design.customCss,
      // Code someone added for every page never runs in a preview inside the admin.
      extraHead: extra.preview ? null : data.code.head,
      prefetch: extra.preview !== true,
    });
    const context = {
      site: {
        name: data.site.name,
        tagline: data.site.tagline,
        url: origin,
        locale: data.site.locale,
        icon: siteIcon,
        logo: logo?.kind === "image" && logo.width ? { id: logo.id, alt: data.site.name } : null,
        footer_text: design.footerText,
        social: design.social.map((link) => ({
          network: link.network,
          name: socialName(link),
          url: link.url,
        })),
        business: businessJson(data.business),
        has_posts: data.hasPosts,
      },
      design: {
        ...design.theme,
        ...(accentDark ? { accent_dark: accentDark } : {}),
      },
      menus: data.menus,
      request: { path: facts.path },
      tend: { head, body_end: extra.preview ? "" : (data.code.bodyEnd ?? "") },
    };
    // Someone trying a design out needs to know, and so does someone making a theme on their
    // own computer. A visitor only needs the page.
    const strict = Boolean(
      extra.design || (options.showThemeMistakes && c && isLocalAddress(new URL(c.req.url).origin)),
    );
    return { theme, strict, context };
  }

  /**
   * Draws something with a theme. If the theme is someone's own and has a mistake in it, it's
   * drawn with the one Tend comes with, so a mistake never takes the site down.
   */
  async function drawn(
    { theme, strict }: Pick<PageBase, "theme" | "strict">,
    what: string,
    draw: (theme: Theme) => Promise<string>,
  ): Promise<string> {
    try {
      const html = await draw(theme);
      themes.drew(theme, what, null);
      return html;
    } catch (error) {
      if (theme === themes.bundled) throw error;
      const mistake = mistakeIn(theme, error);
      if (themes.drew(theme, what, mistake)) {
        console.error(
          `The theme ${theme.id} has a mistake in it, so pages that need it use ${themes.bundled.name} instead: ${mistake}`,
        );
      }
      if (strict) throw new ThemeMistake(mistake, { cause: error });
      return draw(themes.bundled);
    }
  }

  function summaryJson(entry: LiveSummary, tags?: Tag[]) {
    return {
      title: entry.title,
      summary: entry.summary ?? summarize(entry.lead),
      url: entryPath({ ...entry, isHome: 0 }),
      published_at: entry.firstPublishedAt,
      image: entry.featuredImage
        ? { id: entry.featuredImage.mediaId, alt: entry.featuredImage.alt }
        : null,
      tags: (tags ?? []).map((tag) => ({ name: tag.name, url: `/tag/${tag.slug}` })),
    };
  }

  function liveJson(entry: LiveEntry, tags?: Tag[]) {
    const { title, description, noindex } = entry.seo;
    return {
      ...summaryJson(entry, tags),
      url: entryPath(entry),
      html: entry.html,
      updated_at: entry.publishedAt,
      seo: { title, description, noindex },
    };
  }

  /** What a page says about itself, from its search settings or else its own words. */
  function entryFacts(entry: LiveEntry): PageFacts {
    const isHome = entry.isHome === 1;
    return {
      path: entryPath(entry),
      title: entry.seo.title ?? (isHome ? site.name : `${entry.title} · ${site.name}`),
      description: entry.seo.description ?? entry.summary ?? (entry.lead || null),
      type: entry.type === "post" ? "article" : "website",
      imageId: entry.seo.imageId ?? entry.featuredImage?.mediaId ?? null,
      imageAlt: entry.seo.imageId ? null : (entry.featuredImage?.alt ?? null),
      noindex: entry.seo.noindex,
      publishedAt: entry.firstPublishedAt,
      modifiedAt: entry.publishedAt,
      showsBusiness: isHome || entry.html.includes(BUSINESS_PLACEHOLDER),
      structured:
        entry.type === "post"
          ? [
              {
                "@context": "https://schema.org",
                "@type": "BlogPosting",
                headline: entry.title,
                ...(entry.firstPublishedAt
                  ? { datePublished: new Date(entry.firstPublishedAt).toISOString() }
                  : {}),
                dateModified: new Date(entry.publishedAt).toISOString(),
              },
            ]
          : [],
    };
  }

  /**
   * Fills in what a finished page only names: links to other pages, pictures and the
   * business details, each looked up once for the whole page. They're never stored filled
   * in, so they can't go stale. A feed needs full addresses, so it gives an origin.
   */
  async function resolvePage(
    html: string,
    base: Pick<PageBase, "theme" | "strict">,
    origin = "",
  ): Promise<string> {
    const paths = await findLivePaths(orm, placeholderIds(html));
    if (origin) for (const [id, path] of paths) paths.set(id, `${origin}${path}`);
    const pictures = await findMedia(orm, mediaPlaceholderIds(html));
    let resolved = resolveMediaPlaceholders(resolvePlaceholders(html, paths), pictures, {
      origin,
    });
    if (resolved.includes(BUSINESS_PLACEHOLDER)) {
      const business = businessJson(await settingValue(orm, "business"));
      const partial = await drawn(base, "partials/business", (theme) =>
        theme.renderPartial("business", { business }),
      );
      // Put in as it is. Given as a string, "$$" or "$`" in what someone typed would be read
      // as instructions to copy other parts of the page in.
      resolved = resolved.replaceAll(BUSINESS_PLACEHOLDER, () => partial);
    }
    return resolved;
  }

  async function renderTemplate(
    template: string,
    base: PageBase,
    more: Record<string, unknown> = {},
  ): Promise<string> {
    const html = await drawn(base, `templates/${template}`, (theme) =>
      theme.render(template, { ...base.context, ...more }),
    );
    return resolvePage(html, base);
  }

  async function postsContext(page: number, basePath: string, tagId?: string) {
    const total = tagId ? await countLivePostsWithTag(orm, tagId) : await countLivePosts(orm);
    const pageCount = Math.max(1, Math.ceil(total / POSTS_PER_PAGE));
    if (page > pageCount) throw new NotFound();
    const range = { offset: (page - 1) * POSTS_PER_PAGE, limit: POSTS_PER_PAGE };
    const posts = tagId
      ? await findLivePosts(orm, await listLivePostIdsWithTag(orm, { tagId, ...range }))
      : await listLivePosts(orm, range);
    const tags = await liveTagsFor(
      orm,
      posts.map((post) => post.id),
    );
    return {
      posts: posts.map((post) => summaryJson(post, tags.get(post.id))),
      pagination: {
        page,
        page_count: pageCount,
        newer_url: page > 1 ? pagedPath(basePath, page - 1) : null,
        older_url: page < pageCount ? `${basePath}?page=${page + 1}` : null,
      },
    };
  }

  function websiteData(c: Context | undefined): object {
    return {
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: site.name,
      url: `${originOf(c)}/`,
    };
  }

  async function renderHome(c: Context | undefined, page: number): Promise<RenderedPage> {
    const home = await findLiveHome(orm);
    // A static homepage has no later pages. Answering them would let anyone fill the
    // cache with endless copies of it, one per number.
    if (home && page > 1) throw new NotFound();
    await loadSite();
    const seo = await settingValue(orm, "seo");
    if (home) {
      const facts = entryFacts(home);
      facts.description =
        home.seo.description ?? seo.description ?? (site.tagline || facts.description);
      facts.structured = [websiteData(c)];
      const base = await pageBase(c, facts);
      return { status: 200, html: await renderTemplate("home", base, { page: liveJson(home) }) };
    }
    const facts: PageFacts = {
      path: pagedPath("/", page),
      title: site.tagline ? `${site.name} · ${site.tagline}` : site.name,
      description: seo.description ?? (site.tagline || null),
      type: "website",
      imageId: null,
      noindex: false,
      showsBusiness: true,
      structured: [websiteData(c)],
    };
    const base = await pageBase(c, facts);
    return { status: 200, html: await renderTemplate("home", base, await postsContext(page, "/")) };
  }

  async function renderBlog(c: Context | undefined, page: number): Promise<RenderedPage> {
    const { theme } = await loadSiteData();
    const facts: PageFacts = {
      path: pagedPath("/blog", page),
      title: `${theme.words("blog")} · ${site.name}`,
      description: site.tagline || null,
      type: "website",
      imageId: null,
      noindex: false,
    };
    const base = await pageBase(c, facts);
    const posts = await postsContext(page, "/blog");
    return { status: 200, html: await renderTemplate("blog", base, posts) };
  }

  async function renderTag(
    c: Context | undefined,
    slug: string,
    page: number,
  ): Promise<RenderedPage> {
    const tag = SLUG.test(slug) ? await findTag(orm, slug) : undefined;
    if (!tag) throw new NotFound();
    await loadSite();
    const path = `/tag/${tag.slug}`;
    const listed = await postsContext(page, path, tag.id);
    // Only published posts decide which tag pages exist. A tag is made as soon as someone
    // types it on a draft, and its name can say what isn't announced yet ("Closing down").
    // Later pages past the end are already 404, so an empty one is always the first.
    if (listed.posts.length === 0) throw new NotFound();
    const facts: PageFacts = {
      path: pagedPath(path, page),
      title: `${tag.name} · ${site.name}`,
      description: tag.description,
      type: "website",
      imageId: null,
      noindex: false,
    };
    const more = { ...listed, tag: { name: tag.name, url: path, description: tag.description } };
    return { status: 200, html: await renderTemplate("tag", await pageBase(c, facts), more) };
  }

  async function renderEntry(
    c: Context | undefined,
    type: "post" | "page",
    slug: string,
  ): Promise<RenderedPage> {
    if (!SLUG.test(slug)) throw new NotFound();
    if (type === "page" && (await findLiveHomeSlug(orm)) === slug) throw new MovedToHome();
    const entry = await findLiveEntry(orm, type, slug);
    if (!entry) throw new NotFound();
    await loadSite();
    const tags = type === "post" ? (await liveTagsFor(orm, [entry.id])).get(entry.id) : undefined;
    const base = await pageBase(c, entryFacts(entry));
    const html = await renderTemplate(type, base, { [type]: liveJson(entry, tags) });
    return { status: 200, html };
  }

  async function renderNotFound(c: Context | undefined): Promise<RenderedPage> {
    const { theme } = await loadSiteData();
    const facts: PageFacts = {
      path: "/404",
      title: `${theme.words("not_found")} · ${site.name}`,
      description: null,
      type: "website",
      imageId: null,
      noindex: true,
    };
    return { status: 404, html: await renderTemplate("404", await pageBase(c, facts)) };
  }

  async function renderComingSoon(c: Context | undefined): Promise<RenderedPage> {
    await loadSite();
    const facts: PageFacts = {
      path: "/",
      title: site.name,
      description: site.tagline || null,
      type: "website",
      imageId: null,
      noindex: true,
    };
    return {
      status: 503,
      html: await renderTemplate("coming-soon", await pageBase(c, facts)),
    };
  }

  async function renderFeed(c: Context | undefined): Promise<RenderedPage> {
    const { theme } = await loadSiteData();
    const origin = originOf(c);
    const posts = await listLivePosts(orm, { offset: 0, limit: FEED_SIZE });
    const items: FeedItem[] = [];
    for (const post of posts) {
      const entry = await findLiveEntry(orm, "post", post.slug);
      if (!entry) continue;
      items.push({
        title: post.title,
        url: `${origin}${entryPath(entry)}`,
        summary: post.summary ?? summarize(post.lead),
        html: await resolvePage(entry.html, { theme, strict: false }, origin),
        publishedAt: post.firstPublishedAt ?? post.publishedAt,
      });
    }
    return {
      status: 200,
      type: "application/rss+xml; charset=utf-8",
      html: rss({
        siteName: site.name,
        description: site.tagline,
        origin,
        locale: site.locale,
        items,
      }),
    };
  }

  async function renderSitemap(c: Context | undefined): Promise<RenderedPage> {
    await loadSite();
    const origin = originOf(c);
    const live = await listLiveForSitemap(orm);
    const entries: SitemapEntry[] = live
      .filter((entry) => !entry.seo.noindex)
      .map((entry) => ({ url: `${origin}${entryPath(entry)}`, modifiedAt: entry.publishedAt }));
    if (!live.some((entry) => entry.isHome === 1)) {
      entries.unshift({ url: `${origin}/`, modifiedAt: null });
    }
    if (live.some((entry) => entry.type === "post")) {
      entries.push({ url: `${origin}/blog`, modifiedAt: null });
    }
    for (const tag of await usedTags(orm)) {
      entries.push({ url: `${origin}/tag/${tag.slug}`, modifiedAt: null });
    }
    return { status: 200, type: "application/xml; charset=utf-8", html: sitemap(entries) };
  }

  /** When each request being answered began. */
  const began = new WeakMap<Request, number>();

  /** How long a request has taken so far, in milliseconds, for Server-Timing. */
  function tookSince(c: Context): string {
    const at = began.get(c.req.raw);
    return at === undefined ? "0" : (performance.now() - at).toFixed(2);
  }

  /** Sends a page, in the best encoding the visitor accepts, or a 304 if they have it already. */
  function send(
    c: Context,
    page: CachedPage | RenderedPage,
    cacheState: string,
    privately = false,
  ): Response {
    const raw = "raw" in page ? page.raw : Buffer.from(page.html);
    const etag = "etag" in page ? page.etag : etagOf(raw);
    const headers: Record<string, string> = {
      "Content-Type": page.type ?? "text/html; charset=utf-8",
      "Cache-Control": privately ? "private, no-store" : "public, max-age=0, must-revalidate",
      ETag: etag,
      Vary: "Accept-Encoding",
      "Server-Timing": `cache;desc="${cacheState}", total;dur=${tookSince(c)}`,
    };
    if (page.status === 503) headers["Retry-After"] = "86400";
    if (page.status === 200 && !privately && hasAlready(c.req.header("if-none-match"), etag)) {
      return new Response(null, { status: 304, headers });
    }
    let body: Buffer = raw;
    if ("br" in page) {
      const encoding = preferredEncoding(c.req.header("accept-encoding"));
      if (encoding) {
        body = page[encoding];
        headers["Content-Encoding"] = encoding;
      }
    }
    return new Response(new Uint8Array(body), { status: page.status, headers });
  }

  /** Stores a page, unless something changed while it was being rendered. */
  function store(
    key: string,
    rendered: RenderedPage,
    startedAt: number,
  ): CachedPage | RenderedPage {
    return startedAt === generation ? cache.set(key, rendered) : rendered;
  }

  /** Who may see the site right now, and so what this visitor gets. */
  async function access(c: Context): Promise<Access> {
    visibility ??= await settingValue(orm, "visibility");
    if (visibility.mode === "public") return "public";
    const user = await currentUser(c, orm, options.address.secure, now());
    if (user) return "signedIn";
    return visibility.mode === "coming_soon" ? "comingSoon" : "private";
  }

  async function cachedPage(
    c: Context,
    page: string,
    render: () => Promise<RenderedPage>,
  ): Promise<Response> {
    const key = cacheOn ? cacheKey(c, page) : undefined;
    if (key === undefined) return send(c, await render(), "off");
    // First, so a hit is only a memory lookup, with no database work at all.
    const hit = cache.get(key);
    if (hit) return send(c, hit, "hit");
    const startedAt = generation;
    return send(c, store(key, await render(), startedAt), "miss");
  }

  /** A page as this visitor may see it: the page itself, Coming soon, or a way to sign in. */
  async function cached(
    c: Context,
    key: string,
    render: () => Promise<RenderedPage>,
    who?: Access,
  ): Promise<Response> {
    const allowed = who ?? (await access(c));
    if (allowed === "private") {
      const next = new URL(c.req.url).pathname;
      return new Response(null, {
        status: 302,
        headers: {
          Location: `/admin/login?next=${encodeURIComponent(next)}`,
          "Cache-Control": "no-store",
        },
      });
    }
    if (allowed === "comingSoon") return cachedPage(c, COMING_SOON_KEY, () => renderComingSoon(c));
    // Someone signed in sees the real site while it's hidden, and that copy is never shared.
    if (allowed === "signedIn") return send(c, await render(), "off", true);
    return cachedPage(c, key, render);
  }

  function notFound(c: Context, who?: Access): Promise<Response> {
    return cached(c, NOT_FOUND_KEY, () => renderNotFound(c), who);
  }

  /** Not found, but without asking who's visiting: pictures and files are public. */
  /**
   * A picture or file that isn't there. Usually asked for by an <img>, so a whole page
   * would be wasted, and on a hidden site it would show the menu to anyone.
   */
  function fileNotFound(_c: Context): Response {
    return new Response("Not found", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" },
    });
  }

  const app = new Hono();

  app.use("*", (c, next) => {
    began.set(c.req.raw, performance.now());
    return next();
  });

  app.onError((error, c) => {
    if (!(error instanceof ThemeMistake)) throw error;
    const told = error.message.replace(/[&<>]/g, (sign) => `&#${sign.charCodeAt(0)};`);
    return c.html(
      `<!doctype html><html lang="en"><meta charset="utf-8"><title>A mistake in your theme</title><h1>Your theme has a mistake in it</h1><pre style="white-space: pre-wrap">${told}</pre><p>Fix that file, then reload this page. Only you see this, because the site is on your computer. Online, visitors would see the page with ${themes.bundled.name}.</p></html>`,
      500,
      { "Cache-Control": "no-store" },
    );
  });

  const themeFiles = new StaticFiles();

  app.get("/assets/:theme/:hash/*", async (c) => {
    const { theme: id, hash } = c.req.param();
    const theme = themes.at(id);
    if (!theme) return fileNotFound(c);
    const file = resolveInside(
      theme.assetsDir,
      new URL(c.req.url).pathname.split("/").slice(4).join("/"),
    );
    if (!file || !existsSync(file) || !statSync(file).isFile()) return fileNotFound(c);
    // Forever only if the address names the current file. An old or made-up hash mustn't get
    // a stale copy stuck in someone's browser.
    const current = hash === theme.assetHash(relative(theme.assetsDir, file));
    const sent = await themeFiles.send(c, file, current ? FOREVER : "no-cache");
    if (!sent) return fileNotFound(c);
    // A preview in the admin is shut off from the site, so its fonts come from somewhere else
    // as far as the browser knows, and it only uses those that say anyone may.
    if (FONT.test(file)) sent.headers.set("Access-Control-Allow-Origin", "*");
    return sent;
  });

  /**
   * A stored file, sent as it's read. Its address names its contents, so it never changes.
   * With a name, a picture shows in the browser, but anything else, like a PDF, is saved
   * (PLAN.md §12): opened in place, it would run in a viewer at the site's own address.
   */
  function sendFile(
    c: Context,
    path: string,
    type: string,
    options: {
      name?: string;
      disposition?: "inline" | "attachment";
      privately?: boolean;
      /** It stands in for another file, so nobody may keep it. */
      forNow?: boolean;
    } = {},
  ): Response | undefined {
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return undefined;
    }
    const headers: Record<string, string> = {
      "Content-Type": type,
      "Content-Length": String(size),
      "Cache-Control": options.forNow
        ? "no-store"
        : options.privately
          ? PRIVATELY_FOREVER
          : FOREVER,
    };
    if (options.name) {
      headers["Content-Disposition"] =
        `${options.disposition ?? "inline"}; filename*=UTF-8''${encodeURIComponent(options.name)}`;
    }
    if (c.req.method === "HEAD") return new Response(null, { headers });
    const stream = Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>;
    return new Response(stream, { headers });
  }

  /** An older version's address, or a size this one doesn't have, leads to the current one. */
  function moved(location: string): Response {
    return new Response(null, {
      status: 302,
      headers: { Location: location, "Cache-Control": "no-cache" },
    });
  }

  /** Whether a picture is the site's icon right now, going by Design as it is at this moment. */
  async function isSiteIcon(item: Media): Promise<boolean> {
    return siteIconId(await settingValue(orm, "design")) === item.id;
  }

  /**
   * The stored size an icon is made from: the smallest one at least as big as the icon. The
   * original can be 50 megapixels, and opening one that big takes a lot of memory.
   */
  function iconSourcePath(item: Media, hash: string, size: number): string {
    const ratio = item.width && item.height ? item.height / item.width : 1;
    const longestSide = (width: number) => Math.max(width, Math.round(width * ratio));
    const widths = mediaWidths(item);
    const width = widths.find((each) => longestSide(each) >= size) ?? widths.at(-1);
    return width === undefined
      ? files.originalPath(item.id, hash, item.ext)
      : files.variantPath(item.id, hash, `${width}.webp`);
  }

  /** Makes and keeps one icon file. False if the picture's own files are gone. */
  async function writeIcon(item: Media, hash: string, size: number, path: string) {
    // Its sizes can be missing after a restore, since backups leave them out.
    const source =
      files.read(iconSourcePath(item, hash, size)) ??
      files.read(files.originalPath(item.id, hash, item.ext));
    if (!source) return false;
    files.write(path, await makeIcon(source, size));
    return true;
  }

  /** Icons being made right now, by file, so a burst of requests for one makes it once. */
  const iconsInProgress = new Map<string, Promise<boolean>>();

  /** Sizes being made again right now, by file, so a burst of requests for one makes it once. */
  const variantsInProgress = new Map<string, Promise<boolean>>();

  /** Makes one size again from the original and keeps it. False if the original is gone. */
  async function writeVariant(item: Media, hash: string, width: number, path: string) {
    const original = files.read(files.originalPath(item.id, hash, item.ext));
    if (!original) return false;
    files.write(path, await makeVariant(original, width));
    return true;
  }

  /** The picture as it was uploaded, for a size that can't be made on this computer. */
  function sendOriginalForNow(c: Context, item: Media, hash: string): Response | undefined {
    const path = files.originalPath(item.id, hash, item.ext);
    return sendFile(c, path, item.mime, { forNow: true });
  }

  /**
   * One size of a picture. Sizes are a cache: backups leave them out (PLAN.md §13), so one
   * that's missing is made again from the original the first time it's asked for.
   */
  async function sendVariant(
    c: Context,
    item: Media,
    hash: string,
    width: number,
    privately: boolean,
  ): Promise<Response | undefined> {
    const path = files.variantPath(item.id, hash, `${width}.webp`);
    const kept = sendFile(c, path, "image/webp", { privately });
    if (kept) return kept;
    if (pictureError) return sendOriginalForNow(c, item, hash);
    let making = variantsInProgress.get(path);
    if (!making) {
      making = writeVariant(item, hash, width, path).finally(() => variantsInProgress.delete(path));
      variantsInProgress.set(path, making);
    }
    if (!(await making)) return undefined;
    return sendFile(c, path, "image/webp", { privately });
  }

  /** A site icon, made from its picture the first time it's asked for, then kept. */
  async function sendIcon(c: Context, item: Media, size: number): Promise<Response | undefined> {
    const hash = mediaHash(item);
    const path = files.variantPath(item.id, hash, `icon-${size}.png`);
    if (!existsSync(path)) {
      if (pictureError) return sendOriginalForNow(c, item, hash);
      let making = iconsInProgress.get(path);
      if (!making) {
        making = writeIcon(item, hash, size, path).finally(() => iconsInProgress.delete(path));
        iconsInProgress.set(path, making);
      }
      if (!(await making)) return undefined;
    }
    return sendFile(c, path, "image/png");
  }

  /**
   * Who may have a picture or file. A Private site keeps them for people who can sign in,
   * except its logo and icon, which say whose site it is on the way to signing in. While a
   * site is Coming soon they stay reachable, because its page shows the logo, and nothing on
   * it links to anything else. Signed in on a Private site, they're sent for that person
   * only, so no shared cache passes them on.
   */
  async function mediaAccess(c: Context, item: Media): Promise<"everyone" | "signedIn" | "no"> {
    const who = await access(c);
    if (who === "public" || who === "comingSoon" || visibility?.mode !== "private") {
      return "everyone";
    }
    if (who === "signedIn") return "signedIn";
    const design = await settingValue(orm, "design");
    return item.id === design.logoId || item.id === siteIconId(design) ? "everyone" : "no";
  }

  app.get("/media/:id/:hash/:file", async (c) => {
    const { id, hash, file } = c.req.param();
    const item = isMediaId(id) ? await getMedia(orm, id) : undefined;
    if (!item || item.trashedAt !== null) return fileNotFound(c);
    // The same answer as for nothing at all, so a Private site doesn't say what it has.
    const allowed = await mediaAccess(c, item);
    if (allowed === "no") return fileNotFound(c);
    const privately = allowed === "signedIn";
    const current = mediaHash(item);
    const icon = file.match(ICON_FILE);
    if (icon && item.kind === "image") {
      const size = Number(icon[1]);
      // Only the site's icon has icon files. Making one opens a picture, so if anyone could
      // ask for any picture's, a few requests could use up the server's memory.
      if (!isIconSize(size) || !(await isSiteIcon(item))) return fileNotFound(c);
      if (hash !== current) return moved(`/media/${item.id}/${current}/${file}`);
      return (await sendIcon(c, item, size)) ?? fileNotFound(c);
    }
    const variant = file.match(VARIANT_FILE);
    if (variant && item.kind === "image") {
      const width = Number(variant[1]);
      const widths = mediaWidths(item);
      if (hash !== current || !widths.includes(width)) {
        const nearest = widths.find((size) => size >= width) ?? widths.at(-1);
        return nearest === undefined ? fileNotFound(c) : moved(variantUrl(item, nearest));
      }
      return (await sendVariant(c, item, current, width, privately)) ?? fileNotFound(c);
    }
    if (hash !== current || file !== downloadName(item)) return moved(originalUrl(item));
    const path = files.originalPath(item.id, current, item.ext);
    const name = downloadName(item);
    const disposition = item.kind === "image" ? "inline" : "attachment";
    return sendFile(c, path, item.mime, { name, disposition, privately }) ?? fileNotFound(c);
  });

  app.get("/robots.txt", async (c) => {
    visibility ??= await settingValue(orm, "visibility");
    await loadSite();
    return c.text(robots({ origin: originOf(c), open: visibility.mode === "public" }), 200, {
      "Cache-Control": "public, max-age=0, must-revalidate",
    });
  });

  app.get("/feed", (c) => c.redirect("/rss.xml", 301));
  app.get("/rss.xml", (c) => cached(c, "/rss.xml", () => renderFeed(c)));
  app.get("/sitemap.xml", (c) => cached(c, "/sitemap.xml", () => renderSitemap(c)));

  app.get("*", async (c) => {
    // The address as it was sent, not decoded: %5C or %09 stay encoded in a redirect.
    // Decoded, browsers would read them as "//" and go to someone else's site.
    const { pathname, search } = new URL(c.req.url);
    if (pathname.length > 1 && pathname.endsWith("/")) {
      return c.redirect(`/${trimSlashes(pathname)}${search}`, 301);
    }

    const { path } = c.req;
    if (path === "/" && !setUp) {
      setUp = await ownerExists(orm);
      if (!setUp) return c.redirect("/admin/setup");
    }

    try {
      if (path === "/") {
        const page = pageNumber(c);
        return await cached(c, pagedPath("/", page), () => renderHome(c, page));
      }
      if (path === "/blog") {
        const page = pageNumber(c);
        return await cached(c, pagedPath("/blog", page), () => renderBlog(c, page));
      }
      const tag = path.match(/^\/tag\/([^/]+)$/)?.[1];
      if (tag) {
        const page = pageNumber(c);
        return await cached(c, pagedPath(path, page), () => renderTag(c, tag, page));
      }
      const post = path.match(/^\/blog\/([^/]+)$/)?.[1];
      if (post) return await cached(c, path, () => renderEntry(c, "post", post));
      const single = path.match(/^\/([^/]+)$/)?.[1];
      if (single) return await cached(c, path, () => renderEntry(c, "page", single));
    } catch (error) {
      if (error instanceof MovedToHome) return c.redirect("/", 301);
      if (!(error instanceof NotFound)) throw error;
    }
    // Only now, when nothing on the site is here: live pages always win over redirects.
    const who = await access(c);
    if (who === "public" || who === "signedIn") {
      const to = await followRedirect(orm, pathname);
      if (to) return c.redirect(to.includes("?") ? to : `${to}${search}`, 301);
    }
    return notFound(c, who);
  });

  /** Renders and stores a page in the background. It's fine if that fails: the next visitor just waits. */
  function refill(key: string, render: () => Promise<RenderedPage>): Promise<void> {
    const startedAt = generation;
    return render()
      .then((page) => {
        store(key, page, startedAt);
      })
      .catch(() => {});
  }

  /**
   * Work nobody waits on, started once the change that called for it is answered. Nothing would
   * catch what goes wrong in it, the disk failing say, and Node stops for that.
   */
  function inBackground(work: () => Promise<unknown>): void {
    const done = new Promise((resolve) => setImmediate(resolve)).then(work).catch(() => {});
    options.onBackgroundWork?.(done);
  }

  function changed(path?: string): void {
    visibility = undefined;
    // The change may be to which theme the site uses.
    if (options.watchTheme) inBackground(watchTheme);
    if (!cacheOn) return;
    generation++;
    cache.clear();
    inBackground(async () => {
      // Only a public site's pages are worth having ready: a hidden one shows them to nobody.
      const current = await settingValue(orm, "visibility").catch(() => undefined);
      if (current?.mode !== "public") return;
      // Without a request there's no address to name in links, unless it's known for sure.
      site = (await getSetting(orm, "site").catch(() => undefined)) ?? site;
      if (!options.address.url) return;
      const post = path?.match(/^\/blog\/([^/]+)$/)?.[1];
      const single = path?.match(/^\/([^/]+)$/)?.[1];
      await Promise.all([
        refill("/", () => renderHome(undefined, 1)),
        path && post ? refill(path, () => renderEntry(undefined, "post", post)) : undefined,
        path && !post && single
          ? refill(path, () => renderEntry(undefined, "page", single))
          : undefined,
      ]);
    });
  }

  /** Links in a preview do nothing rather than wandering off to the real site. */
  function asPreview(rendered: string): string {
    // The frame showing this isn't allowed to open a new window, so _blank goes nowhere.
    const head = '<base target="_blank">';
    return /<head[^>]*>/i.test(rendered)
      ? rendered.replace(/<head[^>]*>/i, (tag) => `${tag}${head}`)
      : `${head}${rendered}`;
  }

  async function preview(input: PreviewInput): Promise<string> {
    const doc: Doc = input.data.doc;
    const { html, text } = renderDoc(doc);
    const slug = input.slug || "preview";
    const entry: LiveEntry = {
      id: "preview",
      type: input.type,
      title: input.title,
      slug,
      text,
      lead: leadText(doc),
      summary: input.data.summary,
      featuredImage: input.data.featuredImage ?? null,
      // Something saved before search settings existed has none: everything automatic.
      seo: {
        title: null,
        description: null,
        imageId: null,
        noindex: false,
        ...(input.data.seo as Partial<EntryData["seo"]> | undefined),
      },
      firstPublishedAt: input.firstPublishedAt ?? input.now,
      publishedAt: input.now,
      isHome: input.isHome,
      html,
    };
    await loadSite();
    const base = await pageBase(undefined, entryFacts(entry), { preview: true });
    const more = { [input.type === "post" ? "post" : "page"]: liveJson(entry) };
    return asPreview(await renderTemplate(input.isHome === 1 ? "home" : input.type, base, more));
  }

  async function previewDesign(design: DesignSettings): Promise<string> {
    try {
      return asPreview(await homeWith(design));
    } catch (error) {
      if (!(error instanceof ThemeMistake)) throw error;
      throw new ApiError(400, "theme_mistake", `This theme has a mistake in it: ${error.message}`, {
        field: "themeId",
        fix: `Fix that in the theme's files, then try again. Until then, visitors see ${themes.bundled.name}.`,
      });
    }
  }

  async function homeWith(design: DesignSettings): Promise<string> {
    await loadSite();
    const home = await findLiveHome(orm);
    if (home) {
      const base = await pageBase(undefined, entryFacts(home), { design, preview: true });
      return renderTemplate("home", base, { page: liveJson(home) });
    }
    const facts: PageFacts = {
      path: "/",
      title: site.name,
      description: null,
      type: "website",
      imageId: null,
      noindex: true,
    };
    const base = await pageBase(undefined, facts, { design, preview: true });
    return renderTemplate("home", base, await postsContext(1, "/"));
  }

  async function fontsCss(theme: Theme, chosen: Record<string, string>): Promise<string> {
    const css = await drawn({ theme, strict: false }, "fonts", (drawing) =>
      drawing.renderPartial("fonts", { design: drawing.designValues(chosen) }),
    );
    return css.trim();
  }

  async function fontChoices(themeId: string | null): Promise<Record<string, string>> {
    const theme = themes.chosen(themeId);
    const setting = theme.settings.find(({ id }) => id === "fonts");
    if (setting?.type !== "select") return {};
    const choices: Record<string, string> = {};
    for (const { value } of setting.options) {
      choices[value] = await fontsCss(theme, { fonts: value });
    }
    return choices;
  }

  async function style(): Promise<SiteStyle> {
    const chosen = await settingValue(orm, "design");
    const theme = themes.chosen(chosen.themeId);
    const { accent = "" } = theme.designValues(chosen.theme);
    const isColor = HEX_COLOR.test(accent);
    return {
      css: await fontsCss(theme, chosen.theme),
      accent: isColor ? accent : null,
      accentDark: isColor ? darkAccent(accent) : null,
    };
  }

  let watched: { theme: Theme; close: () => void } | undefined;

  /** Watches the folder of the theme the site uses now, so a change in it shows straight away. */
  async function watchTheme(): Promise<void> {
    const { themeId } = await settingValue(orm, "design");
    const theme = themes.chosen(themeId);
    if (watched?.theme === theme) return;
    watched?.close();
    watched = { theme, close: () => {} };
    let timer: NodeJS.Timeout | undefined;
    try {
      const watcher = watch(theme.dir, { recursive: true }, () => {
        // An editor saving one file can fire several events. One reload is enough.
        clearTimeout(timer);
        timer = setTimeout(() => {
          theme.reload();
          themes.forget(theme);
          changed();
        }, THEME_SETTLE_MS);
      });
      watcher.on("error", () => watcher.close());
      watcher.unref();
      watched = {
        theme,
        close: () => {
          clearTimeout(timer);
          watcher.close();
        },
      };
    } catch {
      // Some systems can't watch folders. Changes then show after a restart.
    }
  }
  if (options.watchTheme) inBackground(watchTheme);

  return { app, themes, changed, preview, previewDesign, style, fontChoices };
}
