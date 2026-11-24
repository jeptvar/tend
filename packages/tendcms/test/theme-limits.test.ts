import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { defaultThemeDir } from "../src/paths.ts";
import { createTheme } from "../src/site/theme.ts";
import { makeApp, setUp } from "./auth-helpers.ts";
import { tempDir } from "./helpers.ts";

// What a theme can't do, whatever is in its files (PLAN.md §10, Safety): take the server's time
// or memory, read files that aren't its own, or run anything.

/** A site drawn with a theme whose homepage is this, and what a visitor gets. */
async function pageOf(home: string, files: Record<string, string> = {}) {
  const folder = tempDir();
  const all = {
    "theme.json": JSON.stringify({ name: "Own" }),
    "templates/home.liquid": home,
    ...files,
  };
  for (const [name, content] of Object.entries(all)) {
    const path = join(folder, "own", name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  // As on the internet, where a visitor never sees the mistake itself.
  const made = await makeApp({ themeFolders: [folder], publicUrl: "https://rise.example.com" });
  const owner = await setUp(made);
  const design = await (await owner.get("/api/admin/design")).json();
  await owner.put("/api/admin/design", { ...design.value, themeId: "own" });
  const started = performance.now();
  const reply = await made.app.request("https://rise.example.com/");
  return { html: await reply.text(), status: reply.status, took: performance.now() - started };
}

/** Meadow's page, which takes its place when a theme's can't be drawn. */
const MEADOW = /<body[^>]*>[\s\S]*Rise Bakery/;

describe("a theme that asks for too much", () => {
  test("is stopped when it takes too long, and visitors get the page with Meadow", async () => {
    const forEver = "{% for a in (1..100000) %}{% for b in (1..100000) %}x{% endfor %}{% endfor %}";
    const { html, status, took } = await pageOf(forEver);
    expect(status).toBe(200);
    expect(html).toMatch(MEADOW);
    expect(took).toBeLessThan(10_000);
  });

  test("is stopped when it takes too much memory", async () => {
    const doubling = `{% assign s = "xxxxxxxxxxxxxxxx" %}{% for i in (1..40) %}{% assign s = s | append: s %}{% endfor %}{{ s }}`;
    const { html, status } = await pageOf(doubling);
    expect(status).toBe(200);
    expect(html).toMatch(MEADOW);
    expect(html.length).toBeLessThan(1_000_000);
  });

  test("is stopped when a template is too big to read", async () => {
    const { html, status } = await pageOf(`${"x".repeat(1_500_000)}{{ site.name }}`);
    expect(status).toBe(200);
    expect(html).toMatch(MEADOW);
  });

  test("is stopped when a partial draws itself", async () => {
    const { html, status } = await pageOf('{% render "again" %}', {
      "partials/again.liquid": 'x{% render "again" %}',
    });
    expect(status).toBe(200);
    expect(html).toMatch(MEADOW);
  });
});

describe("a computer that's busy for a moment", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A theme of someone's own over Meadow, and Meadow. */
  function themes(home: string) {
    const dir = join(tempDir(), "own");
    mkdirSync(join(dir, "templates"), { recursive: true });
    writeFileSync(join(dir, "theme.json"), JSON.stringify({ name: "Own" }));
    writeFileSync(join(dir, "templates", "home.liquid"), home);
    const options = { cache: true, timezone: () => "UTC", locale: () => "en" };
    const meadow = createTheme({ ...options, id: "meadow", dir: defaultThemeDir });
    return { meadow, own: createTheme({ ...options, id: "own", dir, fallback: meadow }) };
  }

  /** The clock goes this far ahead once drawing has begun, as it does while nothing runs. */
  function busyFor(ms: number): void {
    const now = performance.now.bind(performance);
    let looks = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now() + (looks++ > 0 ? ms : 0));
  }

  test("isn't a mistake in the theme: it's drawn again, with more time", async () => {
    const { own } = themes("Mine, {{ site.name }}");
    busyFor(800);
    expect(await own.render("home", { site: { name: "Rise" } })).toBe("Mine, Rise");
  });

  test("doesn't stop the theme Tend comes with, which has nothing to take its place", async () => {
    const { meadow } = themes("");
    busyFor(5000);
    const html = await meadow.render("404", {
      site: { name: "Rise", locale: "en" },
      design: {},
      menus: { main: [], footer: [] },
      request: { path: "/x" },
      tend: {},
    });
    expect(html).toContain("Page not found");
  });

  test("is told from a theme that's always slow, which gets one second try, not one a page", async () => {
    const { own } = themes(
      "{% for a in (1..100000) %}{% for b in (1..100000) %}x{% endfor %}{% endfor %}",
    );
    const timed = async () => {
      const began = performance.now();
      await expect(own.render("home", {})).rejects.toThrow("render limit exceeded");
      return performance.now() - began;
    };
    expect(await timed()).toBeGreaterThan(2000);
    expect(await timed()).toBeLessThan(2000);
    // Until its files change.
    own.reload();
    expect(await timed()).toBeGreaterThan(2000);
  });
});

describe("a theme that reaches for what isn't its own", () => {
  test.each([
    ["up out of its folder", '{% render "../../outside" %}'],
    ["further up", '{% render "../../../outside" %}'],
    ["up out of its folder, with a variable", '{% assign p = "../../outside" %}{% render p %}'],
    ["beside it, by a folder with the same start", '{% render "../partials/../../outside" %}'],
    ["as a layout", '{% layout "../../outside" %}'],
    ["as an include", '{% include "../../outside" %}'],
    ["with its ending", '{% render "../../outside.liquid" %}'],
    ["by a full path", '{% render "/etc/passwd" %}'],
  ])("can't read a file %s", async (_how, home) => {
    const { html } = await pageOf(home, { "../outside.liquid": "SECRET" });
    expect(html).not.toContain("SECRET");
    expect(html).not.toContain("root:x:0:0");
    expect(html).toMatch(MEADOW);
  });

  test("can read its own", async () => {
    const { html } = await pageOf('{% render "inside" %}', { "partials/inside.liquid": "Mine" });
    expect(html).toBe("Mine");
  });

  test("can't reach what JavaScript gives every value", async () => {
    const { html } = await pageOf(
      "[{{ site.constructor }}{{ site.__proto__ }}{{ site.name.constructor.constructor }}" +
        "{{ posts.map }}{{ site.toString }}]",
    );
    expect(html).toBe("[]");
  });

  test("writes what it's given as text, not as a page's own code", async () => {
    const folder = tempDir();
    const dir = join(folder, "own");
    mkdirSync(join(dir, "templates"), { recursive: true });
    writeFileSync(join(dir, "theme.json"), JSON.stringify({ name: "Own" }));
    writeFileSync(join(dir, "templates", "home.liquid"), "<p>{{ site.name }}</p>");
    const made = await makeApp({ themeFolders: [folder] });
    const owner = await setUp(made, {
      site: { name: "<script>alert(1)</script>", tagline: "", locale: "en", timezone: "UTC" },
    });
    const design = await (await owner.get("/api/admin/design")).json();
    await owner.put("/api/admin/design", { ...design.value, themeId: "own" });
    const html = await (await made.app.request("http://rise.example.com/")).text();
    expect(html).toBe("<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
  });

  test("isn't drawn at all with a filter nobody knows", async () => {
    const { html } = await pageOf('{{ "x" | shell: "rm -rf /" }}');
    expect(html).toMatch(MEADOW);
  });
});
