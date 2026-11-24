import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { defaultThemeDir } from "../src/paths.ts";
import type { AppOptions } from "../src/server.ts";
import { copyTheme } from "../src/theme-copy.ts";
import { type MadeApp, makeApp, setUp } from "./auth-helpers.ts";
import { exitedWithin, runCli, tempDir } from "./helpers.ts";

// Themes of people's own (PLAN.md §10): found in their folders, chosen in Design, and never
// able to take the site down.

afterEach(() => {
  vi.restoreAllMocks();
});

/** A folder of themes holding a copy of Meadow called my-theme, which says so in its footer. */
function folderWithMyTheme(): { folder: string; dir: string } {
  const folder = tempDir();
  const { dir } = copyTheme({
    from: "meadow",
    to: "my-theme",
    bundledDir: defaultThemeDir,
    folders: [folder],
  });
  edit(join(dir, "partials", "footer.liquid"), "<footer", "<p>Drawn with my theme</p><footer");
  return { folder, dir };
}

function edit(file: string, from: string, to: string): void {
  const before = readFileSync(file, "utf8");
  expect(before).toContain(from);
  writeFileSync(file, before.replace(from, to));
}

/** A site that uses my-theme. */
async function siteWithMyTheme(overrides: Partial<AppOptions> = {}) {
  const { folder, dir } = folderWithMyTheme();
  const made = await makeApp({ themeFolders: [folder], ...overrides });
  const owner = await setUp(made);
  const design = await (await owner.get("/api/admin/design")).json();
  const saved = await owner.put("/api/admin/design", { ...design.value, themeId: "my-theme" });
  expect(saved.status).toBe(200);
  return { made, owner, folder, dir, saved: await saved.json() };
}

type Owner = Awaited<ReturnType<typeof setUp>>;

async function designOf(owner: Owner) {
  return (await owner.get("/api/admin/design")).json();
}

async function html(made: MadeApp, address = "http://rise.example.com/"): Promise<string> {
  return (await made.app.request(address)).text();
}

describe("a theme of someone's own", () => {
  test("is offered in Design, and draws the site once it's chosen", async () => {
    const { folder } = folderWithMyTheme();
    const made = await makeApp({ themeFolders: [folder] });
    const owner = await setUp(made);
    const design = await designOf(owner);
    expect(design.value.themeId).toBeNull();
    expect(design.missing).toBeNull();
    expect(
      design.themes.map(({ id, name, usable, problem }: Record<string, unknown>) => [
        id,
        name,
        usable,
        problem,
      ]),
    ).toEqual([
      [null, "Meadow", true, null],
      ["my-theme", "My theme", true, null],
    ]);
    expect(await html(made)).not.toContain("Drawn with my theme");

    await owner.put("/api/admin/design", { ...design.value, themeId: "my-theme" });
    const home = await html(made);
    expect(home).toContain("Drawn with my theme");
    const css = home.match(/\/assets\/my-theme\/[0-9a-f]+\/theme\.css/)?.[0] as string;
    const file = await made.app.request(css);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(file.headers.get("cache-control")).toContain("immutable");
    // Undo goes back to Meadow with the rest of the design.
    const { undoId } = await designOf(owner);
    await owner.post("/api/admin/design/undo", { undoId });
    expect(await html(made)).not.toContain("Drawn with my theme");
  });

  test("needs only what it changes: the rest comes from the theme Tend has", async () => {
    const folder = tempDir();
    const dir = join(folder, "small");
    mkdirSync(join(dir, "partials"), { recursive: true });
    writeFileSync(join(dir, "theme.json"), JSON.stringify({ name: "Small" }));
    writeFileSync(join(dir, "partials", "footer.liquid"), "<footer>Only a footer</footer>");
    const made = await makeApp({ themeFolders: [folder] });
    const owner = await setUp(made);
    const { value } = await designOf(owner);
    await owner.put("/api/admin/design", { ...value, themeId: "small" });
    const home = await html(made);
    expect(home).toContain("<footer>Only a footer</footer>");
    expect(home).toContain('class="t-header"');
    // Meadow's own stylesheet, at Meadow's own address.
    expect(home).toMatch(/\/assets\/meadow\/[0-9a-f]+\/theme\.css/);
  });

  test("keeps its own choices while another theme is used", async () => {
    const { folder, dir } = folderWithMyTheme();
    const theme = JSON.parse(readFileSync(join(dir, "theme.json"), "utf8"));
    theme.settings.push({
      id: "mood",
      type: "select",
      label: "Mood",
      default: "calm",
      options: [
        { value: "calm", label: "Calm" },
        { value: "bold", label: "Bold" },
      ],
    });
    writeFileSync(join(dir, "theme.json"), JSON.stringify(theme));
    const made = await makeApp({ themeFolders: [folder] });
    const owner = await setUp(made);
    const { value, themes } = await designOf(owner);
    expect(themes[1].settings.map((setting: { id: string }) => setting.id)).toContain("mood");

    const choose = async (themeId: string | null, choices: Record<string, string>) => {
      const current = (await designOf(owner)).value;
      const reply = await owner.put("/api/admin/design", {
        ...current,
        themeId,
        theme: { ...current.theme, ...choices },
      });
      return (await reply.json()).value.theme;
    };
    expect(await choose("my-theme", { mood: "bold" })).toMatchObject({ mood: "bold" });
    await choose(null, { accent: "#1d4ed8" });
    // Back to it: what was chosen for it is still there, and what both offer is shared.
    expect(await choose("my-theme", {})).toMatchObject({ mood: "bold", accent: "#1d4ed8" });
    expect(value.theme).not.toHaveProperty("mood");
  });

  test("that isn't there can't be chosen, and one that's gone leaves the site with Meadow", async () => {
    const { made, owner, folder, dir, saved } = await siteWithMyTheme();
    const refused = await owner.put("/api/admin/design", { ...saved.value, themeId: "nothing" });
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toMatchObject({ code: "theme_gone", field: "themeId" });

    renameSync(dir, join(tempDir(), "elsewhere"));
    expect(await html(made)).toContain('class="t-header"');
    expect(await html(made)).not.toContain("Drawn with my theme");
    const design = await designOf(owner);
    expect(design.missing).toBe("my-theme");
    expect(design.themes).toHaveLength(1);

    // The rest of the design can still be changed, and the theme comes back with its folder.
    const changed = await owner.put("/api/admin/design", { ...design.value, footerText: "Hi" });
    expect(changed.status).toBe(200);
    expect((await changed.json()).value.themeId).toBe("my-theme");
    copyTheme({ from: "meadow", to: "my-theme", bundledDir: defaultThemeDir, folders: [folder] });
    expect(await html(made)).toContain("/assets/my-theme/");
  });

  test("has to have a name that can be in an address, and not Meadow's", async () => {
    const folder = tempDir();
    for (const name of ["My Theme", "meadow", "UPPER"]) {
      mkdirSync(join(folder, name));
      writeFileSync(join(folder, name, "theme.json"), "{}");
    }
    mkdirSync(join(folder, "notes"));
    writeFileSync(join(folder, "README.md"), "Not a theme");
    const owner = await setUp(await makeApp({ themeFolders: [folder, join(folder, "missing")] }));
    const { themes } = await designOf(owner);
    expect(themes.map(({ id, usable }: Record<string, unknown>) => [id, usable])).toEqual([
      [null, true],
      ["My Theme", false],
      ["UPPER", false],
      ["meadow", false],
    ]);
    expect(themes[1].problem).toContain("lowercase letters, digits and dashes");
    expect(themes[3].problem).toContain("Meadow is the theme Tend comes with");
  });

  test("in two folders is the one in the first", async () => {
    const { folder: first, dir } = folderWithMyTheme();
    const second = tempDir();
    cpSync(dir, join(second, "my-theme"), { recursive: true });
    edit(join(second, "my-theme", "partials", "footer.liquid"), "Drawn with", "Drawn second with");
    const made = await makeApp({ themeFolders: [first, second] });
    const owner = await setUp(made);
    const { value, themes } = await designOf(owner);
    expect(themes).toHaveLength(2);
    await owner.put("/api/admin/design", { ...value, themeId: "my-theme" });
    expect(await html(made)).toContain("Drawn with my theme");
  });

  test("shows a change to its files straight away, once it's the one the site uses", async () => {
    const { made, dir } = await siteWithMyTheme({
      pageCacheBytes: 1_000_000,
      watchTheme: true,
    });
    expect(await html(made)).toContain("Drawn with my theme");
    edit(join(dir, "partials", "footer.liquid"), "Drawn with", "Redrawn with");
    await vi.waitFor(async () => expect(await html(made)).toContain("Redrawn with my theme"), {
      timeout: 5000,
      interval: 50,
    });
  });
});

describe("a mistake in a theme of someone's own", () => {
  test("gives visitors the page with Meadow, and says what's wrong in Design", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { made, owner, dir } = await siteWithMyTheme();
    const template = join(dir, "templates", "home.liquid");
    const before = readFileSync(template, "utf8");
    writeFileSync(template, `${before}\n{{ page.title | nonsense }}`);

    const reply = await made.app.request("http://rise.example.com/");
    expect(reply.status).toBe(200);
    const page = await reply.text();
    expect(page).toContain('class="t-header"');
    expect(page).not.toContain("Drawn with my theme");
    // The rest of the site is still drawn with it.
    expect(await html(made, "http://rise.example.com/blog")).toContain("Drawn with my theme");

    const [, mine] = (await designOf(owner)).themes;
    expect(mine.problem).toMatch(/undefined filter: nonsense.*home\.liquid.*line/);
    expect(mine.problem).not.toContain(dir);
    expect(mine.usable).toBe(true);
    // Said once in the log, not once for each visitor.
    await made.app.request("http://rise.example.com/");
    expect(errors).toHaveBeenCalledTimes(1);
    expect(errors.mock.calls[0]?.[0]).toContain("The theme my-theme has a mistake in it");

    writeFileSync(template, before);
    expect(await html(made)).toContain("Drawn with my theme");
    expect((await designOf(owner)).themes[1].problem).toBeNull();
  });

  test("is shown to whoever is making it on their own computer, and to nobody else", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { made, dir } = await siteWithMyTheme({ showThemeMistakes: true });
    writeFileSync(join(dir, "templates", "home.liquid"), "{% render 'not-there' %} <b>");
    const here = await made.app.request("http://localhost:3000/");
    expect(here.status).toBe(500);
    const told = await here.text();
    expect(told).toContain("Your theme has a mistake in it");
    expect(told).toContain("not-there");
    expect(told).not.toContain("<b>");
    expect((await made.app.request("http://rise.example.com/")).status).toBe(200);
  });

  test("is said when a design that uses it is previewed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { folder, dir } = folderWithMyTheme();
    writeFileSync(join(dir, "templates", "home.liquid"), "{{ 1 | nonsense }}");
    const owner = await setUp(await makeApp({ themeFolders: [folder] }));
    const { value } = await designOf(owner);
    const preview = (themeId: string | null) =>
      owner.post("/api/admin/design/preview", { ...value, themeId });
    const refused = await preview("my-theme");
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toMatchObject({
      code: "theme_mistake",
      message: expect.stringContaining("undefined filter: nonsense"),
      fix: expect.stringContaining("visitors see Meadow"),
    });
    expect((await preview(null)).status).toBe(200);
  });

  test("in theme.json leaves it without design choices, and says so", async () => {
    const { folder, dir } = folderWithMyTheme();
    writeFileSync(join(dir, "theme.json"), "{ not json");
    const owner = await setUp(await makeApp({ themeFolders: [folder] }));
    const [, mine] = (await designOf(owner)).themes;
    expect(mine).toMatchObject({ id: "my-theme", name: "my-theme", settings: [], usable: true });
    expect(mine.problem).toContain("theme.json:");
  });

  test("in Meadow itself isn't hidden", async () => {
    const themeDir = join(tempDir(), "meadow");
    cpSync(defaultThemeDir, themeDir, { recursive: true });
    const made = await makeApp({ themeDir });
    await setUp(made);
    vi.spyOn(console, "error").mockImplementation(() => {});
    writeFileSync(join(themeDir, "templates", "home.liquid"), "{{ 1 | nonsense }}");
    expect((await made.app.request("http://rise.example.com/")).status).toBe(500);
  });
});

describe("tendcms theme copy", () => {
  test("makes a theme that says what it's called, without Meadow's starting points", () => {
    const folder = join(tempDir(), "themes");
    const copied = copyTheme({
      from: "meadow",
      to: "rise-bakery",
      bundledDir: defaultThemeDir,
      folders: [folder],
    });
    expect(copied).toEqual({ from: "Meadow", dir: join(folder, "rise-bakery") });
    expect(readdirSync(copied.dir).sort()).toEqual([
      "assets",
      "locales",
      "partials",
      "templates",
      "theme.json",
    ]);
    const theme = JSON.parse(readFileSync(join(copied.dir, "theme.json"), "utf8"));
    expect(theme).toMatchObject({ name: "Rise bakery", version: "1.0.0" });
    expect(theme.settings.length).toBeGreaterThan(0);
    if (process.platform !== "win32") {
      // An image made with it runs as someone else than whoever copied it.
      expect(statSync(copied.dir).mode & 0o777).toBe(0o755);
      expect(statSync(join(copied.dir, "theme.json")).mode & 0o777).toBe(0o644);
    }
    // And a copy of the copy.
    const second = copyTheme({
      from: "rise-bakery",
      to: "rise-two",
      bundledDir: defaultThemeDir,
      folders: [folder],
    });
    expect(second.from).toBe("Rise bakery");
  });

  test("refuses what it can't do, and says why", () => {
    const { folder } = folderWithMyTheme();
    const copy = (from?: string, to?: string) => () =>
      copyTheme({ from, to, bundledDir: defaultThemeDir, folders: [folder] });
    expect(copy()).toThrow("for example: tendcms theme copy meadow my-theme");
    expect(copy("meadow")).toThrow("Say which theme to copy");
    expect(copy("nothing", "mine")).toThrow(
      "There's no theme called nothing. You have: meadow, my-theme",
    );
    for (const name of ["My Theme", "../out", "a/b", "-x", "", "x".repeat(41)]) {
      expect(copy("meadow", name)).toThrow();
    }
    expect(copy("meadow", "my-theme")).toThrow("There's already a theme called my-theme");
    expect(copy("my-theme", "meadow")).toThrow("There's already a theme called meadow");
    mkdirSync(join(folder, "in-the-way"));
    expect(copy("meadow", "in-the-way")).toThrow("There's already something at");
    expect(readdirSync(folder).sort()).toEqual(["in-the-way", "my-theme"]);
  });

  test("puts it beside the site's data folder, or on the volume in a container", async () => {
    const site = tempDir();
    const beside = runCli(["theme", "copy", "meadow", "mine"], {}, { cwd: site });
    expect(await exitedWithin(beside)).toBe(0);
    expect(beside.output()).toContain("Copied Meadow to");
    expect(beside.output()).toContain("under Design");
    expect(existsSync(join(site, "themes", "mine", "theme.json"))).toBe(true);
    // It's a copy of files, so it makes no site.
    expect(readdirSync(site)).toEqual(["themes"]);

    const dataDir = join(tempDir(), "data");
    const inData = runCli(["theme", "copy", "meadow", "mine"], {
      TEND_PLATFORM: "docker",
      TEND_DATA_DIR: dataDir,
    });
    expect(await exitedWithin(inData)).toBe(0);
    expect(existsSync(join(dataDir, "themes", "mine", "theme.json"))).toBe(true);

    const wrong = runCli(["theme", "new"], {}, { cwd: site });
    expect(await exitedWithin(wrong)).toBe(1);
    expect(wrong.output()).toContain("tendcms theme copy meadow my-theme");
    rmSync(join(site, "themes"), { recursive: true });
  });
});
