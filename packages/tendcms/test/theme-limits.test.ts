import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
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
