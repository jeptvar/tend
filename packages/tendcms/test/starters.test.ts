import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { loadStarter } from "../src/content/starters.ts";
import { media, users } from "../src/db/schema.ts";
import { processImage } from "../src/media/process.ts";
import { MediaStore } from "../src/media/store.ts";
import { defaultThemeDir } from "../src/paths.ts";
import { makeApp, setUp } from "./auth-helpers.ts";
import { tempDir } from "./helpers.ts";

// The starting points, as setup makes a site from them: pages that look finished, with pictures
// anyone can keep, because they were drawn for Tend (scripts/pictures).

const STARTERS = join(defaultThemeDir, "starters");
const PICTURES = join(STARTERS, "pictures");

afterEach(() => {
  vi.restoreAllMocks();
});

async function html(made: Awaited<ReturnType<typeof makeApp>>, path: string): Promise<string> {
  const reply = await made.app.request(`http://rise.example.com${path}`);
  expect(reply.status, path).toBe(200);
  return reply.text();
}

/** Every file in a folder and the folders in it, by name. */
function filesIn(folder: string): string[] {
  if (!existsSync(folder)) return [];
  return readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
}

describe("the pictures starting points come with", () => {
  test("are the size and colour they're said to be, described, and small to send", async () => {
    const said = new Map<string, { alt: string; width: number; height: number; color: string }>();
    for (const name of ["blog", "business", "blank"]) {
      const { pictures = {} } = JSON.parse(readFileSync(join(STARTERS, `${name}.json`), "utf8"));
      for (const { file, ...rest } of Object.values<{ file: string }>(pictures)) {
        said.set(file, rest as never);
      }
    }
    // Every one is used, and every one that's used is there.
    expect([...said.keys()].sort()).toEqual(readdirSync(PICTURES).sort());
    for (const [file, { alt, ...facts }] of said) {
      const made = await processImage(readFileSync(join(PICTURES, file)), "jpeg");
      expect(facts, file).toEqual({
        width: made.width,
        height: made.height,
        color: made.dominantColor,
      });
      expect(alt.length, file).toBeGreaterThan(10);
      // What a phone gets of it is far below the plan's 150 KB (PLAN.md §11).
      for (const variant of made.variants.filter(({ width }) => width <= 960)) {
        expect(variant.data.length, `${file} at ${variant.width}`).toBeLessThan(60_000);
      }
    }
  });
});

describe("a site set up from a starting point", () => {
  test("Business opens with a photo, and has its pictures in Media, ready to be replaced", async () => {
    const made = await makeApp();
    const owner = await setUp(made, { starter: "business" });
    const home = await html(made, "/");
    expect(home.match(/<figure class="t-image/g)).toHaveLength(3);
    expect(home).toContain('<figure class="t-image t-size-full">');
    expect(home).not.toContain("{picture");
    expect(home).toContain("Welcome to Rise Bakery");

    const { media: list } = await (await owner.get("/api/admin/media")).json();
    expect(list).toHaveLength(3);
    for (const item of list) {
      expect(item.alt.length).toBeGreaterThan(10);
      const { uses } = await (await owner.get(`/api/admin/media/${item.id}/usage`)).json();
      expect(uses.map((use: { title: string }) => use.title)).toEqual(["Rise Bakery"]);
    }
    // Only their originals are kept at first. A size is made when it's asked for.
    expect(filesIn(join(made.uploadsDir, "originals"))).toHaveLength(3);
    expect(filesIn(join(made.uploadsDir, "variants"))).toEqual([]);
    const address = home.match(/\/media\/[^ "]+\/960\.webp/)?.[0] as string;
    const size = await made.app.request(`http://rise.example.com${address}`);
    expect(size.status).toBe(200);
    expect(size.headers.get("content-type")).toBe("image/webp");
    expect(filesIn(join(made.uploadsDir, "variants"))).toEqual(["960.webp"]);
  });

  test("Blog has a picture with its first post, and Blank has nothing at all", async () => {
    const blog = await makeApp();
    await setUp(blog, { starter: "blog" });
    expect(await html(blog, "/")).toContain('class="t-img-card"');
    expect(await html(blog, "/blog/welcome")).toContain('class="t-img-cover"');
    expect(await html(blog, "/blog/welcome")).toContain('alt="A cup of coffee beside two buns"');

    const blank = await makeApp();
    await setUp(blank, { starter: "blank" });
    expect(await html(blank, "/")).not.toContain("<img");
    expect(blank.orm.select().from(media).all()).toEqual([]);
  });

  test("has the same pages without pictures when they can't be kept", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    // A file where the uploads folder should be, as good as a disk that can't be written to.
    const blocked = join(tempDir(), "uploads");
    writeFileSync(blocked, "not a folder");
    for (const starter of ["business", "blog"]) {
      const made = await makeApp({ uploadsDir: blocked });
      await setUp(made, { starter });
      const home = await html(made, "/");
      expect(home).not.toContain("<img");
      expect(home).not.toContain("{picture");
      expect(home).toContain("Welcome to Rise Bakery");
      if (starter === "business") {
        // Every section is still there, and still says what it said.
        expect(home.match(/<section /g)).toHaveLength(4);
        expect(home).toContain("How it began");
      }
      expect(made.orm.select().from(media).all()).toEqual([]);
    }
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining("pictures couldn't be kept"),
      expect.anything(),
    );
  });

  test("is set up even when the ones that were kept can't be removed again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // A disk that fills up on the second one, in a folder where nothing can be removed.
    vi.spyOn(MediaStore.prototype, "write")
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
      });
    vi.spyOn(MediaStore.prototype, "removeOriginal").mockImplementation(() => {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    });
    const made = await makeApp();
    await setUp(made, { starter: "business" });
    expect(await html(made, "/")).toContain("Welcome to Rise Bakery");
    expect(made.orm.select().from(media).all()).toEqual([]);
  });

  test("leaves no files behind when someone else finished setup first", async () => {
    const made = await makeApp();
    await setUp(made, { starter: "business" });
    const kept = filesIn(made.uploadsDir).sort();
    // Back to before there was an Owner, as it looks to someone who started at the same moment.
    made.db.exec("CREATE TRIGGER first BEFORE INSERT ON users BEGIN SELECT RAISE(ABORT, 'x'); END");
    made.db.exec("UPDATE users SET is_owner = 0");
    const late = await made.app.request("/api/auth/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: made.code,
        site: { name: "Rise", tagline: "", locale: "en", timezone: "UTC" },
        owner: { name: "Late", email: "late@example.com", password: "another-good-long-phrase" },
        starter: "business",
      }),
    });
    expect(late.status).toBe(500);
    expect(made.orm.select().from(users).all()).toHaveLength(1);
    expect(filesIn(made.uploadsDir).sort()).toEqual(kept);
  });

  test("gives each site pictures of its own, so two sites never share an address", () => {
    const start = { themeDir: defaultThemeDir, siteName: "Rise", now: 1, pictures: true };
    const [one, two] = [0, 1].map(() => loadStarter({ ...start, starter: "business" }));
    const ids = [one, two].flatMap((each) => each?.pictures.map(({ id }) => id));
    expect(new Set(ids).size).toBe(6);
  });
});
