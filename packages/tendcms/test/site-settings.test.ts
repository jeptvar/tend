import { eq } from "drizzle-orm";
import sharp from "sharp";
import { describe, expect, test } from "vitest";
import { addRedirect } from "../src/content/redirects.ts";
import { settings } from "../src/db/schema.ts";
import { contrast, readableOn } from "../src/site/color.ts";
import { rss } from "../src/site/feeds.ts";
import { phoneHref } from "../src/site/router.ts";
import { buildHead, cssForStyle, jsonForScript } from "../src/site/seo.ts";
import { isHostingAddress, isPublicAddress } from "../src/site-address.ts";
import { browser, GOOD_PASSWORD, makeApp, OWNER_EMAIL, setUp, signedInAs } from "./auth-helpers.ts";

const ENTRIES = "/api/admin/entries";
type Client = Awaited<ReturnType<typeof setUp>>;

function doc(...paragraphs: string[]) {
  return {
    type: "doc",
    content: paragraphs.map((text) => ({ type: "paragraph", content: [{ type: "text", text }] })),
  };
}

async function publish(
  owner: Client,
  type: "post" | "page",
  fields: Record<string, unknown>,
): Promise<{ id: string; rev: number; url: string }> {
  const entry = await (await owner.post(ENTRIES, { type })).json();
  const saved = await owner.patch(`${ENTRIES}/${entry.id}`, fields, { "If-Match": "1" });
  expect(saved.status).toBe(200);
  const published = await owner.post(
    `${ENTRIES}/${entry.id}/publish`,
    {},
    { "If-Match": String((await saved.json()).rev) },
  );
  expect(published.status).toBe(200);
  return published.json();
}

async function picture(owner: Client, width = 2000, height = 1200) {
  const data = await sharp({ create: { width, height, channels: 3, background: "#884422" } })
    .png()
    .toBuffer();
  const reply = await owner.upload("/api/admin/media", data, "Shop.png");
  expect(reply.status).toBe(201);
  return reply.json();
}

async function page(made: Awaited<ReturnType<typeof makeApp>>, path: string) {
  const reply = await made.app.request(path);
  return { status: reply.status, headers: reply.headers, html: await reply.text() };
}

describe("settings keep their earlier versions", () => {
  test("a change can be undone, but only the newest, and only by someone who saw it", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const first = await owner.put("/api/admin/settings/business", {
      address: "1 Main St\nTown",
      phone: "+63 2 555 0100",
      email: null,
      mapUrl: "maps.example.com/rise",
      hours: null,
      hoursNote: null,
    });
    expect(first.status).toBe(200);
    const saved = await first.json();
    expect(saved.value.mapUrl).toBe("https://maps.example.com/rise");
    // Even the first save can be undone: back to never having been set.
    expect(saved.canUndo).toBe(true);

    made.clock.time += 1000;
    const second = await (
      await owner.put("/api/admin/settings/business", { ...saved.value, phone: "+63 2 555 0199" })
    ).json();
    expect(second.canUndo).toBe(true);

    const stale = await owner.post("/api/admin/settings/business/undo", {
      undoId: saved.undoId,
    });
    expect((await stale.json()).error.code).toBe("changed_since");

    const undone = await (
      await owner.post("/api/admin/settings/business/undo", { undoId: second.undoId })
    ).json();
    expect(undone.value.phone).toBe("+63 2 555 0100");
    expect(undone.canUndo).toBe(true);

    const blank = await (
      await owner.post("/api/admin/settings/business/undo", { undoId: undone.undoId })
    ).json();
    expect(blank.value.phone).toBeNull();
    expect(blank.canUndo).toBe(false);
    expect(blank.updatedAt).toBeNull();
  });

  test("undoing a menu's first save makes it automatic again", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const saved = await (
      await owner.put("/api/admin/menus/main", {
        items: [{ id: "h", label: "Home", target: { type: "home" }, children: [] }],
      })
    ).json();
    expect(saved.main.automatic).toBe(false);
    const undone = await (
      await owner.post("/api/admin/menus/main/undo", { undoId: saved.main.undoId })
    ).json();
    expect(undone.main.automatic).toBe(true);
    expect(undone.main.canUndo).toBe(false);
  });

  test("the last 20 versions are kept, and no more", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    let latest: string | null = null;
    for (let count = 0; count < 25; count++) {
      made.clock.time += 1000;
      const saved = await (
        await owner.put("/api/admin/settings/seo", {
          description: `Version ${count}`,
          imageId: null,
        })
      ).json();
      latest = saved.undoId;
    }
    for (let count = 0; count < 20; count++) {
      made.clock.time += 1000;
      const undone = await owner.post("/api/admin/settings/seo/undo", { undoId: latest });
      expect(undone.status, `undo ${count}`).toBe(200);
      latest = (await undone.json()).undoId;
    }
    expect(latest).toBeNull();
    const none = await owner.post("/api/admin/settings/seo/undo", { undoId: "none" });
    expect((await none.json()).error.code).toBe("nothing_to_undo");
    const now = await (await owner.get("/api/admin/settings/seo")).json();
    expect(now.value.description).toBe("Version 4");
  });

  test("saving what's there already says so, and leaves the last change undoable", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const design = await (await owner.get("/api/admin/design")).json();
    const first = await (
      await owner.put("/api/admin/design", { ...design.value, footerText: "Made with flour" })
    ).json();
    expect(first.saved).toBe(true);
    made.clock.time += 1000;
    // An empty social link and a trailing space are tidied away, so nothing changes.
    const again = await (
      await owner.put("/api/admin/design", {
        ...first.value,
        footerText: "Made with flour ",
        social: [{ network: "instagram", url: "" }],
      })
    ).json();
    expect(again.saved).toBe(false);
    expect(again.undoId).toBe(first.undoId);
    // So the Undo offered for the first save still takes back exactly that.
    const undone = await (
      await owner.post("/api/admin/design/undo", { undoId: first.undoId })
    ).json();
    expect(undone.value.footerText).toBeNull();
  });

  test("a language has to be one browsers know, or every date would fail", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const general = await (await owner.get("/api/admin/settings/general")).json();
    for (const locale of ["en-US-US", "en-a1", "nonsense!"]) {
      const reply = await owner.put("/api/admin/settings/general", { ...general.value, locale });
      expect(reply.status, locale).toBe(400);
      expect((await reply.json()).error.field, locale).toBe("locale");
    }
    const fixed = await (
      await owner.put("/api/admin/settings/general", { ...general.value, locale: "EN-gb" })
    ).json();
    expect(fixed.value.locale).toBe("en-GB");
  });

  test("a check with no message of its own still explains itself", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const reply = await owner.put("/api/admin/settings/seo", { description: 5, imageId: null });
    const body = await reply.json();
    expect(body.error.message).not.toMatch(/expected|invalid/i);
    expect(body.error.fix).toBeTruthy();
  });

  test("what's typed is checked and explained", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const reply = await owner.put("/api/admin/settings/business", {
      address: null,
      phone: null,
      email: "not an email",
      mapUrl: null,
      hours: null,
      hoursNote: null,
    });
    expect(reply.status).toBe(400);
    const body = await reply.json();
    expect(body.error.field).toBe("email");
    expect(body.error.message).toMatch(/email/);
    expect((await owner.get("/api/admin/settings/nonsense")).status).toBe(404);
  });

  test("the site's name changes on every page, and its address is left alone", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const general = await (await owner.get("/api/admin/settings/general")).json();
    expect(general.value.name).toBe("Rise Bakery");
    await owner.put("/api/admin/settings/general", { ...general.value, name: "Rise & Shine" });
    expect((await page(made, "/")).html).toContain("Rise &amp; Shine");
  });
});

describe("business details", () => {
  test("show in the footer and in Contact & hours, with links to call and write", async () => {
    const made = await makeApp();
    const owner = await setUp(made, { starter: "blank" });
    await owner.put("/api/admin/settings/business", {
      address: "1 Main St\nTown",
      phone: "+63 (2) 555-0100",
      email: "hello@rise.example",
      mapUrl: "https://maps.example.com/rise",
      hours: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((day) => ({
        day,
        closed: day === "sun",
        opens: "08:00",
        closes: "17:30",
      })),
      hoursNote: "Closed on holidays",
    });
    await publish(owner, "page", {
      title: "Visit",
      doc: {
        type: "doc",
        content: [
          {
            type: "section",
            attrs: { kind: "contact", preset: "1", tone: "none", align: "left" },
            content: [
              {
                type: "heading",
                attrs: { level: 2 },
                content: [{ type: "text", text: "Find us" }],
              },
            ],
          },
        ],
      },
    });
    const { html } = await page(made, "/visit");
    expect(html).toContain('href="tel:+6325550100"');
    expect(html).toContain('href="mailto:hello@rise.example"');
    expect(html).toContain("Get directions");
    expect(html).toContain("Monday");
    expect(html).toMatch(/Sunday<\/th><td>Closed/);
    expect(html).toContain("Closed on holidays");
    expect(html).not.toContain("tend-business");
    expect(html).toContain('"@type":"LocalBusiness"');
    expect(html).toContain('"opens":"08:00"');
  });

  test("a phone number becomes a link of digits", () => {
    expect(phoneHref("+63 (2) 555-0100")).toBe("tel:+6325550100");
    expect(phoneHref("0917 555 0100")).toBe("tel:09175550100");
    expect(phoneHref("555+0100")).toBe("tel:5550100");
  });
});

describe("the site menu", () => {
  test("is automatic until one is saved, and leaves out what isn't on the site", async () => {
    const made = await makeApp();
    const owner = await setUp(made, { starter: "business" });
    const menus = await (await owner.get("/api/admin/menus")).json();
    expect(menus.main.automatic).toBe(true);
    expect(menus.main.items.map((item: { target: { type: string } }) => item.target.type)).toEqual([
      "entry",
    ]);

    const about = await publish(owner, "page", { title: "About" });
    const draft = await (await owner.post(ENTRIES, { type: "page" })).json();
    const saved = await owner.put("/api/admin/menus/main", {
      items: [
        { id: "a", label: null, target: { type: "entry", id: about.id }, children: [] },
        {
          id: "b",
          label: "More",
          target: { type: "url", url: "https://example.com/" },
          children: [
            { id: "c", label: null, target: { type: "entry", id: draft.id } },
            { id: "d", label: "Home again", target: { type: "home" } },
          ],
        },
      ],
    });
    expect(saved.status).toBe(200);
    const body = await saved.json();
    expect(body.main.automatic).toBe(false);
    expect(body.links.c.url).toBeNull();

    const { html } = await page(made, "/about");
    expect(html).toContain('<a href="/about" aria-current="page">About</a>');
    expect(html).toContain("<summary>More</summary>");
    expect(html).toContain('<a href="/">Home again</a>');
    // The draft isn't on the site, so there's no link to it.
    expect(html.match(/<ul class="t-submenu">[\s\S]*?<\/ul>/)?.[0].match(/<li>/g)).toHaveLength(2);

    // Unpublishing takes it out of the menu visitors see; publishing again puts it back.
    await owner.post(`${ENTRIES}/${about.id}/unpublish`, {}, { "If-Match": String(about.rev) });
    expect((await page(made, "/")).html).not.toContain('href="/about"');
  });

  test("a link has to go somewhere a browser can open", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const reply = await owner.put("/api/admin/menus/footer", {
      items: [
        {
          id: "x",
          label: "Bad",
          target: { type: "url", url: "javascript:alert(1)" },
          children: [],
        },
      ],
    });
    expect(reply.status).toBe(400);
    const twice = await owner.put("/api/admin/menus/footer", {
      items: [
        { id: "x", label: "A", target: { type: "home" }, children: [] },
        { id: "x", label: "B", target: { type: "blog" }, children: [] },
      ],
    });
    expect(twice.status).toBe(400);
  });
});

describe("design", () => {
  test("the form comes from the theme, and only choices it offers reach its templates", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const design = await (await owner.get("/api/admin/design")).json();
    expect(design.themes[0].settings.map((setting: { id: string }) => setting.id)).toEqual([
      "accent",
      "fonts",
      "header",
    ]);
    expect(design.value.theme).toEqual({ accent: "#1f6f4a", fonts: "clean", header: "simple" });

    const saved = await (
      await owner.put("/api/admin/design", {
        ...design.value,
        theme: { accent: "#FFCC00", fonts: "classic", header: "sideways", other: "its own" },
        customCss: "body { color: red } </style><script>alert(1)</script>",
        footerText: "Made with flour",
        social: [{ network: "instagram", url: "instagram.com/rise" }],
      })
    ).json();
    // One it doesn't offer is another theme's, and waits for that theme.
    expect(saved.value.theme).toEqual({
      accent: "#ffcc00",
      fonts: "classic",
      header: "simple",
      other: "its own",
    });

    const { html } = await page(made, "/");
    expect(html).toContain('data-fonts="classic"');
    expect(html).toContain("--tend-accent: #ffcc00;");
    expect(html).not.toContain("its own");
    expect(html).toContain("<\\/style><script>");
    expect(html).not.toContain("</style><script>");
    expect(html).toContain("Made with flour");
    expect(html).toContain('href="https://instagram.com/rise"');
  });

  test("a preview shows a design before it's saved, without saving it", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const design = await (await owner.get("/api/admin/design")).json();
    const preview = await (
      await owner.post("/api/admin/design/preview", {
        ...design.value,
        footerText: "Not yet saved",
      })
    ).json();
    expect(preview.html).toContain("Not yet saved");
    expect(preview.html).toContain('content="noindex"');
    expect((await page(made, "/")).html).not.toContain("Not yet saved");
  });

  test("the logo replaces the name in the header, and makes the site icon", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const logo = await picture(owner, 600, 200);
    const design = await (await owner.get("/api/admin/design")).json();
    await owner.put("/api/admin/design", { ...design.value, logoId: logo.id });
    const { html } = await page(made, "/");
    expect(html).toMatch(
      /<a class="t-brand" href="\/" aria-current="page"><img class="t-img-logo"[^>]+alt="Rise Bakery"/,
    );
    expect(html).toContain('sizes="144px"');
    const icon = html.match(/<link rel="icon" href="([^"]+)"/)?.[1] as string;
    const served = await made.app.request(icon);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    const meta = await sharp(Buffer.from(await served.arrayBuffer())).metadata();
    expect([meta.width, meta.height]).toEqual([32, 32]);
  });

  test("an accent is made readable on a dark background, and left alone where it already is", () => {
    expect(readableOn("#1f6f4a", "#ffffff")).toBe("#1f6f4a");
    const dark = readableOn("#1f6f4a", "#141a17");
    expect(contrast(dark, "#141a17")).toBeGreaterThanOrEqual(4.5);
    const light = readableOn("#ffee88", "#ffffff");
    expect(contrast(light, "#ffffff")).toBeGreaterThanOrEqual(4.5);
  });
});

describe("who can see the site", () => {
  test("Coming soon shows one page to visitors, and the real site to whoever's signed in", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    await owner.put("/api/admin/settings/visibility", { mode: "coming_soon" });
    const visitor = await page(made, "/contact");
    expect(visitor.status).toBe(503);
    expect(visitor.html).toContain("coming soon");
    expect(visitor.html).toContain('content="noindex"');
    expect((await page(made, "/robots.txt")).html).toContain("Disallow: /");

    const signedIn = await owner.get("/contact");
    expect(signedIn.status).toBe(200);
    expect(signedIn.headers.get("cache-control")).toBe("private, no-store");
  });

  test("Private sends visitors to sign in, and back afterwards", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    await owner.put("/api/admin/settings/visibility", { mode: "private" });
    const visitor = await made.app.request("/contact");
    expect(visitor.status).toBe(302);
    expect(visitor.headers.get("location")).toBe("/admin/login?next=%2Fcontact");
    expect((await made.app.request("/rss.xml")).status).toBe(302);
    expect((await owner.get("/contact")).status).toBe(200);

    await owner.put("/api/admin/settings/visibility", { mode: "public" });
    expect((await made.app.request("/contact")).status).toBe(200);
  });
});

describe("redirects", () => {
  test("old addresses lead straight to the newest, without chains or loops", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const post = await publish(owner, "post", { title: "First name", slug: "a" });
    let rev = post.rev;
    for (const slug of ["b", "c", "a"]) {
      const saved = await (
        await owner.patch(`${ENTRIES}/${post.id}`, { slug }, { "If-Match": String(rev) })
      ).json();
      const published = await (
        await owner.post(`${ENTRIES}/${post.id}/publish`, {}, { "If-Match": String(saved.rev) })
      ).json();
      rev = published.rev;
    }
    // a → b → c → a: it's at /blog/a again, so that loads, and the others lead to it.
    expect((await made.app.request("/blog/a")).status).toBe(200);
    for (const old of ["/blog/b", "/blog/c"]) {
      const reply = await made.app.request(old);
      expect(reply.status, old).toBe(301);
      expect(reply.headers.get("location"), old).toBe("/blog/a");
    }
    const list = await (await owner.get("/api/admin/redirects")).json();
    expect(list.redirects.map((redirect: { fromPath: string }) => redirect.fromPath)).toEqual([
      "/blog/b",
      "/blog/c",
    ]);
  });

  test("a redirect from one of Tend's own addresses is refused, as it could never be used", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    for (const from of [
      "/blog",
      "/BLOG",
      "/feed",
      "/rss.xml",
      "/sitemap.xml",
      "/robots.txt",
      "/healthz",
      "/admin",
      "/admin/posts",
      "/api/admin/entries",
      "/media/x/y/480.webp",
      "/assets/meadow/x/theme.css",
    ]) {
      const reply = await owner.post("/api/admin/redirects", { from, to: "/contact" });
      expect(reply.status, from).toBe(400);
      expect((await reply.json()).error.field, from).toBe("from");
    }
    expect((await (await owner.get("/api/admin/redirects")).json()).redirects).toEqual([]);
    // Only as far as Tend's own: an old page called /blogging or /media-kit is fine.
    for (const from of ["/blogging", "/media-kit"]) {
      expect((await owner.post("/api/admin/redirects", { from, to: "/contact" })).status).toBe(201);
    }
  });

  test("a tag's page is taken while it has posts, and free to lead on from when it hasn't", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const news = await (await owner.post("/api/admin/tags", { name: "News" })).json();
    await publish(owner, "post", { title: "Opening day", tagIds: [news.id] });
    const taken = await owner.post("/api/admin/redirects", { from: "/tag/news", to: "/contact" });
    expect((await taken.json()).error.code).toBe("address_taken");

    const old = await owner.post("/api/admin/redirects", { from: "/tag/specials", to: "/blog" });
    expect(old.status).toBe(201);
    const reply = await made.app.request("/tag/specials");
    expect(reply.status).toBe(301);
    expect(reply.headers.get("location")).toBe("/blog");
  });

  test("a redirect added by hand works, but never over a page that's there", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const added = await owner.post("/api/admin/redirects", {
      from: "old-menu.html",
      to: "/contact",
    });
    expect(added.status).toBe(201);
    const reply = await made.app.request("/old-menu.html");
    expect(reply.status).toBe(301);
    expect(reply.headers.get("location")).toBe("/contact");

    const taken = await owner.post("/api/admin/redirects", { from: "/contact", to: "/" });
    expect((await taken.json()).error.code).toBe("address_taken");

    await owner.delete("/api/admin/redirects", { from: "/old-menu.html" } as never);
    const deleted = await made.app.request("/api/admin/redirects", {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        Cookie: [...owner.jar].map(([k, v]) => `${k}=${v}`).join("; "),
      },
      body: JSON.stringify({ from: "/old-menu.html" }),
    });
    expect(deleted.status).toBe(200);
    expect((await made.app.request("/old-menu.html")).status).toBe(404);
  });
});

describe("tags", () => {
  test("a tag gets its own page of posts, from what's published", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const tag = await (await owner.post("/api/admin/tags", { name: "Sourdough Recipes" })).json();
    expect(tag.slug).toBe("sourdough-recipes");
    const again = await (await owner.post("/api/admin/tags", { name: "sourdough recipes" })).json();
    expect(again.id).toBe(tag.id);

    await publish(owner, "post", { title: "Starter", tagIds: [tag.id, "not-a-tag"] });
    const list = await page(made, "/tag/sourdough-recipes");
    expect(list.status).toBe(200);
    expect(list.html).toContain("Sourdough Recipes");
    expect(list.html).toContain('href="/blog/starter"');
    const post = await page(made, "/blog/starter");
    expect(post.html).toContain('<a href="/tag/sourdough-recipes">Sourdough Recipes</a>');
    expect((await page(made, "/tag/nothing-here")).status).toBe(404);
  });

  test("a tag only drafts use has no page, so its name stays private", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const tag = await (await owner.post("/api/admin/tags", { name: "Closing down" })).json();
    const draft = await (await owner.post(ENTRIES, { type: "post" })).json();
    const saved = await owner.patch(
      `${ENTRIES}/${draft.id}`,
      { title: "Big news", tagIds: [tag.id] },
      { "If-Match": "1" },
    );
    expect((await saved.json()).data.tagIds).toEqual([tag.id]);

    const reply = await page(made, "/tag/closing-down");
    expect(reply.status).toBe(404);
    expect(reply.html).not.toContain("Closing down");
  });
});

describe("search engines and sharing", () => {
  test("a post says what it is, with its picture, and its own search title if it has one", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const image = await picture(owner);
    await owner.patch(`/api/admin/media/${image.id}`, { alt: "The shop window" });
    await publish(owner, "post", {
      title: "Opening day",
      doc: doc('Come and see us. Bring "friends" & family.'),
      featuredImage: { mediaId: image.id, alt: null },
      seo: { title: "We're open!", description: "", noindex: false },
    });
    const { html } = await page(made, "/blog/opening-day");
    expect(html).toContain("<title>We&#39;re open!</title>");
    expect(html).toContain(
      '<meta name="description" content="Come and see us. Bring &quot;friends&quot; &amp; family.">',
    );
    expect(html).toContain('<link rel="canonical" href="http://localhost/blog/opening-day">');
    expect(html).toContain('<meta property="og:type" content="article">');
    expect(html).toMatch(
      /<meta property="og:image" content="http:\/\/localhost\/media\/[^"]+\/1600\.webp">/,
    );
    expect(html).toContain('<meta property="og:image:height" content="960">');
    expect(html).toContain('<meta property="og:image:alt" content="The shop window">');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(html).toContain('"@type":"BlogPosting"');
  });

  test("the first picture stands in when no featured image is chosen", async () => {
    const made = await makeApp();
    const owner = await setUp(made, { starter: "blog" });
    const image = await picture(owner);
    await publish(owner, "post", {
      title: "Pictured",
      doc: { type: "doc", content: [{ type: "image", attrs: { mediaId: image.id } }] },
    });
    const home = await page(made, "/");
    expect(home.html).toMatch(/<img class="t-img-card"[^>]+alt=""/);
  });

  test("asking not to be shown keeps it out of search results and the sitemap", async () => {
    const made = await makeApp();
    const owner = await setUp(made, { starter: "blog" });
    await publish(owner, "post", {
      title: "Hidden",
      seo: { title: null, description: null, noindex: true },
    });
    expect((await page(made, "/blog/hidden")).html).toContain(
      '<meta name="robots" content="noindex">',
    );
    const map = await page(made, "/sitemap.xml");
    expect(map.headers.get("content-type")).toContain("application/xml");
    expect(map.html).toContain("<loc>http://localhost/blog/welcome</loc>");
    expect(map.html).not.toContain("/blog/hidden");
    expect(map.html).toContain("<loc>http://localhost/blog</loc>");
  });

  test("the feed has the newest posts, with full addresses, and /feed leads to it", async () => {
    const made = await makeApp();
    const owner = await setUp(made, { starter: "blog" });
    const image = await picture(owner, 800, 600);
    await publish(owner, "post", {
      title: "With <angle> brackets",
      doc: { type: "doc", content: [{ type: "image", attrs: { mediaId: image.id } }] },
    });
    const feed = await page(made, "/rss.xml");
    expect(feed.headers.get("content-type")).toContain("application/rss+xml");
    expect(feed.html).toContain("<title>With &lt;angle&gt; brackets</title>");
    expect(feed.html).toContain("<link>http://localhost/blog/with-angle-brackets</link>");
    expect(feed.html).toMatch(/src="http:\/\/localhost\/media\//);
    const old = await made.app.request("/feed");
    expect(old.status).toBe(301);
    expect(old.headers.get("location")).toBe("/rss.xml");
    expect((await page(made, "/")).html).toContain('type="application/rss+xml"');
  });

  test("robots.txt points at the sitemap", async () => {
    const made = await makeApp();
    await setUp(made);
    const robots = await page(made, "/robots.txt");
    expect(robots.html).toContain("Allow: /");
    expect(robots.html).toContain("Sitemap: http://localhost/sitemap.xml");
  });

  test("what's written can't break out of the head", () => {
    expect(jsonForScript({ name: "</script><script>alert(1)</script>" })).not.toContain(
      "</script>",
    );
    expect(jsonForScript({ name: "a b" })).toBe('{"name":"a\\u2028b"}');
    expect(cssForStyle("a { content: '</style>' }")).toBe("a { content: '<\\/style>' }");
    expect(cssForStyle("a { content: '</STYLE >' }")).not.toContain("</");
    // Range queries need their "<" exactly as typed, or the rules inside never apply.
    const ranges = "@media (width < 600px) { a { color: red } } @container (width <= 40em) {}";
    expect(cssForStyle(ranges)).toBe(ranges);
    const head = buildHead({
      origin: "https://example.com",
      path: '/x"><script>',
      title: '"><script>alert(1)</script>',
      description: null,
      siteName: "S",
      locale: "en",
      type: "website",
      image: null,
      noindex: false,
      structured: [],
      icon: null,
      hasFeed: false,
      themeCss: null,
      customCss: null,
      extraHead: null,
      prefetch: true,
    });
    expect(head).not.toContain("<script>");
    expect(
      rss({
        siteName: "S",
        description: "",
        origin: "https://e.com",
        locale: "en",
        items: [
          { title: "T", url: "https://e.com/x", summary: "s", html: "<p>]]></p>", publishedAt: 0 },
        ],
      }),
    ).toContain("<![CDATA[<p>]]]]><![CDATA[></p>]]>");
  });

  test("code added to every page goes in, but never into a preview", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    await owner.put("/api/admin/settings/code", {
      head: '<meta name="site-check" content="abc123">',
      bodyEnd: "<!-- counter -->",
    });
    const home = await page(made, "/");
    expect(home.html).toContain('<meta name="site-check" content="abc123">');
    expect(home.html).toContain("<!-- counter -->");
    const design = await (await owner.get("/api/admin/design")).json();
    const preview = await (await owner.post("/api/admin/design/preview", design.value)).json();
    expect(preview.html).not.toContain("site-check");
    expect(preview.html).not.toContain("counter");
  });
});

describe("only those allowed can change the site", () => {
  /** An Editor, signed in the usual way. Invites come later, so the account is added directly. */
  async function signedInEditor(made: Awaited<ReturnType<typeof makeApp>>) {
    const { GOOD_PASSWORD } = await import("./auth-helpers.ts");
    // With the Owner's password, so it can be typed in to sign in.
    made.db
      .prepare(
        "INSERT INTO users (id, email, name, role, password_hash, created_at) SELECT ?, ?, ?, 'editor', password_hash, created_at FROM users WHERE is_owner = 1",
      )
      .run("0193a0a0-0000-7000-8000-0000000000ed", "eddie@example.com", "Eddie");
    const editor = browser(made.app);
    const signedIn = await editor.post("/api/auth/login", {
      email: "eddie@example.com",
      password: GOOD_PASSWORD,
    });
    expect(signedIn.status).toBe(200);
    expect((await editor.get("/api/auth/me")).status).toBe(200);
    return editor;
  }

  test("an editor can change the menu, but not the design or settings", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const editor = await signedInEditor(made);

    expect((await editor.get("/api/admin/menus")).status).toBe(200);
    const link = {
      id: "visit",
      label: "Find us",
      target: { type: "url", url: "https://maps.example/rise" },
      children: [],
    };
    expect((await editor.put("/api/admin/menus/footer", { items: [link] })).status).toBe(200);
    expect((await page(made, "/")).html).toContain("Find us");

    const design = await (await owner.get("/api/admin/design")).json();
    const refused = {
      "reading the design": await editor.get("/api/admin/design"),
      "saving the design": await editor.put("/api/admin/design", design.value),
      "reading settings": await editor.get("/api/admin/settings/general"),
      "saving settings": await editor.put("/api/admin/settings/general", { name: "Taken over" }),
    };
    for (const [what, reply] of Object.entries(refused)) {
      expect(reply.status, what).toBe(403);
      expect((await reply.json()).error, what).toMatchObject({
        message: "Your account can't do that.",
        fix: "Ask whoever runs this site.",
      });
    }
    const home = await page(made, "/");
    expect(home.html).toContain("Rise Bakery");
    expect(home.html).not.toContain("Taken over");
  });
});

describe("fixes from review", () => {
  async function redirectsAfter(owner: Client) {
    const list = await (await owner.get("/api/admin/redirects")).json();
    return Object.fromEntries(
      list.redirects.map((redirect: { fromPath: string; toPath: string }) => [
        redirect.fromPath,
        redirect.toPath,
      ]),
    );
  }

  test("a redirect added by hand never removes another, and goes straight to the end", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const post = await publish(owner, "post", { title: "Moving", slug: "a" });
    const saved = await (
      await owner.patch(`${ENTRIES}/${post.id}`, { slug: "b" }, { "If-Match": String(post.rev) })
    ).json();
    await owner.post(`${ENTRIES}/${post.id}/publish`, {}, { "If-Match": String(saved.rev) });
    expect(await redirectsAfter(owner)).toEqual({ "/blog/a": "/blog/b" });

    const added = await owner.post("/api/admin/redirects", { from: "/old-menu", to: "/blog/a" });
    expect(added.status).toBe(201);
    expect(await redirectsAfter(owner)).toEqual({ "/blog/a": "/blog/b", "/old-menu": "/blog/b" });
    for (const old of ["/blog/a", "/old-menu"]) {
      const reply = await made.app.request(old);
      expect(reply.status, old).toBe(301);
      expect(reply.headers.get("location"), old).toBe("/blog/b");
    }
  });

  test("a redirect that would go round in circles is refused, whatever the capitals", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    await owner.post("/api/admin/redirects", { from: "/y", to: "/x" });
    for (const [from, to] of [
      ["/x", "/y"],
      ["/menu", "/Menu"],
      ["/menu", "/menu?ref=old"],
      ["/menu", "/menu#top"],
      ["/menu", "http://localhost/menu"],
    ]) {
      const reply = await owner.post("/api/admin/redirects", { from, to });
      expect(reply.status, `${from} → ${to}`).toBe(400);
      const body = await reply.json();
      expect(body.error.fix, `${from} → ${to}`).toBeTruthy();
    }
  });

  test("an old address typed with capitals leads on, whatever capitals it's asked for in", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    await owner.post("/api/admin/redirects", {
      from: "https://old.example/Menu.html",
      to: "/contact",
    });
    expect(await redirectsAfter(owner)).toEqual({ "/menu.html": "/contact" });
    for (const path of ["/Menu.html", "/menu.html", "/MENU.HTML"]) {
      const reply = await made.app.request(path);
      expect(reply.status, path).toBe(301);
      expect(reply.headers.get("location"), path).toBe("/contact");
    }
  });

  test("going round in circles is refused in capitals beyond A to Z too", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    await owner.post("/api/admin/redirects", { from: "/café", to: "/x" });
    const reply = await owner.post("/api/admin/redirects", { from: "/x", to: "/CAFÉ" });
    expect(reply.status).toBe(400);
    expect(await redirectsAfter(owner)).toEqual({ "/café": "/x" });

    // Moving the page that one leads to doesn't make a chain, or point anything at itself.
    addRedirect(made.orm, { from: "/x", to: "/Été", source: "auto", now: 1 });
    addRedirect(made.orm, { from: "/été", to: "/CAFÉ", source: "auto", now: 2 });
    expect(await redirectsAfter(owner)).toEqual({ "/été": "/CAFÉ", "/x": "/CAFÉ" });
  });

  test("old-site addresses are stored the way they'll be asked for", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    await owner.post("/api/admin/redirects", { from: "https://old.example/café", to: "/contact" });
    await owner.post("/api/admin/redirects", { from: "oldsite.com/our-menu", to: "/contact" });
    await owner.post("/api/admin/redirects", { from: "menu.html", to: "www.example.com/menu" });
    expect(await redirectsAfter(owner)).toEqual({
      "/café": "/contact",
      "/our-menu": "/contact",
      "/menu.html": "https://www.example.com/menu",
    });
    for (const path of ["/caf%C3%A9", "/CAF%C3%A9", "/our-menu"]) {
      const reply = await made.app.request(path);
      expect(reply.status, path).toBe(301);
      expect(reply.headers.get("location"), path).toBe("/contact");
    }
    const query = await owner.post("/api/admin/redirects", { from: "/?p=123", to: "/contact" });
    expect((await query.json()).error.message).toMatch(/\?/);
  });

  test("an old address with a % in it still leads somewhere, however it was typed", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    await owner.post("/api/admin/redirects", { from: "https://old.example/100%25-rye", to: "/a" });
    await owner.post("/api/admin/redirects", { from: "/50%-off", to: "/b" });
    await owner.post("/api/admin/redirects", { from: "/caf%E9/%C3%A9t%C3%A9", to: "/c" });
    for (const [path, to] of Object.entries({
      "/100%25-rye": "/a",
      "/50%-off": "/b",
      "/caf%E9/%C3%A9t%C3%A9": "/c",
    })) {
      const reply = await made.app.request(path);
      expect(reply.status, path).toBe(301);
      expect(reply.headers.get("location"), path).toBe(to);
    }
  });

  test("a redirect pointing back at its own address, in other capitals, is never kept", async () => {
    const made = await makeApp();
    await setUp(made);
    addRedirect(made.orm, { from: "/rye", to: "/spelt", source: "import", now: 1 });
    addRedirect(made.orm, { from: "/spelt", to: "/RYE", source: "import", now: 2 });
    const reply = await made.app.request("/rye");
    expect(reply.status).toBe(404);
    expect((await made.app.request("/spelt")).headers.get("location")).toBe("/RYE");
  });

  test("a redirect can only lead to a web page, and never breaks the header it's sent in", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    for (const to of ["javascript:alert(1)", "https://example.com/a\nb", "/a\r\nSet-Cookie: x=1"]) {
      const reply = await owner.post("/api/admin/redirects", { from: "/old", to });
      expect(reply.status, JSON.stringify(to)).toBe(400);
    }
    await owner.post("/api/admin/redirects", { from: "/old", to: "/café menu" });
    const reply = await made.app.request("/old");
    expect(reply.status).toBe(301);
    expect(reply.headers.get("location")).toBe("/caf%C3%A9%20menu");
  });

  test("a site with a known address names it on every page, whatever Host was sent", async () => {
    const made = await makeApp({ publicUrl: "https://rise.example", pageCacheBytes: 1_000_000 });
    await setUp(made);
    for (const url of ["http://evil.example/", "/"]) {
      const html = await (await made.app.request(url)).text();
      expect(html, url).toContain('<link rel="canonical" href="https://rise.example/">');
    }
  });

  test("without a known address, each address asked for gets its own copy of a page", async () => {
    const made = await makeApp({ pageCacheBytes: 1_000_000 });
    await setUp(made);
    const evil = await (await made.app.request("http://evil.example/")).text();
    expect(evil).toContain('href="http://evil.example/"');
    const normal = await (await made.app.request("http://rise.example/")).text();
    expect(normal).toContain('<link rel="canonical" href="http://rise.example/">');
    expect(normal).not.toContain("evil.example");
    // Made-up addresses can't push real pages out: only a few are ever cached.
    for (let count = 0; count < 10; count++)
      await made.app.request(`http://made-up-${count}.example/`);
    const again = await made.app.request("http://rise.example/");
    expect(again.headers.get("server-timing")).toContain("hit");
    const madeUp = await made.app.request("http://made-up-9.example/");
    expect(madeUp.headers.get("server-timing")).not.toContain("hit");
  });

  test("https from a proxy only counts when the proxy is trusted", async () => {
    const headers = { "x-forwarded-proto": "https" };
    const direct = await makeApp();
    await setUp(direct);
    const plain = await (await direct.app.request("http://rise.example/", { headers })).text();
    expect(plain).toContain('<link rel="canonical" href="http://rise.example/">');

    const proxied = await makeApp({ trustProxy: 1 });
    await setUp(proxied);
    const secure = await (await proxied.app.request("http://rise.example/", { headers })).text();
    expect(secure).toContain('<link rel="canonical" href="https://rise.example/">');
  });

  test("the site's own address only counts once it's confirmed", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const confirm = (confirmed: boolean) => {
      const row = made.orm.select().from(settings).where(eq(settings.key, "site")).get();
      made.orm
        .update(settings)
        .set({
          value: {
            ...(row?.value as object),
            address: "https://rise.example/",
            address_confirmed: confirmed,
          },
        })
        .where(eq(settings.key, "site"))
        .run();
    };
    confirm(false);
    const unconfirmed = await (await made.app.request("http://other.example/")).text();
    expect(unconfirmed).toContain('<link rel="canonical" href="http://other.example/">');
    confirm(true);
    // A change made through Tend, since it only looks again after one.
    const general = await (await owner.get("/api/admin/settings/general")).json();
    await owner.put("/api/admin/settings/general", { ...general.value, name: "Rise" });
    const confirmed = await (await made.app.request("http://other.example/about")).text();
    expect(confirmed).toContain("https://rise.example/");
    expect(confirmed).not.toContain("other.example");
  });

  test("saving what's there already leaves the site's pages as they were", async () => {
    const made = await makeApp({ pageCacheBytes: 1_000_000 });
    const owner = await setUp(made);
    const design = await (await owner.get("/api/admin/design")).json();
    await owner.put("/api/admin/design", { ...design.value, footerText: "Baked daily" });
    await made.app.request("/");
    expect((await made.app.request("/")).headers.get("server-timing")).toContain("hit");
    const again = await owner.put("/api/admin/design", {
      ...design.value,
      footerText: "Baked daily",
    });
    expect((await again.json()).saved).toBe(false);
    expect((await made.app.request("/")).headers.get("server-timing")).toContain("hit");
  });

  test("pages made in the background name the site's address, or aren't made at all", async () => {
    const known = await makeApp({ publicUrl: "https://rise.example", pageCacheBytes: 1_000_000 });
    const owner = await setUp(known);
    await publish(owner, "post", { title: "Fresh" });
    await known.settled();
    const refilled = await known.app.request("/");
    expect(refilled.headers.get("server-timing")).toContain("hit");
    expect(await refilled.text()).not.toContain("http://localhost");

    const unknown = await makeApp({ pageCacheBytes: 1_000_000 });
    const other = await setUp(unknown);
    await publish(other, "post", { title: "Fresh" });
    await unknown.settled();
    const first = await unknown.app.request("http://rise.example/");
    expect(first.headers.get("server-timing")).toContain("miss");
    expect(await first.text()).not.toContain("http://localhost");
  });

  test("a Private site's pictures are only for people signed in, except its logo", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const photo = await picture(owner, 600, 400);
    const logo = await picture(owner, 600, 200);
    const design = await (await owner.get("/api/admin/design")).json();
    await owner.put("/api/admin/design", { ...design.value, logoId: logo.id });
    const smallest = (item: { srcset: string }) => item.srcset.split(" ")[0] as string;
    await owner.put("/api/admin/settings/visibility", { mode: "private" });

    for (const url of [photo.url, smallest(photo)]) {
      const visitor = await made.app.request(url);
      expect(visitor.status, url).toBe(404);
      const signedIn = await owner.get(url);
      expect(signedIn.status, url).toBe(200);
      // For that person only: a shared cache mustn't hand it to the next visitor.
      expect(signedIn.headers.get("cache-control"), url).toBe(
        "private, max-age=31536000, immutable",
      );
    }
    expect((await made.app.request(smallest(logo))).status).toBe(200);

    // Coming soon shows the logo and links to nothing else, so nothing changes there.
    await owner.put("/api/admin/settings/visibility", { mode: "coming_soon" });
    expect((await made.app.request(smallest(photo))).status).toBe(200);
    await owner.put("/api/admin/settings/visibility", { mode: "public" });
    const open = await made.app.request(smallest(photo));
    expect(open.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  test("a missing picture or file gets a plain 404, even on a private site", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    await owner.put("/api/admin/settings/visibility", { mode: "private" });
    for (const path of ["/media/not-an-id/x/480.webp", "/assets/meadow/0/nothing.css"]) {
      const reply = await made.app.request(path);
      expect(reply.status, path).toBe(404);
      expect(reply.headers.get("content-type"), path).toContain("text/plain");
      expect(await reply.text(), path).not.toContain("Contact");
    }
  });

  test("a logo in the Trash shows the site's name instead of nothing", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const logo = await picture(owner, 600, 200);
    const design = await (await owner.get("/api/admin/design")).json();
    await owner.put("/api/admin/design", { ...design.value, logoId: logo.id });
    await owner.post(`/api/admin/media/${logo.id}/trash`, {});
    const { html } = await page(made, "/");
    expect(html).toMatch(/<a class="t-brand" href="\/" aria-current="page">Rise Bakery<\/a>/);
  });

  test("characters XML can't carry are left out of the feed, even inside a post", async () => {
    const made = await makeApp();
    const owner = await setUp(made, { starter: "blog" });
    await publish(owner, "post", {
      title: "Pasted\u000b title",
      doc: doc("From a slide\u000c deck"),
    });
    const feed = await page(made, "/rss.xml");
    expect(feed.html.includes("\u000b") || feed.html.includes("\u000c")).toBe(false);
    expect(feed.html).toContain("From a slide deck");
  });

  test("tags work in any language, and the same name in any case is the same tag", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const bread = await (await owner.post("/api/admin/tags", { name: "Хлеб" })).json();
    expect(bread.slug).toMatch(/^tag-[0-9a-f]{8}$/);
    expect((await (await owner.post("/api/admin/tags", { name: "хлеб" })).json()).id).toBe(
      bread.id,
    );
    const cafe = await (await owner.post("/api/admin/tags", { name: "Café" })).json();
    expect((await (await owner.post("/api/admin/tags", { name: "cafe" })).json()).id).toBe(cafe.id);
    await publish(owner, "post", { title: "Rye", tagIds: [bread.id] });
    expect((await page(made, `/tag/${bread.slug}`)).html).toContain("Хлеб");
    const long = await owner.post("/api/admin/tags", { name: "x".repeat(61) });
    expect((await long.json()).error.message).toContain("60");
    const marks = await owner.post("/api/admin/tags", { name: "!!!" });
    expect(marks.status).toBe(400);
    expect((await marks.json()).error.fix).toBe("Type a word for it, like Recipes.");
  });

  test("links under a hidden one stay in the menu, in its place", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const draft = await (await owner.post(ENTRIES, { type: "page" })).json();
    await owner.put("/api/admin/menus/main", {
      items: [
        {
          id: "services",
          label: "Services",
          target: { type: "entry", id: draft.id },
          children: [{ id: "contact", label: "Contact", target: { type: "url", url: "/contact" } }],
        },
      ],
    });
    const menu = (await page(made, "/")).html.match(/<nav aria-label="Main">[\s\S]*?<\/nav>/)?.[0];
    expect(menu).toContain('<a href="/contact">Contact</a>');
    expect(menu).not.toContain("Services");
  });

  test("Show in site menu leaves a full menu as it is", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const items = Array.from({ length: 30 }, (_, index) => ({
      id: `link-${index}`,
      label: `Link ${index}`,
      target: { type: "url", url: `/link-${index}` },
      children: [],
    }));
    expect((await owner.put("/api/admin/menus/main", { items })).status).toBe(200);
    const entry = await (await owner.post(ENTRIES, { type: "page" })).json();
    const saved = await (
      await owner.patch(`${ENTRIES}/${entry.id}`, { title: "One more" }, { "If-Match": "1" })
    ).json();
    const published = await owner.post(
      `${ENTRIES}/${entry.id}/publish`,
      { addToMenu: true },
      { "If-Match": String(saved.rev) },
    );
    expect(published.status).toBe(200);
    const menus = await (await owner.get("/api/admin/menus")).json();
    expect(menus.main.items).toHaveLength(30);
  });
});

describe("the site's address (PLAN.md J10)", () => {
  // Where the admin is open, as the browser says when it sends a change.
  const AT = {
    Origin: "https://rise.example.com",
    Host: "rise.example.com",
    "Sec-Fetch-Site": "same-origin",
  };

  test("is confirmed from the address the admin is open at, and then names every page", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const me = async () => (await (await owner.get("/api/auth/me")).json()).site;
    expect(await me()).toMatchObject({
      address: null,
      addressFrom: null,
      addressIsPublic: false,
      visibility: "public",
    });
    // Until then, each page names the address it was asked for.
    expect((await page(made, "http://other.example.net/")).html).toContain(
      'rel="canonical" href="http://other.example.net/"',
    );

    // Only the address the admin is open at, and only if that's how the request arrived.
    const elsewhere = await owner.post(
      "/api/admin/address",
      { address: "https://elsewhere.example.com" },
      AT,
    );
    expect(elsewhere.status).toBe(400);
    expect((await elsewhere.json()).error.code).toBe("address_mismatch");
    const throughProxy = await owner.post(
      "/api/admin/address",
      { address: AT.Origin },
      { ...AT, Host: "127.0.0.1:3000" },
    );
    expect(throughProxy.status).toBe(400);

    const confirmed = await owner.post("/api/admin/address", { address: AT.Origin }, AT);
    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toEqual({ address: "https://rise.example.com" });
    expect(await me()).toMatchObject({
      address: "https://rise.example.com",
      addressFrom: "confirmed",
      addressIsPublic: true,
    });
    // Every page names it now, whichever address it was asked for.
    expect((await page(made, "http://other.example.net/")).html).toContain(
      'rel="canonical" href="https://rise.example.com/"',
    );
    // Changing the site's name later keeps it.
    const general = await (await owner.get("/api/admin/settings/general")).json();
    await owner.put("/api/admin/settings/general", { ...general.value, name: "Rise" });
    expect(await me()).toMatchObject({ address: "https://rise.example.com" });
  });

  test("can't be changed here when it's set where Tend runs", async () => {
    const made = await makeApp({ publicUrl: "https://bakery.example.com" });
    const owner = await setUp(made);
    expect((await (await owner.get("/api/auth/me")).json()).site).toMatchObject({
      address: "https://bakery.example.com",
      addressFrom: "set",
    });
    const reply = await owner.post("/api/admin/address", { address: AT.Origin }, AT);
    expect(reply.status).toBe(409);
    expect((await reply.json()).error.code).toBe("address_set");
  });

  test("can be the site's own domain instead of the one its host gave it (J11)", async () => {
    const made = await makeApp({
      platformUrl: "https://rise.up.railway.app",
      secureCookies: true,
      pageCacheBytes: 1_000_000,
    });
    const owner = await setUp(made);
    const me = async () => (await (await owner.get("/api/auth/me")).json()).site;
    expect(await me()).toMatchObject({
      address: "https://rise.up.railway.app",
      addressFrom: "platform",
      addressIsPublic: true,
    });
    expect((await page(made, "https://rise.up.railway.app/")).html).toContain(
      'rel="canonical" href="https://rise.up.railway.app/"',
    );
    expect((await owner.post("/api/admin/address", { address: AT.Origin }, AT)).status).toBe(200);
    expect(await me()).toMatchObject({ address: AT.Origin, addressFrom: "confirmed" });
    // The page kept for the old address goes with it.
    expect((await page(made, "https://rise.up.railway.app/")).html).toContain(
      'rel="canonical" href="https://rise.example.com/"',
    );
  });

  test("can't be one that only works on this computer", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const local = { Origin: "http://localhost:3000", Host: "localhost:3000" };
    const reply = await owner.post("/api/admin/address", { address: local.Origin }, local);
    expect(reply.status).toBe(400);
    expect((await reply.json()).error.code).toBe("address_local");
  });

  test("on https changes the cookies, and keeps whoever confirmed it signed in", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const { client: editor } = await signedInAs(made, "editor");
    const plain = owner.jar.get("tend_session") as string;
    expect((await owner.get("/api/auth/me")).headers.get("strict-transport-security")).toBeNull();

    const confirmed = await owner.post("/api/admin/address", { address: AT.Origin }, AT);
    for (const name of ["__Host-tend_session=", "__Host-tend_device="]) {
      const cookie = confirmed.cookies.find((line) => line.startsWith(name));
      expect(cookie).toMatch(/Secure/i);
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).not.toMatch(/Domain=/i);
    }
    const reply = await owner.get("/api/auth/me");
    expect(reply.status).toBe(200);
    expect(reply.headers.get("strict-transport-security")).toContain("max-age=");
    // A cookie with the old name could be planted by a site that shares part of the address.
    const old = browser(made.app);
    old.jar.set("tend_session", plain);
    expect((await old.get("/api/auth/me")).status).toBe(401);
    expect((await editor.get("/api/auth/me")).status).toBe(401);
    // Signing in again gets the new ones.
    const login = await browser(made.app).post("/api/auth/login", {
      email: OWNER_EMAIL,
      password: GOOD_PASSWORD,
    });
    expect(login.cookies.some((line) => line.startsWith("__Host-tend_session="))).toBe(true);
  });

  test("on plain http leaves the cookies as they are", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const http = { Origin: "http://rise.example.com", Host: "rise.example.com" };
    expect((await owner.post("/api/admin/address", { address: http.Origin }, http)).status).toBe(
      200,
    );
    const reply = await owner.get("/api/auth/me");
    expect(reply.status).toBe(200);
    expect(reply.headers.get("strict-transport-security")).toBeNull();
  });
});

describe("whether an address is public (PLAN.md P15)", () => {
  test.each([
    "https://rise.example.com",
    "https://rise.up.railway.app",
    "http://203.0.114.7:3000",
    "https://[2001:4860:4860::8888]",
    "https://localhost.example.com",
  ])("%s is", (url) => {
    expect(isPublicAddress(url)).toBe(true);
  });

  test.each([
    "http://localhost:3000",
    "http://tend.localhost",
    "http://127.0.0.1:3000",
    "http://[::1]:3000",
    "http://192.168.1.20:3000",
    "http://10.0.0.5",
    "http://172.20.1.1",
    "http://100.100.1.1",
    "http://169.254.10.10",
    "http://[fd00::1]",
    "http://[fe80::1]",
    "http://nas:3000",
    "http://nas.local",
    "http://tend.home.arpa",
    "http://tend.internal",
    "https://rise.test",
  ])("%s isn't", (url) => {
    expect(isPublicAddress(url)).toBe(false);
  });

  test("one from a hosting platform is told apart from a domain of one's own", () => {
    expect(isHostingAddress("https://rise.up.railway.app")).toBe(true);
    expect(isHostingAddress("https://rise.onrender.com")).toBe(true);
    expect(isHostingAddress("https://rise.fly.dev")).toBe(true);
    expect(isHostingAddress("https://risebakery.com")).toBe(false);
    expect(isHostingAddress("https://notrailway.app")).toBe(false);
  });
});
