import { existsSync, readFileSync, statSync } from "node:fs";
import { relative } from "node:path";
import { type Context, Hono } from "hono";
import { entryPath } from "../content/address.ts";
import type { Doc, EntryData } from "../content/doc.ts";
import {
  countLivePosts,
  findLiveEntry,
  findLiveHome,
  findLiveHomeSlug,
  findLivePaths,
  type LiveEntry,
  type LiveSummary,
  listLivePosts,
  listMenuPages,
} from "../content/entries.ts";
import {
  leadText,
  placeholderIds,
  renderDoc,
  resolvePlaceholders,
  summarize,
} from "../content/render-doc.ts";
import type { Orm } from "../db/client.ts";
import { getSetting, type SiteSettings } from "../db/repo/settings.ts";
import { ownerExists } from "../db/repo/users.ts";
import { contentTypeFor, resolveInside } from "../static-files.ts";
import { type CachedPage, PageCache, pageEtag, type RenderedPage } from "./cache.ts";
import { createTheme } from "./theme.ts";

export interface SiteOptions {
  orm: Orm;
  themeDir: string;
  /** How much memory the page cache may use. 0 turns it off, as on a local site. */
  pageCacheBytes: number;
}

export interface Site {
  app: Hono;
  /** Purges the page cache after a change, then refills the pages most likely to be asked for. */
  changed(path?: string): void;
  /** How something would look on the site, whether or not it's published. Never cached. */
  preview(input: PreviewInput): Promise<string>;
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
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

class NotFound extends Error {}

/** The homepage has one address: its own would only split up links to it. */
class MovedToHome extends Error {}

function pageNumber(c: Context): number {
  const page = Number(c.req.query("page"));
  return Number.isSafeInteger(page) && page > 0 ? page : 1;
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

/** The public website: everything that isn't the admin or the API. */
export function createSite(options: SiteOptions): Site {
  const { orm } = options;
  const cache = new PageCache(options.pageCacheBytes);
  const cacheOn = options.pageCacheBytes > 0;
  // Goes up with every change, so a render that began before one is never stored after it.
  let generation = 0;
  let site = FALLBACK_SITE;

  const theme = createTheme({
    themeDir: options.themeDir,
    cache: cacheOn,
    timezone: () => site.timezone,
    locale: () => site.locale,
  });

  function summaryJson(entry: LiveSummary) {
    return {
      title: entry.title,
      summary: entry.summary ?? summarize(entry.lead),
      url: entryPath({ ...entry, isHome: 0 }),
      published_at: entry.firstPublishedAt,
    };
  }

  /** Links to other pages become real addresses here, so they can never go stale. */
  async function liveJson(entry: LiveEntry) {
    const paths = await findLivePaths(orm, placeholderIds(entry.html));
    return {
      ...summaryJson(entry),
      url: entryPath(entry),
      html: resolvePlaceholders(entry.html, paths),
    };
  }

  /** What every template gets: the site, its menu, and which address this is. */
  async function baseContext(path: string): Promise<Record<string, unknown>> {
    site = (await getSetting(orm, "site")) ?? FALLBACK_SITE;
    const pages = await listMenuPages(orm);
    const hasPosts = (await countLivePosts(orm)) > 0;
    return {
      site: { name: site.name, tagline: site.tagline, locale: site.locale },
      // Until the real Site menu arrives (M3): every page, plus the blog if it has posts.
      menus: {
        main: [
          ...(hasPosts ? [{ title: "Blog", url: "/blog" }] : []),
          ...pages.map((page) => ({ title: page.title, url: `/${page.slug}` })),
        ],
      },
      request: { path },
    };
  }

  async function postsContext(page: number, basePath: string) {
    const total = await countLivePosts(orm);
    const pageCount = Math.max(1, Math.ceil(total / POSTS_PER_PAGE));
    if (page > pageCount) throw new NotFound();
    const posts = await listLivePosts(orm, {
      offset: (page - 1) * POSTS_PER_PAGE,
      limit: POSTS_PER_PAGE,
    });
    return {
      posts: posts.map(summaryJson),
      pagination: {
        page,
        page_count: pageCount,
        newer_url: page > 1 ? (page === 2 ? basePath : `${basePath}?page=${page - 1}`) : null,
        older_url: page < pageCount ? `${basePath}?page=${page + 1}` : null,
      },
    };
  }

  async function renderHome(page: number): Promise<RenderedPage> {
    const home = await findLiveHome(orm);
    // A static homepage has no later pages. Answering them would let anyone fill the
    // cache with endless copies of it, one per number.
    if (home && page > 1) throw new NotFound();
    const base = await baseContext("/");
    const context = home
      ? { ...base, page: await liveJson(home) }
      : { ...base, ...(await postsContext(page, "/")) };
    return { status: 200, html: await theme.render("home", context) };
  }

  async function renderBlog(page: number): Promise<RenderedPage> {
    const context = { ...(await baseContext("/blog")), ...(await postsContext(page, "/blog")) };
    return { status: 200, html: await theme.render("blog", context) };
  }

  async function renderEntry(type: "post" | "page", slug: string): Promise<RenderedPage> {
    if (!SLUG.test(slug)) throw new NotFound();
    if (type === "page" && (await findLiveHomeSlug(orm)) === slug) throw new MovedToHome();
    const entry = await findLiveEntry(orm, type, slug);
    if (!entry) throw new NotFound();
    const live = await liveJson(entry);
    const context = {
      ...(await baseContext(entryPath(entry))),
      ...(type === "post" ? { post: live } : { page: live }),
    };
    return { status: 200, html: await theme.render(type, context) };
  }

  async function renderNotFound(): Promise<RenderedPage> {
    return { status: 404, html: await theme.render("404", await baseContext("")) };
  }

  /** Sends a page, in the best encoding the visitor accepts, or a 304 if they have it already. */
  function send(c: Context, page: CachedPage | RenderedPage, cacheState: string): Response {
    const raw = "raw" in page ? page.raw : Buffer.from(page.html);
    const etag = "etag" in page ? page.etag : pageEtag(raw);
    const headers: Record<string, string> = {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=0, must-revalidate",
      ETag: etag,
      Vary: "Accept-Encoding",
      "Server-Timing": `cache;desc="${cacheState}"`,
    };
    if (page.status === 200 && c.req.header("if-none-match") === etag) {
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

  async function cached(
    c: Context,
    key: string,
    render: () => Promise<RenderedPage>,
  ): Promise<Response> {
    if (!cacheOn) return send(c, await render(), "off");
    // First, so a hit is only a memory lookup, with no database work at all.
    const hit = cache.get(key);
    if (hit) return send(c, hit, "hit");
    const startedAt = generation;
    return send(c, store(key, await render(), startedAt), "miss");
  }

  function notFound(c: Context): Promise<Response> {
    return cached(c, NOT_FOUND_KEY, renderNotFound);
  }

  const app = new Hono();

  app.get("/assets/:theme/:hash/*", (c) => {
    const { theme: themeName, hash } = c.req.param();
    if (themeName !== theme.name) return notFound(c);
    const file = resolveInside(
      theme.assetsDir,
      new URL(c.req.url).pathname.split("/").slice(4).join("/"),
    );
    if (!file || !existsSync(file) || !statSync(file).isFile()) return notFound(c);
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
        return await cached(c, page === 1 ? "/" : `/?page=${page}`, () => renderHome(page));
      }
      if (path === "/blog") {
        const page = pageNumber(c);
        return await cached(c, page === 1 ? "/blog" : `/blog?page=${page}`, () => renderBlog(page));
      }
      const post = path.match(/^\/blog\/([^/]+)$/);
      if (post?.[1]) {
        const slug = post[1];
        return await cached(c, path, () => renderEntry("post", slug));
      }
      const single = path.match(/^\/([^/]+)$/);
      if (single?.[1]) {
        const slug = single[1];
        return await cached(c, path, () => renderEntry("page", slug));
      }
    } catch (error) {
      if (error instanceof MovedToHome) return c.redirect("/", 301);
      if (!(error instanceof NotFound)) throw error;
    }
    return notFound(c);
  });

  /** Renders and stores a page in the background. It's fine if that fails: the next visitor just waits. */
  function refill(key: string, render: () => Promise<RenderedPage>): void {
    const startedAt = generation;
    void render()
      .then((page) => store(key, page, startedAt))
      .catch(() => {});
  }

  function changed(path?: string): void {
    if (!cacheOn) return;
    generation++;
    cache.clear();
    setImmediate(() => {
      refill("/", () => renderHome(1));
      const post = path?.match(/^\/blog\/([^/]+)$/)?.[1];
      const single = path?.match(/^\/([^/]+)$/)?.[1];
      if (path && post) refill(path, () => renderEntry("post", post));
      else if (path && single) refill(path, () => renderEntry("page", single));
    });
  }

  async function preview(input: PreviewInput): Promise<string> {
    const doc: Doc = input.data.doc;
    const { html, text } = renderDoc(doc);
    const slug = input.slug || "preview";
    const live = await liveJson({
      type: input.type,
      title: input.title,
      slug,
      text,
      lead: leadText(doc),
      summary: input.data.summary,
      firstPublishedAt: input.firstPublishedAt ?? input.now,
      isHome: input.isHome,
      html,
    });
    const path = entryPath({ type: input.type, isHome: input.isHome, slug });
    const context = {
      ...(await baseContext(path)),
      ...(input.type === "post" ? { post: live } : { page: live }),
    };
    const rendered = await theme.render(input.isHome === 1 ? "home" : input.type, context);
    // Links in a preview do nothing rather than wandering off to the real site, because
    // the frame showing this isn't allowed to open a new window.
    const head = '<meta name="robots" content="noindex"><base target="_blank">';
    return /<head[^>]*>/i.test(rendered)
      ? rendered.replace(/<head[^>]*>/i, (tag) => `${tag}${head}`)
      : `${head}${rendered}`;
  }

  return { app, changed, preview };
}
