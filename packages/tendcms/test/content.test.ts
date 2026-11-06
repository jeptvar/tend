import { describe, expect, test } from "vitest";
import { entryPath, isReservedPageAddress, slugify } from "../src/content/address.ts";
import { type Doc, docSchema, textToDoc } from "../src/content/doc.ts";
import { renderDoc, summarize } from "../src/content/render-doc.ts";
import { browser, type MadeApp, makeApp, setUp } from "./auth-helpers.ts";

const ENTRIES = "/api/admin/entries";

function paragraph(text: string): Doc {
  return { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] };
}

describe("textToDoc", () => {
  test("blank lines make paragraphs, and single line breaks stay line breaks", () => {
    expect(textToDoc("One\nstill one\n\nTwo")).toEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "One" },
            { type: "hardBreak" },
            { type: "text", text: "still one" },
          ],
        },
        { type: "paragraph", content: [{ type: "text", text: "Two" }] },
      ],
    });
  });

  test("handles Windows line endings, extra blank lines and empty text", () => {
    expect(textToDoc("A\r\n\r\n\r\nB").content).toHaveLength(2);
    expect(textToDoc("  \n\n  ").content).toEqual([]);
    expect(textToDoc("").content).toEqual([]);
  });
});

describe("renderDoc", () => {
  test.each([
    ["a script tag", "<script>alert(1)</script>", "&lt;script&gt;alert(1)&lt;/script&gt;"],
    [
      "an image with an event",
      '<img src=x onerror="alert(1)">',
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;",
    ],
    [
      "a javascript link",
      '<a href="javascript:alert(1)">x</a>',
      "&lt;a href=&quot;javascript:alert(1)&quot;&gt;x&lt;/a&gt;",
    ],
    ["quotes", `it's "quoted"`, "it&#39;s &quot;quoted&quot;"],
    ["an ampersand", "bread & butter", "bread &amp; butter"],
  ])("escapes %s", (_, input, expected) => {
    expect(renderDoc(paragraph(input)).html).toBe(`<p>${expected}</p>`);
  });

  test("drops node types it doesn't know, even if they reach the database", () => {
    const hostile = {
      type: "doc",
      content: [
        { type: "rawHtml", html: "<script>alert(1)</script>" },
        {
          type: "paragraph",
          content: [
            { type: "evil", text: "<b>x</b>" },
            { type: "text", text: "ok" },
          ],
        },
      ],
    } as unknown as Doc;
    expect(renderDoc(hostile).html).toBe("<p>ok</p>");
  });

  test("gives plain text for summaries, and skips empty paragraphs", () => {
    const { html, text } = renderDoc(textToDoc("One\nTwo\n\nThree"));
    expect(html).toBe("<p>One<br>Two</p>\n<p>Three</p>");
    expect(text).toBe("One\nTwo\n\nThree");
    expect(renderDoc({ type: "doc", content: [{ type: "paragraph" }] }).html).toBe("");
  });
});

describe("summarize", () => {
  test("uses the first paragraph", () => {
    expect(summarize("First one.\n\nSecond one.")).toBe("First one.");
  });

  test("cuts long text at a word, and counts characters rather than bytes", () => {
    const summary = summarize(`${"word ".repeat(60)}end`);
    expect(summary.endsWith("word…")).toBe(true);
    expect([...summary].length).toBeLessThanOrEqual(161);
    expect(summarize("🌱".repeat(200))).toHaveLength(321);
  });
});

describe("docSchema", () => {
  test.each([
    ["an unknown block", { type: "doc", content: [{ type: "script" }] }],
    [
      "an unknown inline node",
      { type: "doc", content: [{ type: "paragraph", content: [{ type: "html" }] }] },
    ],
    ["an extra property", { type: "doc", content: [{ type: "paragraph", onclick: "x" }] }],
    [
      "an empty text node",
      { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "" }] }] },
    ],
    ["the wrong root", { type: "paragraph" }],
  ])("refuses %s", (_, doc) => {
    expect(docSchema.safeParse(doc).success).toBe(false);
  });
});

describe("addresses", () => {
  test.each([
    ["About Us", "about-us"],
    ["  Café  Crème! ", "cafe-creme"],
    ["a---b___c", "a-b-c"],
    ["../../etc/passwd", "etc-passwd"],
    ["日本語", ""],
    ["%2e%2e", "2e-2e"],
  ])("%j becomes %j", (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  test("are cut to a sensible length, never ending in a hyphen", () => {
    const slug = slugify(`${"a".repeat(99)} b c`);
    expect(slug.length).toBeLessThanOrEqual(100);
    expect(slug.endsWith("-")).toBe(false);
  });

  test("Tend's own addresses are reserved for pages", () => {
    for (const slug of ["admin", "api", "blog", "assets", "healthz"]) {
      expect(isReservedPageAddress(slug)).toBe(true);
    }
    expect(isReservedPageAddress("about")).toBe(false);
  });

  test("each kind of content has its own path", () => {
    expect(entryPath({ type: "post", isHome: 0, slug: "a" })).toBe("/blog/a");
    expect(entryPath({ type: "page", isHome: 0, slug: "a" })).toBe("/a");
    expect(entryPath({ type: "page", isHome: 1, slug: "home" })).toBe("/");
  });
});

describe("the entries API", () => {
  type Client = Awaited<ReturnType<typeof setUp>>;

  async function signedIn(): Promise<{ made: MadeApp; owner: Client }> {
    const made = await makeApp();
    const owner = await setUp(made);
    return { made, owner };
  }

  async function newEntry(owner: Client, type = "post") {
    const reply = await owner.post(ENTRIES, { type });
    expect(reply.status).toBe(201);
    return reply.json();
  }

  function save(owner: Client, id: string, rev: number, body: unknown) {
    return owner.patch(`${ENTRIES}/${id}`, body, { "If-Match": String(rev) });
  }

  function publish(owner: Client, id: string, rev: number) {
    return owner.post(`${ENTRIES}/${id}/publish`, {}, { "If-Match": String(rev) });
  }

  test("creates a draft nobody else can see yet", async () => {
    const { made, owner } = await signedIn();
    const entry = await newEntry(owner);
    expect(entry).toMatchObject({ type: "post", status: "draft", url: null, rev: 1, dirty: false });
    expect((await made.app.request("/blog")).status).toBe(200);
  });

  test("refuses a kind of content it doesn't know", async () => {
    const { owner } = await signedIn();
    expect((await owner.post(ENTRIES, { type: "wiki" })).status).toBe(400);
    expect((await owner.get(`${ENTRIES}?type=wiki`)).status).toBe(400);
  });

  test("saves title, address and text, and every save moves the version on", async () => {
    const { owner } = await signedIn();
    const entry = await newEntry(owner);
    const reply = await save(owner, entry.id, 1, {
      title: "  My post ",
      slug: "My Post!",
      doc: paragraph("Hello"),
    });
    expect(reply.status).toBe(200);
    expect(await reply.json()).toMatchObject({
      title: "My post",
      slug: "my-post",
      rev: 2,
      data: { doc: paragraph("Hello") },
    });
    expect((await save(owner, entry.id, 2, { title: "Again" })).status).toBe(200);
  });

  test("a save keeps the fields it wasn't given", async () => {
    const { owner } = await signedIn();
    const entry = await newEntry(owner);
    await save(owner, entry.id, 1, { title: "T", doc: paragraph("Body"), summary: "Short" });
    const reply = await save(owner, entry.id, 2, { title: "T2" });
    const saved = await reply.json();
    expect(saved.data.doc).toEqual(paragraph("Body"));
    expect(saved.data.summary).toBe("Short");
    expect(saved.data.seo).toEqual({
      title: null,
      description: null,
      imageId: null,
      noindex: false,
    });
  });

  test("refuses content outside the allowlist, and explains without details", async () => {
    const { owner } = await signedIn();
    const entry = await newEntry(owner);
    const reply = await save(owner, entry.id, 1, {
      doc: { type: "doc", content: [{ type: "rawHtml", html: "<script>" }] },
    });
    expect(reply.status).toBe(400);
    const { error } = await reply.json();
    expect(error.field).toBe("doc");
    expect(error.message).toBe("Tend couldn't save that content.");
  });

  test("saving needs to know which version you were editing", async () => {
    const { owner } = await signedIn();
    const entry = await newEntry(owner);
    expect((await owner.patch(`${ENTRIES}/${entry.id}`, { title: "T" })).status).toBe(400);
  });

  test("a stale save overwrites nothing, and the losing version is kept", async () => {
    const { made, owner } = await signedIn();
    const entry = await newEntry(owner);
    await save(owner, entry.id, 1, { title: "Theirs" });

    const reply = await save(owner, entry.id, 1, { title: "Mine", doc: paragraph("My words") });
    expect(reply.status).toBe(409);
    const body = await reply.json();
    expect(body.error.code).toBe("edit_conflict");
    expect(body.current).toMatchObject({ title: "Theirs", rev: 2 });

    const kept = made.db
      .prepare("SELECT title, data FROM revisions WHERE kind = 'conflict'")
      .get() as { title: string; data: string };
    expect(kept.title).toBe("Mine");
    expect(JSON.parse(kept.data).doc).toEqual(paragraph("My words"));

    const current = await (await owner.get(`${ENTRIES}/${entry.id}`)).json();
    expect(current.title).toBe("Theirs");
  });

  test("sending the same words again after a lost answer isn't a conflict", async () => {
    const { made, owner } = await signedIn();
    const entry = await newEntry(owner);
    const body = { title: "Same", doc: paragraph("Same words") };
    expect((await save(owner, entry.id, 1, body)).status).toBe(200);

    // The first answer never arrived, so the browser tries again with the old version.
    const retry = await save(owner, entry.id, 1, body);
    expect(retry.status).toBe(200);
    expect((await retry.json()).rev).toBe(2);
    expect(made.db.prepare("SELECT count(*) AS n FROM revisions").get()).toEqual({ n: 2 });
  });

  test("choosing to replace someone's version keeps theirs as a revision", async () => {
    const { made, owner } = await signedIn();
    const entry = await newEntry(owner);
    await save(owner, entry.id, 1, { title: "Theirs", doc: paragraph("Their words") });

    const reply = await save(owner, entry.id, 2, {
      title: "Mine",
      doc: paragraph("My words"),
      keepOtherVersion: true,
    });
    expect(reply.status).toBe(200);
    expect((await reply.json()).title).toBe("Mine");

    const kept = made.db
      .prepare("SELECT title, data FROM revisions WHERE kind = 'conflict'")
      .get() as { title: string; data: string };
    expect(kept.title).toBe("Theirs");
    expect(JSON.parse(kept.data).doc).toEqual(paragraph("Their words"));
  });

  test("an ordinary save doesn't pile up revisions", async () => {
    const { made, owner } = await signedIn();
    const entry = await newEntry(owner);
    const before = made.db.prepare("SELECT count(*) AS n FROM revisions").get();
    await save(owner, entry.id, 1, { title: "One" });
    await save(owner, entry.id, 2, { title: "Two" });
    expect(made.db.prepare("SELECT count(*) AS n FROM revisions").get()).toEqual(before);
  });

  test("something that's never been saved stays out of the lists", async () => {
    const { owner } = await signedIn();
    const looked = await newEntry(owner);
    const list = async () =>
      (await (await owner.get(`${ENTRIES}?type=post`)).json()).entries.map(
        (entry: { id: string }) => entry.id,
      );
    expect(await list()).not.toContain(looked.id);
    await save(owner, looked.id, 1, { title: "Now it counts" });
    expect(await list()).toContain(looked.id);
  });

  test("publishing puts it on the site, at the address from its title", async () => {
    const { made, owner } = await signedIn();
    const entry = await newEntry(owner);
    await save(owner, entry.id, 1, { title: "Hello World", doc: paragraph("Hi there") });
    const reply = await publish(owner, entry.id, 2);
    expect(reply.status).toBe(200);
    expect(await reply.json()).toMatchObject({
      status: "published",
      slug: "hello-world",
      url: "/blog/hello-world",
      dirty: false,
      rev: 3,
    });
    const page = await made.app.request("/blog/hello-world");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Hi there");
  });

  test("publishing needs a title", async () => {
    const { owner } = await signedIn();
    const entry = await newEntry(owner);
    const reply = await publish(owner, entry.id, 1);
    expect(reply.status).toBe(400);
    expect((await reply.json()).error.field).toBe("title");
  });

  test("a title with no usable characters still gets an address", async () => {
    const { owner } = await signedIn();
    const entry = await newEntry(owner);
    await save(owner, entry.id, 1, { title: "日本語" });
    const published = await (await publish(owner, entry.id, 2)).json();
    expect(published.url).toMatch(/^\/blog\/post-[0-9a-f]{8}$/);
  });

  test("two posts can't share an address, and the error offers another", async () => {
    const { owner } = await signedIn();
    const first = await newEntry(owner);
    await save(owner, first.id, 1, { title: "Same" });
    await publish(owner, first.id, 2);
    const second = await newEntry(owner);
    await save(owner, second.id, 1, { title: "Same" });
    const reply = await publish(owner, second.id, 2);
    expect(reply.status).toBe(409);
    const { error } = await reply.json();
    expect(error).toMatchObject({ code: "address_taken", field: "slug" });
    // The field takes only the last part, so that's what it suggests.
    expect(error.fix).toBe("Try same-2.");
  });

  test("typing the whole path as the address still gives the right one", async () => {
    const { owner } = await signedIn();
    const post = await newEntry(owner, "post");
    const savedPost = await (await save(owner, post.id, 1, { slug: "/blog/same-2" })).json();
    expect(savedPost.slug).toBe("same-2");
    const page = await newEntry(owner, "page");
    const savedPage = await (await save(owner, page.id, 1, { slug: "/about/" })).json();
    expect(savedPage.slug).toBe("about");
  });

  test("a post and a page can have the same address, since their paths differ", async () => {
    const { owner } = await signedIn();
    const post = await newEntry(owner, "post");
    await save(owner, post.id, 1, { title: "About" });
    const page = await newEntry(owner, "page");
    await save(owner, page.id, 1, { title: "About" });
    expect((await publish(owner, post.id, 2)).status).toBe(200);
    expect((await publish(owner, page.id, 2)).status).toBe(200);
  });

  test.each(["admin", "api", "blog", "assets"])(
    "a page can't take the address /%s",
    async (slug) => {
      const { owner } = await signedIn();
      const page = await newEntry(owner, "page");
      const reply = await save(owner, page.id, 1, { title: "T", slug });
      expect(reply.status).toBe(400);
      expect((await reply.json()).error.code).toBe("address_reserved");
    },
  );

  test("a page titled like a reserved address is stopped at publish", async () => {
    const { owner } = await signedIn();
    const page = await newEntry(owner, "page");
    await save(owner, page.id, 1, { title: "Admin" });
    const reply = await publish(owner, page.id, 2);
    expect(reply.status).toBe(400);
    expect((await reply.json()).error.code).toBe("address_reserved");
  });

  test("edits stay off the site until they're published", async () => {
    const { made, owner } = await signedIn();
    const entry = await newEntry(owner);
    await save(owner, entry.id, 1, { title: "Live title", doc: paragraph("Live words") });
    await publish(owner, entry.id, 2);

    const edited = await (
      await save(owner, entry.id, 3, { doc: paragraph("Secret draft") })
    ).json();
    expect(edited.dirty).toBe(true);
    const url = "/blog/live-title";
    expect(await (await made.app.request(url)).text()).not.toContain("Secret draft");

    const republished = await (await publish(owner, entry.id, 4)).json();
    expect(republished.dirty).toBe(false);
    expect(await (await made.app.request(url)).text()).toContain("Secret draft");
  });

  test("a new address only takes over when it's published", async () => {
    const { made, owner } = await signedIn();
    const entry = await newEntry(owner);
    await save(owner, entry.id, 1, { title: "Old" });
    await publish(owner, entry.id, 2);
    await save(owner, entry.id, 3, { slug: "new" });
    expect((await made.app.request("/blog/old")).status).toBe(200);
    expect((await made.app.request("/blog/new")).status).toBe(404);
    await publish(owner, entry.id, 4);
    expect((await made.app.request("/blog/old")).status).toBe(404);
    expect((await made.app.request("/blog/new")).status).toBe(200);
  });

  test("unpublishing takes it off the site and keeps the text", async () => {
    const { made, owner } = await signedIn();
    const entry = await newEntry(owner);
    await save(owner, entry.id, 1, { title: "Gone", doc: paragraph("Words") });
    await publish(owner, entry.id, 2);
    const reply = await owner.post(`${ENTRIES}/${entry.id}/unpublish`, {}, { "If-Match": "3" });
    expect(await reply.json()).toMatchObject({ status: "draft", url: null, dirty: false });
    expect((await made.app.request("/blog/gone")).status).toBe(404);
    const current = await (await owner.get(`${ENTRIES}/${entry.id}`)).json();
    expect(current.data.doc).toEqual(paragraph("Words"));
  });

  test("the Trash takes it off the site, frees the address, and can be undone", async () => {
    const { made, owner } = await signedIn();
    const entry = await newEntry(owner);
    await save(owner, entry.id, 1, { title: "Binned", doc: paragraph("Words") });
    await publish(owner, entry.id, 2);

    expect((await owner.post(`${ENTRIES}/${entry.id}/trash`)).status).toBe(200);
    expect((await made.app.request("/blog/binned")).status).toBe(404);
    const all = await (await owner.get(`${ENTRIES}?type=post`)).json();
    expect(all.entries.map((e: { id: string }) => e.id)).not.toContain(entry.id);
    const trash = await (await owner.get(`${ENTRIES}?type=post&view=trash`)).json();
    expect(trash.entries.map((e: { id: string }) => e.id)).toContain(entry.id);

    const another = await newEntry(owner);
    await save(owner, another.id, 1, { title: "Binned" });
    expect((await publish(owner, another.id, 2)).status).toBe(200);

    const restored = await (await owner.post(`${ENTRIES}/${entry.id}/restore`)).json();
    expect(restored).toMatchObject({ trashedAt: null, status: "draft", url: null });
    expect(restored.data.doc).toEqual(paragraph("Words"));
  });

  test("something in the Trash can't be published", async () => {
    const { owner } = await signedIn();
    const entry = await newEntry(owner);
    await save(owner, entry.id, 1, { title: "T" });
    const trashed = await (await owner.post(`${ENTRIES}/${entry.id}/trash`)).json();
    const reply = await publish(owner, entry.id, trashed.rev);
    expect(reply.status).toBe(409);
    expect((await reply.json()).error.code).toBe("in_trash");
  });

  test("the homepage can't be unpublished or binned", async () => {
    const { owner } = await signedIn();
    const list = await (await owner.get(`${ENTRIES}?type=page`)).json();
    const home = list.entries.find((entry: { isHome: boolean }) => entry.isHome);
    const unpublish = await owner.post(
      `${ENTRIES}/${home.id}/unpublish`,
      {},
      { "If-Match": String(home.rev) },
    );
    expect(unpublish.status).toBe(409);
    expect((await owner.post(`${ENTRIES}/${home.id}/trash`)).status).toBe(409);
  });

  test("lists put the homepage first, then the newest changes", async () => {
    const { made, owner } = await signedIn();
    made.clock.time += 1000;
    const page = await newEntry(owner, "page");
    await save(owner, page.id, 1, { title: "Newest" });
    const list = await (await owner.get(`${ENTRIES}?type=page`)).json();
    expect(list.entries[0].isHome).toBe(true);
    expect(list.entries[1].id).toBe(page.id);
    expect(list.entries[0]).not.toHaveProperty("data");
  });

  test("long lists say there's more", async () => {
    const { owner } = await signedIn();
    for (let i = 0; i < 101; i++) {
      const entry = await newEntry(owner);
      await save(owner, entry.id, 1, { title: `Post ${i}` });
    }
    const first = await (await owner.get(`${ENTRIES}?type=post`)).json();
    expect(first.entries).toHaveLength(100);
    expect(first.nextCursor).toBe("100");
    const second = await (await owner.get(`${ENTRIES}?type=post&cursor=100`)).json();
    expect(second.nextCursor).toBeNull();
    expect(second.entries.length).toBeGreaterThan(0);
  });

  test("a wild list position is treated as the start, not an error", async () => {
    const { owner } = await signedIn();
    for (const cursor of ["99999999999999999999", "1".repeat(400), "-1", "abc"]) {
      const reply = await owner.get(`${ENTRIES}?type=page&cursor=${cursor}`);
      expect(reply.status, cursor).toBe(200);
    }
  });

  test("unknown entries are a plain 404 that says what to do", async () => {
    const { owner } = await signedIn();
    const reply = await owner.get(`${ENTRIES}/nope`);
    expect(reply.status).toBe(404);
    const { error } = await reply.json();
    expect(error.code).toBe("not_found");
    expect(error.fix).toBeTruthy();
  });

  test("large documents fit, and absurd ones are refused", async () => {
    const { owner } = await signedIn();
    const entry = await newEntry(owner);
    expect((await save(owner, entry.id, 1, { doc: paragraph("x".repeat(500_000)) })).status).toBe(
      200,
    );
    const tooBig = await save(owner, entry.id, 2, { doc: paragraph("x".repeat(3_000_000)) });
    expect(tooBig.status).toBe(413);
    const { error } = await tooBig.json();
    expect(error.message).not.toContain("request");
    expect(error.fix).toBeTruthy();
  });

  test("the admin API is closed to everyone not signed in", async () => {
    const made = await makeApp();
    await setUp(made);
    const stranger = browser(made.app);
    const reply = await stranger.get(`${ENTRIES}?type=post`);
    expect(reply.status).toBe(401);
    expect((await reply.json()).error.fix).toContain("Sign in again");
    expect((await stranger.post(ENTRIES, { type: "post" })).status).toBe(401);
  });
});
