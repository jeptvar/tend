import { createReadStream, existsSync, readFileSync, statSync, watch } from "node:fs";
import { relative } from "node:path";
import { Readable } from "node:stream";
import { domainToUnicode } from "node:url";
import { type Context, Hono } from "hono";
import { currentUser } from "../auth/current-user.ts";
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
import { isIconSize, makeIcon } from "../media/process.ts";
import type { MediaStore } from "../media/store.ts";
import { contentTypeFor, resolveInside } from "../static-files.ts";
import { type CachedPage, PageCache, pageEtag, type RenderedPage } from "./cache.ts";
import { readableOn } from "./color.ts";
import { type FeedItem, robots, rss, type SitemapEntry, sitemap } from "./feeds.ts";
import { siteMenus } from "./menus.ts";
import {
  BUSINESS_PLACEHOLDER,
  mediaPlaceholderIds,
  resolveMediaPlaceholders,
} from "./placeholders.ts";
import { buildHead, type SharedImage } from "./seo.ts";
import { createTheme, type Theme } from "./theme.ts";

export interface SiteOptions {
  orm: Orm;
  store: MediaStore;
  themeDir: string;
  /** How much memory the page cache may use. 0 turns it off, as on a local site. */
  pageCacheBytes: number;
  /**
   * The site's own address, when it's known for sure: TEND_PUBLIC_URL, or what the hosting
   * platform says. Pages name it in links that other sites keep, like canonical and og:url.
   */
  publicUrl?: string | undefined;
  secureCookies?: boolean;
  /** How many proxies sit in front, so their X-Forwarded-Proto can be believed. */
  trustProxy?: number;
  now?: (() => number) | undefined;
  /** Watches the theme's folder, so an edited template shows straight away (PLAN.md §10). */
  watchTheme?: boolean;
}

export interface Site {
  app: Hono;
  theme: Theme;
  /** Purges the page cache after a change, then refills the pages most likely to be asked for. */
  changed(path?: string): void;
  /** How something would look on the site, whether or not it's published. Never cached. */
  preview(input: PreviewInput): Promise<string>;
  /** The homepage with a design that isn't saved yet. */
  previewDesign(design: DesignSettings): Promise<string>;
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
const VARIANT_FILE = /^(\d{1,5})\.webp$/;
const ICON_FILE = /^icon-(\d{2,3})\.png$/;
/** The size shared pictures are, when there's one that big: what sharing sites ask for. */
const SHARE_WIDTH = 1600;
/**
 * Meadow's dark backgrounds that links sit on, which an accent has to be readable on too: the
 * page itself, and Muted sections, which lay 6% of the light text colour over it.
 */
const DARK_BACKGROUNDS = ["#141a17", "#212724"];
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

/** The encoding to send: only one the visitor listed and didn't refuse with q=0. */
function preferredEncoding(acceptEncoding: string | undefined): "br" | "gzip" | undefined {
  const accepted = new Set<string>();
  for (const part of (acceptEncoding ?? "").split(",")) {
    const [name, ...parameters] = part.split(";").map((piece) => piece.trim().toLowerCase());
    const quality = parameters.find((parameter) => parameter.startsWith("q="));
    if (name && !(quality && Number(quality.slice(2)) === 0)) accepted.add(name);
  }
  if (accepted.has("br")) return "br";
  return accepted.has("gzip") ? "gzip" : undefined;
}

/**
 * A changed accent's dark-mode version: readable wherever Meadow shows links in dark mode.
 * Readable on the page alone isn't enough, because links in a Muted section sit on a
 * lighter background.
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

/** Everything the whole site shares, read once per page that isn't cached. */
interface SiteData {
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

  const theme = createTheme({
    themeDir: options.themeDir,
    cache: cacheOn,
    timezone: () => site.timezone,
    locale: () => site.locale,
  });

  async function loadSite(): Promise<SiteSettings> {
    site = (await getSetting(orm, "site")) ?? FALLBACK_SITE;
    return site;
  }

  /** The address this site goes by: what it was told, or what it was asked for as. */
  function trustedOrigin(): string | undefined {
    if (options.publicUrl) return options.publicUrl;
    if (site.address && site.address_confirmed) return site.address.replace(/\/+$/, "");
    return undefined;
  }

  /**
   * The address this site goes by. Only one it was told counts as the site's own: without
   * one, a page names the address it was asked for, and is cached apart for that address,
   * so a visitor sending another Host can't change the links everyone else gets.
   */
  function originOf(c: Context | undefined): string {
    const trusted = trustedOrigin();
    if (trusted) return trusted;
    if (!c) return "http://localhost";
    const url = new URL(c.req.url);
    const forwarded = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim();
    const secure =
      options.secureCookies || ((options.trustProxy ?? 0) > 0 && forwarded === "https");
    return `${secure ? "https:" : url.protocol}//${url.host}`;
  }

  /** Addresses pages have been cached for, when the site's own isn't known. Kept few. */
  const cachedOrigins = new Set<string>();
  const ORIGINS_CACHED = 4;

  /** The cache key for a page, or nothing if this request's copy shouldn't be shared. */
  function cacheKey(c: Context, key: string): string | undefined {
    if (trustedOrigin()) return key;
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
    return {
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
  async function baseContext(
    c: Context | undefined,
    facts: PageFacts,
    extra: { design?: DesignSettings; preview?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const data = await loadSiteData(extra.design);
    const origin = originOf(c);
    const { design } = data;
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
      icon:
        icon?.kind === "image"
          ? {
              small: `/media/${icon.id}/${mediaHash(icon)}/icon-32.png`,
              touch: `/media/${icon.id}/${mediaHash(icon)}/icon-180.png`,
            }
          : null,
      hasFeed: data.hasPosts,
      customCss: design.customCss,
      // Code someone added for every page never runs in a preview inside the admin.
      extraHead: extra.preview ? null : data.code.head,
    });
    // The theme's own dark-mode colours are chosen with care, so only a changed accent needs
    // a dark-mode version worked out for it.
    const accent = design.theme.accent;
    const themeAccent = theme.settings.find((setting) => setting.id === "accent")?.default;
    return {
      site: {
        name: data.site.name,
        tagline: data.site.tagline,
        locale: data.site.locale,
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
        ...(accent && accent !== themeAccent ? { accent_dark: darkAccent(accent) } : {}),
      },
      menus: data.menus,
      request: { path: facts.path },
      tend: { head, body_end: extra.preview ? "" : (data.code.bodyEnd ?? "") },
    };
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
    return { ...summaryJson(entry, tags), url: entryPath(entry), html: entry.html };
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
  async function resolvePage(html: string, origin = ""): Promise<string> {
    const paths = await findLivePaths(orm, placeholderIds(html));
    if (origin) for (const [id, path] of paths) paths.set(id, `${origin}${path}`);
    const pictures = await findMedia(orm, mediaPlaceholderIds(html));
    let resolved = resolveMediaPlaceholders(resolvePlaceholders(html, paths), pictures, {
      origin,
    });
    if (resolved.includes(BUSINESS_PLACEHOLDER)) {
      const business = businessJson(await settingValue(orm, "business"));
      const partial = await theme.renderPartial("business", { business });
      // Put in as it is. Given as a string, "$$" or "$`" in what someone typed would be read
      // as instructions to copy other parts of the page in.
      resolved = resolved.replaceAll(BUSINESS_PLACEHOLDER, () => partial);
    }
    return resolved;
  }

  async function renderTemplate(template: string, context: Record<string, unknown>) {
    return resolvePage(await theme.render(template, context));
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
      const context = { ...(await baseContext(c, facts)), page: liveJson(home) };
      return { status: 200, html: await renderTemplate("home", context) };
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
    const context = { ...(await baseContext(c, facts)), ...(await postsContext(page, "/")) };
    return { status: 200, html: await renderTemplate("home", context) };
  }

  async function renderBlog(c: Context | undefined, page: number): Promise<RenderedPage> {
    await loadSite();
    const facts: PageFacts = {
      path: pagedPath("/blog", page),
      title: `Blog · ${site.name}`,
      description: site.tagline || null,
      type: "website",
      imageId: null,
      noindex: false,
    };
    const context = { ...(await baseContext(c, facts)), ...(await postsContext(page, "/blog")) };
    return { status: 200, html: await renderTemplate("blog", context) };
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
    const facts: PageFacts = {
      path: pagedPath(path, page),
      title: `${tag.name} · ${site.name}`,
      description: tag.description,
      type: "website",
      imageId: null,
      // A tag with nothing published under it is an empty page, not worth finding.
      noindex: listed.posts.length === 0,
    };
    const context = {
      ...(await baseContext(c, facts)),
      ...listed,
      tag: { name: tag.name, url: path, description: tag.description },
    };
    return { status: 200, html: await renderTemplate("tag", context) };
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
    const live = liveJson(entry, tags);
    const context = {
      ...(await baseContext(c, entryFacts(entry))),
      ...(type === "post" ? { post: live } : { page: live }),
    };
    return { status: 200, html: await renderTemplate(type, context) };
  }

  async function renderNotFound(c: Context | undefined): Promise<RenderedPage> {
    await loadSite();
    const facts: PageFacts = {
      path: "/404",
      title: `Page not found · ${site.name}`,
      description: null,
      type: "website",
      imageId: null,
      noindex: true,
    };
    return { status: 404, html: await renderTemplate("404", await baseContext(c, facts)) };
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
      html: await renderTemplate("coming-soon", await baseContext(c, facts)),
    };
  }

  async function renderFeed(c: Context | undefined): Promise<RenderedPage> {
    await loadSite();
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
        html: await resolvePage(entry.html, origin),
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

  /** Sends a page, in the best encoding the visitor accepts, or a 304 if they have it already. */
  function send(
    c: Context,
    page: CachedPage | RenderedPage,
    cacheState: string,
    privately = false,
  ): Response {
    const raw = "raw" in page ? page.raw : Buffer.from(page.html);
    const etag = "etag" in page ? page.etag : pageEtag(raw);
    const headers: Record<string, string> = {
      "Content-Type": page.type ?? "text/html; charset=utf-8",
      "Cache-Control": privately ? "private, no-store" : "public, max-age=0, must-revalidate",
      ETag: etag,
      Vary: "Accept-Encoding",
      "Server-Timing": `cache;desc="${cacheState}"`,
    };
    if (page.status === 503) headers["Retry-After"] = "86400";
    if (page.status === 200 && !privately && c.req.header("if-none-match") === etag) {
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
    const user = await currentUser(c, orm, options.secureCookies ?? false, now());
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

  app.get("/assets/:theme/:hash/*", (c) => {
    const { theme: themeName, hash } = c.req.param();
    if (themeName !== theme.name) return fileNotFound(c);
    const file = resolveInside(
      theme.assetsDir,
      new URL(c.req.url).pathname.split("/").slice(4).join("/"),
    );
    if (!file || !existsSync(file) || !statSync(file).isFile()) return fileNotFound(c);
    return new Response(readFileSync(file), {
      headers: {
        "Content-Type": contentTypeFor(file),
        // Forever only if the address names the current file. An old or made-up hash
        // mustn't get a stale copy stuck in someone's browser.
        "Cache-Control":
          hash === theme.assetHash(relative(theme.assetsDir, file))
            ? "public, max-age=31536000, immutable"
            : "no-cache",
      },
    });
  });

  /** A stored file, sent as it's read. Its address names its contents, so it never changes. */
  function sendFile(c: Context, path: string, type: string, name?: string): Response | undefined {
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return undefined;
    }
    const headers: Record<string, string> = {
      "Content-Type": type,
      "Content-Length": String(size),
      "Cache-Control": FOREVER,
    };
    if (name) {
      headers["Content-Disposition"] = `inline; filename*=UTF-8''${encodeURIComponent(name)}`;
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
    const source = files.read(iconSourcePath(item, hash, size));
    if (!source) return false;
    files.write(path, await makeIcon(source, size));
    return true;
  }

  /** Icons being made right now, by file, so a burst of requests for one makes it once. */
  const iconsInProgress = new Map<string, Promise<boolean>>();

  /** A site icon, made from its picture the first time it's asked for, then kept. */
  async function sendIcon(c: Context, item: Media, size: number): Promise<Response | undefined> {
    const hash = mediaHash(item);
    const path = files.variantPath(item.id, hash, `icon-${size}.png`);
    if (!existsSync(path)) {
      let making = iconsInProgress.get(path);
      if (!making) {
        making = writeIcon(item, hash, size, path).finally(() => iconsInProgress.delete(path));
        iconsInProgress.set(path, making);
      }
      if (!(await making)) return undefined;
    }
    return sendFile(c, path, "image/png");
  }

  // Pictures and files stay reachable whoever can see the site: their addresses can't be
  // guessed, and the Coming soon page needs the logo.
  app.get("/media/:id/:hash/:file", async (c) => {
    const { id, hash, file } = c.req.param();
    const item = isMediaId(id) ? await getMedia(orm, id) : undefined;
    if (!item || item.trashedAt !== null) return fileNotFound(c);
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
      const path = files.variantPath(item.id, current, `${width}.webp`);
      return sendFile(c, path, "image/webp") ?? fileNotFound(c);
    }
    if (hash !== current || file !== downloadName(item)) return moved(originalUrl(item));
    const path = files.originalPath(item.id, current, item.ext);
    return sendFile(c, path, item.mime, downloadName(item)) ?? fileNotFound(c);
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
    if (path === "/" && !(await ownerExists(orm))) return c.redirect("/admin/setup");

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
  function refill(key: string, render: () => Promise<RenderedPage>): void {
    const startedAt = generation;
    void render()
      .then((page) => store(key, page, startedAt))
      .catch(() => {});
  }

  function changed(path?: string): void {
    visibility = undefined;
    if (!cacheOn) return;
    generation++;
    cache.clear();
    setImmediate(async () => {
      // Only a public site's pages are worth having ready: a hidden one shows them to nobody.
      const current = await settingValue(orm, "visibility").catch(() => undefined);
      if (current?.mode !== "public") return;
      // Without a request there's no address to name in links, unless it's known for sure.
      site = (await getSetting(orm, "site").catch(() => undefined)) ?? site;
      if (!trustedOrigin()) return;
      refill("/", () => renderHome(undefined, 1));
      const post = path?.match(/^\/blog\/([^/]+)$/)?.[1];
      const single = path?.match(/^\/([^/]+)$/)?.[1];
      if (path && post) refill(path, () => renderEntry(undefined, "post", post));
      else if (path && single) refill(path, () => renderEntry(undefined, "page", single));
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
    const context = {
      ...(await baseContext(undefined, entryFacts(entry), { preview: true })),
      ...(input.type === "post" ? { post: liveJson(entry) } : { page: liveJson(entry) }),
    };
    return asPreview(await renderTemplate(input.isHome === 1 ? "home" : input.type, context));
  }

  async function previewDesign(design: DesignSettings): Promise<string> {
    await loadSite();
    const home = await findLiveHome(orm);
    if (home) {
      const context = {
        ...(await baseContext(undefined, entryFacts(home), { design, preview: true })),
        page: liveJson(home),
      };
      return asPreview(await renderTemplate("home", context));
    }
    const facts: PageFacts = {
      path: "/",
      title: site.name,
      description: null,
      type: "website",
      imageId: null,
      noindex: true,
    };
    const context = {
      ...(await baseContext(undefined, facts, { design, preview: true })),
      ...(await postsContext(1, "/")),
    };
    return asPreview(await renderTemplate("home", context));
  }

  if (options.watchTheme) {
    let timer: NodeJS.Timeout | undefined;
    try {
      const watcher = watch(options.themeDir, { recursive: true }, () => {
        // An editor saving one file can fire several events. One reload is enough.
        clearTimeout(timer);
        timer = setTimeout(() => {
          theme.reload();
          changed();
        }, THEME_SETTLE_MS);
      });
      watcher.on("error", () => watcher.close());
      watcher.unref();
    } catch {
      // Some systems can't watch folders. Changes then show after a restart.
    }
  }

  return { app, theme, changed, preview, previewDesign };
}
