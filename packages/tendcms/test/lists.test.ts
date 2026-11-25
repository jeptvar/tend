import sharp from "sharp";
import { describe, expect, test } from "vitest";
import { makeApp, setUp, signedInAs } from "./auth-helpers.ts";

// What the lists of posts and pages show of each besides its title: a picture and a few words.

type Client = Awaited<ReturnType<typeof setUp>>;

const text = (value: string, ...marks: string[]) => ({
  type: "text",
  text: value,
  ...(marks.length > 0 ? { marks: marks.map((type) => ({ type })) } : {}),
});
const paragraph = (...content: unknown[]) => ({ type: "paragraph", content });
const picture = (mediaId: string) => ({ type: "image", attrs: { mediaId } });

async function upload(owner: Client, name: string): Promise<string> {
  const data = await sharp({
    create: { width: 1200, height: 800, channels: 3, background: "#884422" },
  })
    .png()
    .toBuffer();
  return (await (await owner.upload("/api/admin/media", data, name)).json()).id;
}

async function post(owner: Client, fields: object): Promise<string> {
  const made = await (await owner.post("/api/admin/entries", { type: "post" })).json();
  const saved = await owner.patch(`/api/admin/entries/${made.id}`, fields, {
    "If-Match": String(made.rev),
  });
  expect(saved.status).toBe(200);
  return made.id;
}

async function listed(owner: Client, id: string) {
  const { entries } = await (await owner.get("/api/admin/entries?type=post")).json();
  return entries.find((entry: { id: string }) => entry.id === id);
}

describe("a row in a list", () => {
  test("has the first words, however they're put, and not a heading's or a button's", async () => {
    const made = await makeApp();
    const owner = await setUp(made, { starter: "blank" });
    const id = await post(owner, {
      title: "A new oven",
      doc: {
        type: "doc",
        content: [
          { type: "heading", attrs: { level: 2 }, content: [text("Heading")] },
          { type: "button", attrs: { href: "/x", label: "Button" } },
          paragraph(text("   ")),
          paragraph(text("After thirty years, the "), text("old oven", "bold"), text(" rests.")),
          paragraph(text("Second.")),
        ],
      },
    });
    expect((await listed(owner, id)).words).toBe("After thirty years, the old oven rests.");
  });

  test("has the summary instead, if there's one, and is cut at a word when it's long", async () => {
    const made = await makeApp();
    const owner = await setUp(made, { starter: "blank" });
    const chosen = await post(owner, {
      title: "Chosen",
      summary: "It arrives on Thursday.",
      doc: { type: "doc", content: [paragraph(text("Something else."))] },
    });
    expect((await listed(owner, chosen)).words).toBe("It arrives on Thursday.");
    const long = await post(owner, {
      title: "Long",
      doc: { type: "doc", content: [paragraph(text("bread ".repeat(200)))] },
    });
    const { words } = await listed(owner, long);
    expect(words.length).toBeLessThanOrEqual(161);
    expect(words).toMatch(/bread…$/);
    const empty = await post(owner, { title: "Empty" });
    expect(await listed(owner, empty)).toMatchObject({ words: "", thumbUrl: null });
  });

  test("has the picture chosen for it, or else the first in its text, wherever that is", async () => {
    const made = await makeApp();
    const owner = await setUp(made, { starter: "blank" });
    const first = await upload(owner, "first.png");
    const second = await upload(owner, "second.png");
    const inText = await post(owner, {
      title: "In the text",
      doc: {
        type: "doc",
        content: [
          paragraph(text("Words.")),
          { type: "blockquote", content: [paragraph(text("Quote."))] },
          picture(first),
          picture(second),
        ],
      },
    });
    expect((await listed(owner, inText)).thumbUrl).toMatch(
      new RegExp(`^/media/${first}/.+/480\\.webp$`),
    );
    const chosen = await post(owner, {
      title: "Chosen",
      featuredImage: { mediaId: second, alt: null },
      doc: { type: "doc", content: [picture(first)] },
    });
    expect((await listed(owner, chosen)).thumbUrl).toContain(second);
    // One in the Trash isn't shown, as on the site.
    await owner.post(`/api/admin/media/${second}/trash`, {});
    expect((await listed(owner, chosen)).thumbUrl).toBeNull();
  });

  test("is the same on Overview, and a homepage's picture is the one it opens with", async () => {
    const made = await makeApp();
    const owner = await setUp(made, { starter: "business" });
    const { entries } = await (await owner.get("/api/admin/entries?type=page")).json();
    const home = entries.find((entry: { isHome: boolean }) => entry.isHome);
    expect(home.words).toBe(
      "This is your homepage. Tell visitors what you do and why they'll be glad they came.",
    );
    expect(home.thumbUrl).toMatch(/\/480\.webp$/);
    await post(owner, {
      title: "Draft",
      doc: { type: "doc", content: [paragraph(text("Not yet."))] },
    });
    const overview = await (await owner.get("/api/admin/overview")).json();
    expect(overview.drafts.entries[0]).toMatchObject({ title: "Draft", words: "Not yet." });
  });

  test("says nothing of posts that aren't a Writer's own", async () => {
    const made = await makeApp();
    const owner = await setUp(made, { starter: "blank" });
    await post(owner, {
      title: "The owner's",
      doc: { type: "doc", content: [paragraph(text("Private for now."))] },
    });
    const { client: writer } = await signedInAs(made, "writer");
    const list = await (await writer.get("/api/admin/entries?type=post")).json();
    expect(list.entries).toEqual([]);
    expect(JSON.stringify(list)).not.toContain("Private for now.");
  });
});
