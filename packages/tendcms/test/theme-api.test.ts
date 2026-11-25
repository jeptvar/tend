import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import sharp from "sharp";
import { describe, expect, test } from "vitest";
import { defaultThemeDir } from "../src/paths.ts";
import type { AppOptions } from "../src/server.ts";
import { hoursSummary } from "../src/site/router.ts";
import { madeFor } from "../src/site/theme-range.ts";
import { makeApp, setUp } from "./auth-helpers.ts";
import { tempDir } from "./helpers.ts";

// What a theme can use (PLAN.md §10): words in the site's language, menus, the page's head,
// pictures by address, the site's own details, and its choices as CSS.

type Files = Record<string, string | object>;

/** A site drawn with a theme holding these files, and Meadow's for the rest. */
async function siteWith(files: Files, overrides: Partial<AppOptions> = {}, setup: object = {}) {
  const folder = tempDir();
  for (const [name, content] of Object.entries({ "theme.json": { name: "Own" }, ...files })) {
    const path = join(folder, "own", name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  }
  const made = await makeApp({ themeFolders: [folder], ...overrides });
  const owner = await setUp(made, setup as Record<string, unknown>);
  const design = await (await owner.get("/api/admin/design")).json();
  const saved = await owner.put("/api/admin/design", { ...design.value, themeId: "own" });
  expect(saved.status).toBe(200);
  const page = async (path = "/") =>
    (await made.app.request(`http://rise.example.com${path}`)).text();
  return { made, owner, page, dir: join(folder, "own") };
}

/** A whole page that's only this. */
function only(body: string): Files {
  return { "templates/home.liquid": body, "templates/404.liquid": body };
}

async function upload(owner: Awaited<ReturnType<typeof setUp>>, width = 2000, height = 1200) {
  const picture = await sharp({ create: { width, height, channels: 3, background: "#884422" } })
    .jpeg()
    .toBuffer();
  const reply = await owner.upload("/api/admin/media", picture, "loaf.jpg");
  expect(reply.status).toBe(201);
  return (await reply.json()).id as string;
}

async function publishPost(owner: Awaited<ReturnType<typeof setUp>>, fields: object) {
  const entry = await (await owner.post("/api/admin/entries", { type: "post" })).json();
  const url = `/api/admin/entries/${entry.id}`;
  const saved = await (await owner.patch(url, fields, { "If-Match": "1" })).json();
  const published = await owner.post(`${url}/publish`, {}, { "If-Match": String(saved.rev) });
  expect(published.status).toBe(200);
  return (await published.json()).url as string;
}

describe("the theme's own words", () => {
  const site = (locale: string) => ({
    site: { name: "Rise Bakery", tagline: "", locale, timezone: "UTC" },
  });

  test("are in the site's language, then the nearest one, then English", async () => {
    const page = (locale: string) =>
      siteWith(
        only('{{ "blog" | t }} {{ "skip" | t }} {{ "address" | t }}'),
        {},
        site(locale),
      ).then((made) => made.page());
    expect(await page("en-PH")).toBe("Blog Skip to content Address");
    expect(await page("fr-CA")).toBe("Blog Aller au contenu Adresse");
    // Brazil's words where they differ, and Portugal's for the rest.
    expect(await page("pt-BR")).toBe("Blog Ir para o conteúdo Endereço");
    expect(await page("pt-PT")).toBe("Blog Ir para o conteúdo Morada");
    expect(await page("sv")).toBe("Blog Skip to content Address");
  });

  test("can be a theme's own, a word at a time, with values put in", async () => {
    const { page } = await siteWith({
      ...only(
        '{{ "skip" | t }}|{{ "call" | t: phone: "555 <0100>" }}|{{ "mine" | t }}|{{ "nobody" | t }}',
      ),
      "locales/en.json": { skip: "To the bread", mine: "Only here", bad: 7 },
    });
    // What's put in is escaped like anything else a theme writes.
    expect(await page()).toBe("To the bread|Call 555 &lt;0100&gt;|Only here|nobody");
  });

  test("change as soon as their file does on a site that's being worked on", async () => {
    const { page, dir } = await siteWith({
      ...only('{{ "skip" | t }}'),
      "locales/en.json": { skip: "Before" },
    });
    expect(await page()).toBe("Before");
    writeFileSync(join(dir, "locales", "en.json"), JSON.stringify({ skip: "After" }));
    expect(await page()).toBe("After");
  });

  test("are there for every word Meadow uses, in every language it has", () => {
    const folder = join(defaultThemeDir, "locales");
    const english = JSON.parse(readFileSync(join(folder, "en.json"), "utf8"));
    const used = new Set<string>();
    for (const part of ["templates", "partials"]) {
      for (const name of readdirSync(join(defaultThemeDir, part))) {
        const text = readFileSync(join(defaultThemeDir, part, name), "utf8");
        for (const match of text.matchAll(/\{\{\s*["'](\w+)["']\s*\|\s*t\b/g)) {
          used.add(match[1] as string);
        }
      }
    }
    expect(used.size).toBeGreaterThan(10);
    expect([...used].filter((key) => !(key in english))).toEqual([]);
    for (const name of readdirSync(folder)) {
      const words = JSON.parse(readFileSync(join(folder, name), "utf8"));
      const unknown = Object.keys(words).filter((key) => !(key in english));
      expect(unknown, name).toEqual([]);
      // A language of a place only holds what differs from the language itself.
      if (!name.includes("-")) {
        expect(
          Object.keys(english).filter((key) => !(key in words)),
          name,
        ).toEqual([]);
      }
      for (const [key, text] of Object.entries(words)) {
        const holes = (value: unknown) => String(value).match(/\{\w+\}/g) ?? [];
        expect(holes(text), `${name} ${key}`).toEqual(holes(english[key]));
      }
    }
  });

  test("name the page in the browser's tab, too", async () => {
    const french = await makeApp();
    await setUp(french, site("fr"));
    const missing = await (await french.app.request("/nulle-part")).text();
    expect(missing).toContain("<title>Page introuvable · Rise Bakery</title>");
    expect(missing).toContain("Aller à l&#39;accueil");
  });
});

describe("what templates can use", () => {
  test("is the same everywhere, partials too, without being handed on", async () => {
    const { page } = await siteWith({
      ...only('{% render "bit" %}'),
      "partials/bit.liquid":
        "{{ site.name }}|{{ request.path }}|{{ menus.main.size }}|{{ design.fonts }}",
      "theme.json": {
        name: "Own",
        settings: [{ id: "fonts", type: "select", label: "Fonts", default: "a", options: ["a"] }],
      },
    });
    expect(await page()).toBe("Rise Bakery|/|1|a");
  });

  test("has the site's address and icon, and each page's search settings", async () => {
    const { owner, page, made } = await siteWith({
      ...only("{{ site.url }}|{{ site.icon.small }}|{{ page.seo.title }}"),
      "templates/post.liquid":
        "{{ post.seo.description }}|{{ post.seo.noindex }}|{{ post.updated_at | iso_date }}",
    });
    expect(await page()).toBe("http://rise.example.com||");
    const logo = await upload(owner, 400, 400);
    const design = await (await owner.get("/api/admin/design")).json();
    await owner.put("/api/admin/design", { ...design.value, logoId: logo });
    expect(await page()).toMatch(
      new RegExp(`^http://rise.example.com\\|/media/${logo}/[0-9a-f]+/icon-32.png\\|$`),
    );
    const url = await publishPost(owner, {
      title: "Rye",
      seo: { description: "All about rye", noindex: true },
    });
    expect(await page(url)).toBe(`All about rye|true|${new Date(made.clock.time).toISOString()}`);
  });

  test("draws a menu, and says which menus there are", async () => {
    const { page, owner } = await siteWith(only('{% menu "main" %}{% menu "footer" %}'));
    await owner.put("/api/admin/menus/footer", {
      items: [
        { id: "a", label: "Away", target: { type: "url", url: "https://e.com" }, children: [] },
      ],
    });
    const html = await page();
    expect(html).toContain('<nav aria-label="Main">');
    expect(html).toContain('<a href="/contact">Contact</a>');
    expect(html).toContain('<nav aria-label="Footer">');
    expect(html).toContain('<a href="https://e.com">Away</a>');

    const own = await siteWith({
      ...only('{% menu "main" %}'),
      "partials/menu.liquid": "{{ name }}:{% for item in items %}{{ item.title }}{% endfor %}",
    });
    expect(await own.page()).toBe("main:Contact");
  });

  test("a menu that isn't one is a mistake in the theme, and the site stays up", async () => {
    const { page, owner } = await siteWith(only('{% menu "sidebar" %}'));
    expect(await page()).toContain("<title>Rise Bakery</title>");
    const { themes } = await (await owner.get("/api/admin/design")).json();
    expect(themes[1].problem).toContain('{% menu "main" %} or {% menu "footer" %}');
  });

  test("writes the head and the end of the page with tags of their own", async () => {
    const { page, owner } = await siteWith(only("{% seo %}<hr>{% body_end %}"));
    await owner.put("/api/admin/settings/code", {
      head: '<meta name="site-check" content="1">',
      bodyEnd: "<!-- the end -->",
    });
    const html = await page();
    expect(html).toContain("<title>Rise Bakery</title>");
    expect(html).toContain('<meta name="site-check" content="1">');
    expect(html.endsWith("<hr><!-- the end -->")).toBe(true);
  });

  test("formats dates as short, medium, long or full, in the site's language", async () => {
    const { page, owner } = await siteWith(
      {
        "templates/post.liquid":
          '{{ post.published_at | date: "short" }}|{{ post.published_at | date }}|{{ post.published_at | date: "full" }}|{{ post.published_at | date: "odd" }}',
      },
      {},
      { site: { name: "Rise", tagline: "", locale: "en-GB", timezone: "UTC" } },
    );
    const url = await publishPost(owner, { title: "Rye" });
    const [short, medium, full, odd] = (await page(url)).split("|");
    expect(short).toMatch(/^\d\d\/\d\d\/\d{4}$/);
    expect(medium).toMatch(/^\d+ \w+ \d{4}$/);
    expect(full).toMatch(/^\w+,? \d+ \w+ \d{4}$/);
    expect(odd).toBe(medium);
  });
});

describe("pictures", () => {
  test("are given by address, at the smallest size that's big enough", async () => {
    const { page, owner } = await siteWith({
      "templates/post.liquid":
        '<a href="{{ post.image | img_url: 600 }}" data-set="{{ post.image | srcset }}">{{ post.image | img_url: 99999 }}</a>',
    });
    const id = await upload(owner);
    const url = await publishPost(owner, {
      title: "Rye",
      featuredImage: { mediaId: id, alt: null },
    });
    const html = await page(url);
    expect(html).toMatch(new RegExp(`href="/media/${id}/[0-9a-f]+/960\\.webp"`));
    expect(html).toMatch(
      new RegExp(`data-set="/media/${id}/[0-9a-f]+/480\\.webp 480w, /media/.* 1600w`),
    );
    // Only as an attribute: in a page's words, the same characters are only characters.
    expect(html).toContain(`>tend:img:${id}:99999</a>`);

    await owner.post(`/api/admin/media/${id}/trash`);
    expect(await page(url)).toContain('href="" data-set=""');
  });

  test("typed into a post, an address like Tend's own stays as it was typed", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const id = await upload(owner);
    const typed = `="tend:img:${id}:960" and tend:srcset:${id}`;
    const url = await publishPost(owner, {
      title: typed,
      doc: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: typed }] }],
      },
    });
    const html = await (await made.app.request(url)).text();
    expect(html).not.toContain(`/media/${id}`);
    expect(html).toContain(`tend:srcset:${id}`);
  });

  test("say how wide they're shown, and whether they come first, where a theme knows", async () => {
    const { page, owner } = await siteWith({
      "templates/post.liquid": [
        "{% image post.image %}",
        '{% image post.image, sizes: "(min-width: 40rem) 20rem, 50vw", priority: true %}',
        "{% image post.image, priority: false %}",
      ].join("<hr>"),
    });
    const id = await upload(owner);
    const url = await publishPost(owner, {
      title: "Rye",
      featuredImage: { mediaId: id, alt: null },
    });
    const [first, second, third] = (await page(url)).split("<hr>") as [string, string, string];
    expect(first).toContain('fetchpriority="high"');
    expect(second).toContain('sizes="(min-width: 40rem) 20rem, 50vw"');
    expect(second).toContain('fetchpriority="high"');
    expect(second).not.toContain("loading=");
    expect(third).toContain('loading="lazy"');
  });
});

describe("a theme's choices", () => {
  const settings = [
    { id: "accent", type: "color", label: "Accent", default: "#1f6f4a" },
    {
      id: "page_edge",
      type: "color",
      label: "Edge",
      default: "#eeeeee",
      contrastAgainst: "#FFFFFF",
    },
    {
      key: "width",
      type: "select",
      label: "Width",
      default: "narrow",
      options: ["narrow", "wide"],
    },
    {
      id: "odd",
      type: "select",
      label: "Odd",
      default: "a",
      options: ["a", { value: "b}</style><script>", label: "B" }],
    },
  ];

  test("are CSS custom properties, when they aren't the theme's own", async () => {
    const { page, owner } = await siteWith({
      ...only("<head>{% seo %}</head>"),
      "theme.json": { name: "Own", settings },
    });
    expect(await page()).not.toContain("--tend-");
    const design = await (await owner.get("/api/admin/design")).json();
    const saved = await owner.put("/api/admin/design", {
      ...design.value,
      theme: {
        ...design.value.theme,
        page_edge: "#102030",
        width: "wide",
        odd: "b}</style><script>",
      },
    });
    expect(saved.status).toBe(200);
    const html = await page();
    expect(html).toContain(":root { --tend-page-edge: #102030; --tend-width: wide; }");
    // One that could end the rule it's in isn't written at all.
    expect(html).not.toContain("--tend-odd");
    expect(html).not.toContain("</style><script>");
  });

  test("say which backgrounds a colour goes on, for the form to check", async () => {
    const { owner } = await siteWith({ "theme.json": { name: "Own", settings } });
    const { themes } = await (await owner.get("/api/admin/design")).json();
    expect(themes[1].settings).toMatchObject([
      { id: "accent", type: "color" },
      { id: "page_edge", contrastAgainst: ["#ffffff"] },
      {
        id: "width",
        options: [
          { value: "narrow", label: "narrow" },
          { value: "wide", label: "wide" },
        ],
      },
      { id: "odd" },
    ]);
    expect(themes[1].settings[0]).not.toHaveProperty("contrastAgainst");
    expect(themes[0].settings[0].contrastAgainst).toEqual(["#ffffff", "#f1f2f2"]);
  });

  test("a dark version of a changed accent comes along, for any theme with one", async () => {
    const { page, owner } = await siteWith({
      ...only("{% seo %}"),
      "theme.json": { name: "Own", settings },
    });
    const design = await (await owner.get("/api/admin/design")).json();
    await owner.put("/api/admin/design", {
      ...design.value,
      theme: { ...design.value.theme, accent: "#7a1f4a" },
    });
    expect(await page()).toMatch(
      /:root \{ --tend-accent: #7a1f4a; \} @media \(prefers-color-scheme: dark\) \{ :root \{ --tend-accent: #[0-9a-f]{6}; \} \}/,
    );
  });
});

describe("every theme gets", () => {
  test("gentle moves between pages, and pages fetched as their links are pointed at", async () => {
    const { page } = await siteWith(only("{% seo %}"));
    const html = await page();
    expect(html).toContain("@view-transition { navigation: auto; }");
    expect(html).toContain("prefers-reduced-motion: no-preference");
    const rules = html.match(/<script type="speculationrules">([^<]*)<\/script>/)?.[1];
    expect(JSON.parse(rules ?? "")).toMatchObject({ prefetch: [{ eagerness: "moderate" }] });
    expect(rules).toContain("/admin/*");
  });

  test("but not in a preview, where nothing's to be fetched", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const { value } = await (await owner.get("/api/admin/design")).json();
    const { html } = await (await owner.post("/api/admin/design/preview", value)).json();
    expect(html).not.toContain("speculationrules");
  });
});

describe("the versions of Tend a theme is made for", () => {
  test.each([
    [">=0.1 <2", "0.1.0", true],
    [">=0.1 <2", "1.99.9", true],
    [">=0.1 <2", "2.0.0", false],
    [">= 0.2", "0.1.9", false],
    ["0.1.3", "0.1.3", true],
    ["=0.1.3", "0.1.4", false],
    [">0.1 <=0.3.1", "0.3.1", true],
    ["<1", "1.0.0", false],
    [undefined, "9.9.9", true],
    // Run from its own source, Tend isn't any version yet.
    [">=5", "0.0.0", true],
  ])("%s and Tend %s", (range, version, fits) => {
    expect(madeFor(range, version) === null).toBe(fits);
  });

  test.each(["", "next", "^1", ">=1 || <3", 7, ["1"]])(
    "%j isn't a range, and that's said",
    (range) => {
      expect(madeFor(range, "1.0.0")).toContain('"tend" should say');
    },
  );

  test("a theme for another Tend still draws the site, and Design says what's odd", async () => {
    const { page, owner } = await siteWith(
      { ...only("Mine"), "theme.json": { name: "Own", tend: ">=3" } },
      { version: "1.2.3" },
    );
    expect(await page()).toBe("Mine");
    const { themes } = await (await owner.get("/api/admin/design")).json();
    expect(themes[1]).toMatchObject({
      usable: true,
      problem: "It's made for Tend >=3, and this is Tend 1.2.3.",
    });
  });
});

describe("opening hours in the footer", () => {
  const names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
  const week = (...hours: (string | null)[]) =>
    DAYS.map((day, index) => {
      const [opens = "09:00", closes = "17:00"] = (hours[index] ?? "").split("-");
      return { day, closed: hours[index] === null, opens, closes };
    });
  const summary = (...hours: (string | null)[]) =>
    hoursSummary(
      week(...hours),
      (index) => names[index] as string,
      (time) => time,
    ).map((line) =>
      line.closed ? `${line.days} closed` : `${line.days} ${line.opens}-${line.closes}`,
    );

  test("take as few lines as they can", () => {
    const usual = "09:00-17:00";
    expect(summary(usual, usual, usual, usual, usual, "10:00-14:00", null)).toEqual([
      "Mon – Fri 09:00-17:00",
      "Sat 10:00-14:00",
      "Sun closed",
    ]);
    expect(summary(usual, usual, usual, usual, usual, usual, usual)).toEqual([
      "Mon – Sun 09:00-17:00",
    ]);
    expect(summary(null, usual, null, usual, usual, null, null)).toEqual([
      "Mon closed",
      "Tue 09:00-17:00",
      "Wed closed",
      "Thu – Fri 09:00-17:00",
      "Sat – Sun closed",
    ]);
  });

  test("are on every page, with a map link", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    await owner.put("/api/admin/settings/business", {
      address: "12 Flour St",
      phone: null,
      email: null,
      mapUrl: "https://maps.example.com/rise",
      hours: week(
        "09:00-17:00",
        "09:00-17:00",
        "09:00-17:00",
        "09:00-17:00",
        "09:00-17:00",
        null,
        null,
      ),
      hoursNote: "Closed on holidays",
    });
    const html = await (await made.app.request("/contact")).text();
    const footer = html.slice(html.indexOf("<footer"));
    expect(footer).toContain('<a href="https://maps.example.com/rise">Get directions</a>');
    expect(footer).toMatch(/Monday – Friday: 9:00\s*AM–5:00\s*PM/);
    expect(footer).toContain("Saturday – Sunday: Closed");
    expect(footer).toContain("Closed on holidays");
  });
});

describe("a Business site's homepage", () => {
  test("starts with a Big intro, with the site's name in it", async () => {
    const made = await makeApp();
    await setUp(made, {
      site: { name: 'Rise "& Shine" {site}', tagline: "", locale: "en", timezone: "UTC" },
    });
    const html = await (await made.app.request("/")).text();
    expect(html).toContain('<section class="t-intro t-tone-none t-align-left" data-preset="2">');
    expect(html).toContain("<h2>Welcome to Rise &quot;&amp; Shine&quot; {site}</h2>");
    expect(html).toContain('<a class="t-button" href="/contact">Get in touch</a>');
  });
});
