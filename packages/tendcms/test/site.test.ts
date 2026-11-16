import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { defaultThemeDir } from "../src/paths.ts";
import { PageCache } from "../src/site/cache.ts";
import { type MadeApp, makeApp, setUp } from "./auth-helpers.ts";
import { tempDir } from "./helpers.ts";

const ENTRIES = "/api/admin/entries";

function withoutStructuredData(html: string): string {
  return html.replace(/<script type="application\/ld\+json">[^<]*<\/script>/g, "");
}

function doc(text: string) {
  return { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] };
}

async function publishPost(
  owner: Awaited<ReturnType<typeof setUp>>,
  title: string,
  body = "Body",
  type = "post",
) {
  const entry = await (await owner.post(ENTRIES, { type })).json();
  const saved = await (
    await owner.patch(
      `${ENTRIES}/${entry.id}`,
      { title, doc: doc(body) },
      { "If-Match": String(entry.rev) },
    )
  ).json();
  const published = await (
    await owner.post(`${ENTRIES}/${entry.id}/publish`, {}, { "If-Match": String(saved.rev) })
  ).json();
  return published;
}

describe("starting points", () => {
  test("Business gets a homepage and a contact page, already published", async () => {
    const made = await makeApp();
    await setUp(made, { starter: "business" });
    const home = await (await made.app.request("/")).text();
    expect(home).toContain("Rise Bakery");
    expect(home).toContain("This is your homepage");
    expect(home).toContain('href="/contact"');
    expect((await made.app.request("/contact")).status).toBe(200);
  });

  test("Blog gets a welcome post, with the newest posts on the homepage", async () => {
    const made = await makeApp();
    await setUp(made, { starter: "blog" });
    const home = await (await made.app.request("/")).text();
    expect(home).toContain("Welcome to Rise Bakery");
    expect(home).toContain('href="/blog/welcome"');
    expect((await made.app.request("/blog/welcome")).status).toBe(200);
  });

  test("Blank gets only an empty homepage", async () => {
    const made = await makeApp();
    const owner = await setUp(made, { starter: "blank" });
    expect((await made.app.request("/")).status).toBe(200);
    const pages = await (await owner.get(`${ENTRIES}?type=page`)).json();
    const posts = await (await owner.get(`${ENTRIES}?type=post`)).json();
    expect(pages.entries).toHaveLength(1);
    expect(posts.entries).toHaveLength(0);
  });

  test("example content is marked as an example, and belongs to the Owner", async () => {
    const made = await makeApp();
    await setUp(made, { starter: "business" });
    const rows = made.db.prepare("SELECT is_example, author_id FROM entries").all() as {
      is_example: number;
      author_id: string;
    }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.is_example === 1 && row.author_id !== null)).toBe(true);
  });

  test("a site name with Liquid or HTML in it stays plain text", async () => {
    const made = await makeApp();
    await setUp(made, {
      site: { name: `<script>alert(1)</script>{{ 7 | times: 6 }}` },
      starter: "business",
    });
    const home = await (await made.app.request("/")).text();
    expect(home).not.toContain("<script>alert");
    expect(home).toContain("&lt;script&gt;");
    expect(home).toContain("{{ 7 | times: 6 }}");
  });
});

describe("public pages", () => {
  test("have no JavaScript, and do have the basics", async () => {
    const made = await makeApp();
    await setUp(made);
    for (const path of ["/", "/contact", "/does-not-exist"]) {
      const html = await (await made.app.request(path)).text();
      // Structured data for search engines is a script element, but nothing ever runs it.
      expect(withoutStructuredData(html), path).not.toContain("<script");
      expect(html, path).toContain('href="#content"');
      expect(html, path).toContain('lang="en-PH"');
      expect(html, path).toContain('name="viewport"');
    }
  });

  test("everything typed is escaped, including in the title and description", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const nasty = `<img src=x onerror="alert(1)">`;
    await publishPost(owner, `Title ${nasty}`, `Body ${nasty}`);
    const html = await (await made.app.request("/blog/title-img-src-x-onerror-alert-1")).text();
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  test("Liquid in someone's text is shown, not run", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    await publishPost(owner, "Template", "{{ site.name }} {% include 'x' %}");
    const html = await (await made.app.request("/blog/template")).text();
    expect(html).toContain("{{ site.name }}");
  });

  test("a name with special replacement characters comes through as typed", async () => {
    const made = await makeApp();
    await setUp(made, { site: { name: "Rock $& Roll $$ $'" }, starter: "business" });
    const html = await (await made.app.request("/")).text();
    expect(html).toContain("<h1>Rock $&amp; Roll $$ $&#39;</h1>");
  });

  test("dates carry a machine-readable time as well", async () => {
    const made = await makeApp();
    await setUp(made, { starter: "blog" });
    for (const path of ["/", "/blog/welcome"]) {
      const html = await (await made.app.request(path)).text();
      expect(html, path).toMatch(/<time datetime="\d{4}-\d{2}-\d{2}T[^"]+Z">/);
    }
  });

  test("the homepage has one address", async () => {
    const made = await makeApp();
    await setUp(made);
    const reply = await made.app.request("/home");
    expect(reply.status).toBe(301);
    expect(reply.headers.get("location")).toBe("/");
  });

  test("a trailing slash redirects, keeping the query, and can't redirect off the site", async () => {
    const made = await makeApp();
    await setUp(made);
    const reply = await made.app.request("/contact/?a=1");
    expect(reply.status).toBe(301);
    expect(reply.headers.get("location")).toBe("/contact?a=1");
    const offsite = await made.app.request("//evil.example/");
    expect(offsite.headers.get("location") ?? "").not.toMatch(/^\/\//);
  });

  test.each([
    "//evil.example/",
    "///evil.example/",
    "/%5Cevil.example/",
    "/%5C%5Cevil.example/",
    "/%5C/evil.example/",
    "/%09/evil.example/",
    "/%0b/evil.example/",
    "/%00/evil.example/",
  ])("%s can't be used to send someone to another site", async (path) => {
    const made = await makeApp();
    await setUp(made);
    const reply = await made.app.request(path);
    expect(reply.status, "not an error page").toBeLessThan(500);
    const location = reply.headers.get("location");
    if (location) {
      expect(new URL(location, "https://site.example").host).toBe("site.example");
      // eslint-disable-next-line no-control-regex
      expect(location).not.toMatch(/[\\\t\n\r]/);
    }
  });

  test("an enormous run of slashes costs nothing", async () => {
    const made = await makeApp();
    await setUp(made);
    const started = performance.now();
    const reply = await made.app.request(`/a${"/".repeat(200_000)}b/`);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(reply.status).toBe(301);
  });

  test.each(["/nope", "/blog/nope", "/a/b/c", "/CONTACT", "/blog/%3Cscript%3E", "/..%2f..%2fetc"])(
    "%s is a friendly 404",
    async (path) => {
      const made = await makeApp();
      await setUp(made);
      const reply = await made.app.request(path);
      expect(reply.status).toBe(404);
      const html = await reply.text();
      expect(html).toContain("Page not found");
      expect(withoutStructuredData(html)).not.toContain("<script");
    },
  );

  test("drafts aren't reachable, by address or in any list", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const draft = await (await owner.post(ENTRIES, { type: "post" })).json();
    await owner.patch(
      `${ENTRIES}/${draft.id}`,
      { title: "Secret plan", slug: "secret-plan", doc: doc("Hidden") },
      { "If-Match": "1" },
    );
    expect((await made.app.request("/blog/secret-plan")).status).toBe(404);
    for (const path of ["/", "/blog"]) {
      expect(await (await made.app.request(path)).text()).not.toContain("Secret plan");
    }
  });

  test("a draft doesn't make the blog appear in the menu", async () => {
    const made = await makeApp();
    const owner = await setUp(made, { starter: "blank" });
    const draft = await (await owner.post(ENTRIES, { type: "post" })).json();
    await owner.patch(`${ENTRIES}/${draft.id}`, { title: "Not yet" }, { "If-Match": "1" });
    expect(await (await made.app.request("/")).text()).not.toContain('href="/blog"');
    expect(await (await made.app.request("/blog")).text()).toContain("There are no posts yet");
  });

  test("the blog pages through posts, newest first, and past the end is a 404", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    for (let i = 1; i <= 11; i++) {
      made.clock.time += 1000;
      await publishPost(owner, `Post ${i}`);
    }
    const first = await (await made.app.request("/blog")).text();
    expect(first.indexOf("Post 11")).toBeLessThan(first.indexOf("Post 2"));
    expect(first).toContain('href="/blog?page=2"');
    expect(first).not.toContain(">Post 1<");
    const second = await (await made.app.request("/blog?page=2")).text();
    expect(second).toContain(">Post 1<");
    expect(second).toContain('href="/blog"');
    expect((await made.app.request("/blog?page=3")).status).toBe(404);
    expect((await made.app.request("/blog?page=abc")).status).toBe(200);
  });

  test("the menu follows what's published", async () => {
    const made = await makeApp();
    const owner = await setUp(made, { starter: "blank" });
    expect(await (await made.app.request("/")).text()).not.toContain("<nav");
    await publishPost(owner, "About", "Us", "page");
    await publishPost(owner, "News");
    const html = await (await made.app.request("/")).text();
    expect(html).toContain('href="/about"');
    expect(html).toContain('href="/blog"');
    const about = await (await made.app.request("/about")).text();
    expect(about).toContain('href="/about" aria-current="page"');
  });

  test("dates follow the site's language and timezone", async () => {
    const made = await makeApp();
    const owner = await setUp(made, {
      site: { name: "Site", locale: "en-GB", timezone: "Pacific/Auckland" },
      starter: "blank",
    });
    // Still the 20th in UTC, but already the 21st in Auckland.
    made.clock.time = Date.UTC(2027, 0, 20, 22, 0);
    await publishPost(owner, "Dated");
    expect(await (await made.app.request("/blog/dated")).text()).toContain("21 January 2027");
  });

  test("the stylesheet is served forever at its hashed address, and not at a stale one", async () => {
    const made = await makeApp();
    await setUp(made);
    const html = await (await made.app.request("/")).text();
    const href = html.match(/\/assets\/meadow\/[0-9a-f]+\/theme\.css/)?.[0] as string;
    const css = await made.app.request(href);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
    expect(css.headers.get("cache-control")).toContain("immutable");
    const stale = await made.app.request("/assets/meadow/000000000000/theme.css");
    expect(stale.headers.get("cache-control")).toBe("no-cache");
  });

  test.each([
    "/assets/meadow/x/..%2f..%2ftheme.json",
    "/assets/meadow/x/..%2ftemplates%2flayout.liquid",
    "/assets/other/x/theme.css",
    "/assets/meadow/x/missing.css",
  ])("%s doesn't reach anything outside the theme's assets", async (path) => {
    const made = await makeApp();
    await setUp(made);
    const reply = await made.app.request(path);
    expect(reply.status).toBe(404);
    expect(await reply.text()).not.toContain('"tend"');
  });

  test.each(["/assets/meadow/x//theme.css", "/assets/meadow/x/a%2F..%2Ftheme.css"])(
    "%s is served safely, whatever way the name is written",
    async (path) => {
      const made = await makeApp();
      await setUp(made);
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      const reply = await made.app.request(path);
      expect(reply.status).toBeLessThan(500);
      expect(logged).not.toHaveBeenCalled();
      logged.mockRestore();
    },
  );

  test("can't be framed by another site", async () => {
    const made = await makeApp();
    await setUp(made);
    const reply = await made.app.request("/");
    expect(reply.headers.get("content-security-policy")).toBe("frame-ancestors 'self'");
    expect(reply.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("a local site answers fresh every time, so template edits show on refresh", async () => {
    const made = await makeApp({ pageCacheBytes: 0 });
    await setUp(made);
    const reply = await made.app.request("/");
    expect(reply.headers.get("server-timing")).toContain("off");
    expect(reply.headers.get("content-encoding")).toBeNull();
  });
});

describe("the page cache", () => {
  test("a changed theme file shows straight away, without a restart", async () => {
    const themeDir = join(tempDir(), "meadow");
    cpSync(defaultThemeDir, themeDir, { recursive: true });
    const made = await makeApp({ themeDir, pageCacheBytes: 1_000_000, watchTheme: true });
    await setUp(made);
    expect(await (await made.app.request("/")).text()).not.toContain("Baked with care");
    expect((await made.app.request("/")).headers.get("server-timing")).toContain("hit");

    const footer = join(themeDir, "partials", "footer.liquid");
    writeFileSync(
      footer,
      readFileSync(footer, "utf8").replace("<footer", "<p>Baked with care</p><footer"),
    );
    await vi.waitFor(
      async () => expect(await (await made.app.request("/")).text()).toContain("Baked with care"),
      { timeout: 3000, interval: 50 },
    );
  });

  async function cachedSite(): Promise<{
    made: MadeApp;
    owner: Awaited<ReturnType<typeof setUp>>;
  }> {
    // With a known address, as a hosted site has, so pages are made ahead in the background.
    const made = await makeApp({ pageCacheBytes: 1024 * 1024, siteUrl: "http://localhost" });
    const owner = await setUp(made);
    return { made, owner };
  }

  /** The background refill runs after a change, so wait for it to settle first. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  test("a stored page needs no database work at all", async () => {
    const { made } = await cachedSite();
    await settle();
    await made.app.request("/contact");
    made.db.exec("PRAGMA foreign_keys = OFF; DROP TABLE revisions; DROP TABLE entries;");
    const reply = await made.app.request("/contact");
    expect(reply.status).toBe(200);
    expect(reply.headers.get("server-timing")).toContain("hit");
  });

  test("the stored homepage needs no database work either", async () => {
    const { made } = await cachedSite();
    await settle();
    await made.app.request("/");
    // Asking whether the site is set up is database work too, and the answer can't go back.
    made.db.exec("PRAGMA foreign_keys = OFF; DROP TABLE sessions; DROP TABLE users;");
    const reply = await made.app.request("/");
    expect(reply.status).toBe(200);
    expect(reply.headers.get("server-timing")).toContain("hit");
  });

  test("a static homepage has only one page, so numbers can't fill the cache", async () => {
    const { made } = await cachedSite();
    await settle();
    expect((await made.app.request("/")).headers.get("server-timing")).toContain("hit");
    for (const page of [2, 3, 999]) {
      expect((await made.app.request(`/?page=${page}`)).status, String(page)).toBe(404);
    }
    expect((await made.app.request("/")).headers.get("server-timing")).toContain("hit");
  });

  test("a page rendered before a change is never stored after it", async () => {
    // A fresh site, so the first render has to wait on disk for its templates.
    const made = await makeApp({ pageCacheBytes: 1024 * 1024 });
    const owner = await setUp(made);
    const post = await publishPost(owner, "Short lived");
    const [, unpublished] = await Promise.all([
      made.app.request(post.url),
      owner.post(`${ENTRIES}/${post.id}/unpublish`, {}, { "If-Match": String(post.rev) }),
    ]);
    expect(unpublished.status).toBe(200);
    await settle();
    expect((await made.app.request(post.url)).status).toBe(404);
  });

  test("the second visitor gets the stored page", async () => {
    const { made } = await cachedSite();
    await settle();
    const first = await made.app.request("/contact");
    const second = await made.app.request("/contact");
    expect(first.headers.get("server-timing")).toContain("miss");
    expect(second.headers.get("server-timing")).toContain("hit");
    expect(await second.text()).toBe(await first.text());
  });

  test("publishing shows up straight away, and the homepage is ready before anyone asks", async () => {
    const { made, owner } = await cachedSite();
    await settle();
    await made.app.request("/contact");
    const before = await (await made.app.request("/")).text();
    expect(before).not.toContain('href="/blog"');

    const post = await publishPost(owner, "Fresh news");
    expect(await (await made.app.request("/blog/fresh-news")).text()).toContain("Fresh news");
    expect(await (await made.app.request("/")).text()).toContain('href="/blog"');

    await settle();
    expect((await made.app.request("/")).headers.get("server-timing")).toContain("hit");
    expect((await made.app.request(post.url)).headers.get("server-timing")).toContain("hit");
  });

  test.each([
    ["unpublish", "unpublish"],
    ["move to the Trash", "trash"],
  ])("%s takes it off the site at once", async (_, action) => {
    const { made, owner } = await cachedSite();
    const post = await publishPost(owner, "Short lived");
    await settle();
    expect((await made.app.request(post.url)).status).toBe(200);
    await owner.post(`${ENTRIES}/${post.id}/${action}`, {}, { "If-Match": String(post.rev) });
    expect((await made.app.request(post.url)).status).toBe(404);
  });

  test("sends the best encoding the visitor accepts", async () => {
    const { made } = await cachedSite();
    const request = (encoding?: string) =>
      made.app.request("/contact", {
        headers: encoding ? { "Accept-Encoding": encoding } : {},
      });
    expect((await request("gzip, deflate, br")).headers.get("content-encoding")).toBe("br");
    expect((await request("gzip")).headers.get("content-encoding")).toBe("gzip");
    const plain = await request();
    expect(plain.headers.get("content-encoding")).toBeNull();
    expect(await plain.text()).toContain("<!doctype html>");
    expect((await request("gzip")).headers.get("vary")).toBe("Accept-Encoding");
  });

  test.each([
    ["br;q=0", null],
    ["br;q=0, gzip", "gzip"],
    ["gzip;q=0, br;q=0", null],
    ["gzip;q=0.5", "gzip"],
    ["not-br, x-gzip-thing", null],
    ["BR", "br"],
    ["identity", null],
  ])("Accept-Encoding: %s gets %s", async (accepts, expected) => {
    const { made } = await cachedSite();
    const reply = await made.app.request("/contact", { headers: { "Accept-Encoding": accepts } });
    expect(reply.headers.get("content-encoding")).toBe(expected);
  });

  test("an unchanged page gets a 304, and a changed one doesn't", async () => {
    const { made, owner } = await cachedSite();
    const first = await made.app.request("/contact");
    const etag = first.headers.get("etag") as string;
    expect(first.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    const again = await made.app.request("/contact", { headers: { "If-None-Match": etag } });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");

    await publishPost(owner, "New page", "Words", "page");
    const changed = await made.app.request("/contact", { headers: { "If-None-Match": etag } });
    expect(changed.status).toBe(200);
  });

  test("every missing address shares one stored page, so typos can't fill the cache", async () => {
    const { made } = await cachedSite();
    await settle();
    const first = await made.app.request("/nope-1");
    const second = await made.app.request("/nope-2");
    expect(first.status).toBe(404);
    expect(second.status).toBe(404);
    expect(second.headers.get("server-timing")).toContain("hit");
  });

  test("query strings can't make endless copies of a page", async () => {
    const { made } = await cachedSite();
    await settle();
    await made.app.request("/contact");
    const reply = await made.app.request("/contact?utm=anything");
    expect(reply.headers.get("server-timing")).toContain("hit");
  });

  test("a site that isn't local uses the cache by default", async () => {
    const { loadConfig } = await import("../src/config.ts");
    expect(loadConfig({ RENDER: "1" }).pageCacheBytes).toBe(32 * 1024 * 1024);
    expect(loadConfig({ RENDER: "1", TEND_CACHE_MB: "8" }).pageCacheBytes).toBe(8 * 1024 * 1024);
    expect(loadConfig({ RENDER: "1", TEND_CACHE_MB: "0" }).pageCacheBytes).toBe(0);
    expect(loadConfig({ TEND_PUBLIC_URL: "https://example.com" }).pageCacheBytes).toBeGreaterThan(
      0,
    );
    expect(loadConfig({ TEND_PUBLIC_URL: "http://localhost:3000" }).pageCacheBytes).toBe(0);
    expect(() => loadConfig({ TEND_CACHE_MB: "lots", RENDER: "1" })).toThrow(/TEND_CACHE_MB/);
  });

  test("a failed refill in the background doesn't take anything down", async () => {
    const { made, owner } = await cachedSite();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await publishPost(owner, "Fine");
    await settle();
    expect((await made.app.request("/")).status).toBe(200);
    logged.mockRestore();
  });
});

describe("PageCache", () => {
  test("holds only the memory it counts, not whole shared blocks", () => {
    const cache = new PageCache(1_000_000);
    const page = cache.set("a", { status: 200, html: "<p>small page</p>" });
    for (const stored of [page.raw, page.br, page.gzip]) {
      // A slice of a shared block would report the whole block here.
      expect(stored.buffer.byteLength).toBe(stored.length);
    }
  });

  test("stays under its size by dropping the least recently used", () => {
    const page = (size: number) => ({ status: 200, html: "x".repeat(size) });
    const cache = new PageCache(4000);
    cache.set("a", page(1200));
    cache.set("b", page(1200));
    cache.get("a");
    cache.set("c", page(1200));
    cache.set("d", page(1200));
    expect(cache.bytes).toBeLessThanOrEqual(4000);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("d")).toBeDefined();
  });

  test("a page too big to store is still served, just not kept", () => {
    const cache = new PageCache(10);
    const stored = cache.set("big", { status: 200, html: "x".repeat(1000) });
    expect(stored.raw.length).toBe(1000);
    expect(cache.size).toBe(0);
    expect(cache.bytes).toBe(0);
  });

  test("replacing a page doesn't count it twice, and clearing empties it", () => {
    const cache = new PageCache(100_000);
    cache.set("a", { status: 200, html: "one" });
    const after = cache.bytes;
    cache.set("a", { status: 200, html: "two" });
    expect(cache.bytes).toBe(after);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.bytes).toBe(0);
  });
});
