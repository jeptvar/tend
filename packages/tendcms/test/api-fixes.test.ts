import { request as httpRequest } from "node:http";
import { type AddressInfo, connect } from "node:net";
import { createAdaptorServer } from "@hono/node-server";
import sharp from "sharp";
import { describe, expect, test } from "vitest";
import { type Actor, can } from "../src/auth/policy.ts";
import { linkedMediaIds, mediaIdInHref, usedMediaIds } from "../src/content/doc.ts";
import { publishEntry, saveEntry } from "../src/content/entries.ts";
import { createTag, usedTags } from "../src/content/tags.ts";
import { createSessionIfPasswordUnchanged } from "../src/db/repo/sessions.ts";
import { uuidv7 } from "../src/ids.ts";
import { cleanUpMedia, getMedia } from "../src/media/library.ts";
import { MediaStore } from "../src/media/store.ts";
import { browser, type MadeApp, makeApp, setUp } from "./auth-helpers.ts";

const MEDIA = "/api/admin/media";
const ENTRIES = "/api/admin/entries";
const DAY_MS = 24 * 60 * 60 * 1000;
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
const OTHER_PDF = Buffer.from("%PDF-1.4\n2 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

type Client = ReturnType<typeof browser>;

async function png(background = "#336699", width = 8, height = 8): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background } })
    .png()
    .toBuffer();
}

/** Adds someone with a role straight into the database, since invites arrive later. */
async function signedInAs(made: MadeApp, role: Actor["role"], name: string = role) {
  const id = uuidv7(made.clock.time);
  const hash = `hash-${id}`;
  made.db
    .prepare(
      "INSERT INTO users (id, email, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(id, `${name}@example.com`, name, role, hash, made.clock.time);
  const token = await createSessionIfPasswordUnchanged(made.orm, {
    userId: id,
    verifiedHash: hash,
    userAgent: null,
    ipPrefix: null,
    now: made.clock.time,
  });
  const client = browser(made.app);
  client.jar.set("tend_session", token as string);
  return { client, id };
}

async function uploaded(client: Client, data: Buffer, name: string) {
  const reply = await client.upload(MEDIA, data, name);
  expect(reply.status, name).toBe(201);
  return reply.json();
}

function linked(text: string, href: string) {
  return {
    type: "paragraph",
    content: [{ type: "text", text, marks: [{ type: "link", attrs: { href } }] }],
  };
}

function image(mediaId: string) {
  return { type: "image", attrs: { mediaId } };
}

function doc(...content: unknown[]) {
  return { type: "doc", content };
}

/** A link in a site menu to any address, as the Site menu screen saves one. */
function menuLink(label: string, url: string) {
  return { id: `link-${label}`, label, target: { type: "url", url }, children: [] };
}

/** Saves a title and fields, then publishes, as the editor's Publish does. */
async function publish(client: Client, type: "post" | "page", fields: Record<string, unknown>) {
  const entry = await (await client.post(ENTRIES, { type })).json();
  const saved = await (
    await client.patch(`${ENTRIES}/${entry.id}`, fields, { "If-Match": String(entry.rev) })
  ).json();
  const published = await client.post(
    `${ENTRIES}/${entry.id}/publish`,
    {},
    { "If-Match": String(saved.rev) },
  );
  expect(published.status).toBe(200);
  return published.json();
}

/** Saves a draft that's never published. */
async function draft(client: Client, type: "post" | "page", fields: Record<string, unknown>) {
  const entry = await (await client.post(ENTRIES, { type })).json();
  const saved = await client.patch(`${ENTRIES}/${entry.id}`, fields, {
    "If-Match": String(entry.rev),
  });
  expect(saved.status).toBe(200);
  return saved.json();
}

/** A body that comes a piece at a time, and counts how much of it the server has asked for. */
function trickle(total: number, options: { stallAfter?: number } = {}) {
  const CHUNK = 64 * 1024;
  let sent = 0;
  let fail: (error: Error) => void = () => {};
  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        fail = (error) => controller.error(error);
      },
      async pull(controller) {
        if (options.stallAfter !== undefined && sent >= options.stallAfter) {
          await new Promise(() => {});
        }
        if (sent >= total) {
          controller.close();
          return;
        }
        const size = Math.min(CHUNK, total - sent);
        controller.enqueue(new Uint8Array(size).fill(7));
        sent += size;
      },
    },
    { highWaterMark: 0 },
  );
  return {
    stream,
    pulled: () => sent,
    /** Hangs up, the way a browser tab being closed mid-upload does. */
    hangUp: () => fail(Object.assign(new Error("aborted"), { code: "ECONNRESET" })),
  };
}

/** What Tend says when it refuses something. */
async function refusalOf(response: Response) {
  const body = (await response.json()) as {
    error: { code: string; message: string; fix?: string };
  };
  return body.error;
}

function cookieOf(client: Client): string {
  return [...client.jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

async function sendBody(
  made: MadeApp,
  path: string,
  body: ReadableStream<Uint8Array>,
  headers: Record<string, string>,
) {
  return made.app.request(path, {
    method: "POST",
    headers,
    body,
    duplex: "half",
  } as RequestInit);
}

/** A file that arrives a piece at a time, with a pause before each piece. */
function drip(data: Buffer, pieces: number, pauseMs: number): ReadableStream<Uint8Array> {
  const size = Math.ceil(data.length / pieces);
  let sent = 0;
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (sent >= data.length) {
          controller.close();
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, pauseMs));
        controller.enqueue(new Uint8Array(data.subarray(sent, sent + size)));
        sent += size;
      },
    },
    { highWaterMark: 0 },
  );
}

/** The app on a real server, on a free port, for what only a real connection shows. */
async function serve(made: MadeApp) {
  const server = createAdaptorServer({ fetch: made.app.fetch });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Sends an upload over a real connection, a chunk at a time, and reads the answer. */
function sendOver(port: number, headers: Record<string, string>, chunks: Buffer[]) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = httpRequest(
      { host: "127.0.0.1", port, path: MEDIA, method: "POST", headers },
      (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    request.on("error", reject);
    for (const chunk of chunks) request.write(chunk);
    request.end();
  });
}

/** An answer read straight off a connection: its status, headers and body. */
function parseReply(raw: string) {
  const [head = "", body = ""] = raw.split("\r\n\r\n");
  const [statusLine = "", ...lines] = head.split("\r\n");
  const headers = Object.fromEntries(
    lines.map((line) => {
      const colon = line.indexOf(":");
      return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
    }),
  );
  return { status: Number(statusLine.split(" ")[1]), headers, body };
}

/**
 * An upload over its own connection that says how big it is, sends half, then sends nothing
 * more without hanging up: what a connection that drops without closing looks like.
 */
function stalledUpload(port: number, cookie: string) {
  const size = 1024 * 1024;
  const socket = connect(port, "127.0.0.1");
  let raw = "";
  socket.on("data", (chunk) => {
    raw += chunk;
  });
  socket.on("error", () => {});
  const closed = new Promise<void>((resolve) => socket.on("close", () => resolve()));
  socket.write(
    [
      `POST ${MEDIA} HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      `Cookie: ${cookie}`,
      "Content-Type: application/octet-stream",
      "X-File-Name: big.png",
      `Content-Length: ${size}`,
      "",
      "",
    ].join("\r\n"),
  );
  socket.write(Buffer.alloc(size / 2, 7));
  return { closed, reply: () => parseReply(raw), hangUp: () => socket.destroy() };
}

/** Waits for something, but no longer than a test should. */
function within<T>(ms: number, promise: Promise<T>): Promise<T | "still waiting"> {
  return Promise.race([
    promise,
    new Promise<"still waiting">((resolve) => setTimeout(() => resolve("still waiting"), ms)),
  ]);
}

describe("a file linked from a page counts as used (api-1)", () => {
  const pdf = "0193a0a0-0000-7000-8000-000000000001";
  const photo = "0193a0a0-0000-7000-8000-000000000002";
  const shown = "0193a0a0-0000-7000-8000-000000000003";
  const page = doc(
    linked("Lunch menu", `/media/${pdf}/abcdef123456/lunch-menu.pdf`),
    {
      type: "button",
      attrs: { href: `https://shop.example/media/${photo}/abc/960.webp`, label: "Photo" },
    },
    {
      type: "bulletList",
      content: [
        { type: "listItem", content: [linked("Again", `/media/${pdf}/x/y.pdf?v=2#page=3`)] },
      ],
    },
    image(shown),
    linked("Elsewhere", "https://example.com/menu.pdf"),
    linked("Mail", "mailto:shop@example.com"),
    linked("A page", "entry:0193a0a0-0000-7000-8000-00000000000a"),
  );

  test("links and buttons to a file's address count, with or without the site's origin", () => {
    const data = {
      doc: page as never,
      featuredImage: null,
      seo: { title: null, description: null, imageId: null, noindex: false },
    };
    expect(usedMediaIds(data).sort()).toEqual([pdf, photo, shown].sort());
  });

  test("a file's address is known wherever it's written, and nothing else is taken for one", () => {
    expect(linkedMediaIds(page as never).sort()).toEqual([pdf, photo]);
    expect(mediaIdInHref(`http://localhost:4321/media/${pdf}/abc/lunch.pdf`)).toBe(pdf);
    expect(mediaIdInHref(`/media/%30${pdf.slice(1)}/abc/lunch.pdf`)).toBe(pdf);
    expect(mediaIdInHref(`/media/${pdf}`)).toBeNull();
    expect(mediaIdInHref(`/blog/media/${pdf}/abc/lunch.pdf`)).toBeNull();
    expect(mediaIdInHref(`mailto:/media/${pdf}/x`)).toBeNull();
    expect(mediaIdInHref("https://[broken")).toBeNull();
  });

  test("Used in lists a page linking to a PDF, Delete forever refuses, and clean-up keeps it", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const menu = await uploaded(owner, PDF, "Lunch menu.pdf");
    const dinner = await uploaded(owner, PDF, "Dinner.pdf");
    // What the editor makes of a finished PDF upload, and a button from Copy address.
    const lunch = await publish(owner, "page", {
      title: "Lunch",
      doc: doc(linked("Lunch menu.pdf", menu.url), {
        type: "button",
        attrs: { href: `http://localhost${dinner.url}`, label: "Dinner menu" },
      }),
    });

    for (const file of [menu, dinner]) {
      const usage = await (await owner.get(`${MEDIA}/${file.id}/usage`)).json();
      expect(usage.uses, file.name).toEqual([
        { id: lunch.id, type: "page", title: "Lunch", url: "/lunch", inDraft: true },
      ]);
    }

    const trashed = await (await owner.post(`${MEDIA}/${menu.id}/trash`, {})).json();
    // The page keeps its link, so the admin can say it now leads nowhere.
    expect(trashed.uses).toEqual([expect.objectContaining({ id: lunch.id, linkOnly: true })]);
    const refused = await owner.delete(`${MEDIA}/${menu.id}`);
    expect(refused.status).toBe(409);
    expect((await refused.json()).error.message).toContain('"Lunch"');

    await owner.post(`${MEDIA}/${dinner.id}/trash`, {});
    made.clock.time += 31 * DAY_MS;
    await cleanUpMedia(made.orm, new MediaStore(made.uploadsDir), made.clock.time);
    expect(await getMedia(made.orm, dinner.id)).toBeDefined();
    expect(await getMedia(made.orm, menu.id)).toBeDefined();
  });

  test("trashing a picture says which pages lose it and which only lose a link", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const photo = await uploaded(owner, await png(), "Shop.png");
    const shows = await publish(owner, "post", { title: "Shows it", doc: doc(image(photo.id)) });
    const links = await publish(owner, "post", {
      title: "Links to it",
      doc: doc(linked("The photo", photo.url)),
    });
    const trashed = await (await owner.post(`${MEDIA}/${photo.id}/trash`, {})).json();
    const byId = new Map(trashed.uses.map((use: { id: string }) => [use.id, use]));
    expect(byId.get(shows.id)).not.toHaveProperty("linkOnly");
    expect(byId.get(links.id)).toMatchObject({ linkOnly: true });
  });

  test("a site menu link to a file counts however its address is written, as a page's does", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const { client: editor } = await signedInAs(made, "editor");
    const prices = await uploaded(owner, PDF, "Price list.pdf");
    // The same address with the ID's first character written as %30, which still leads there.
    const encoded = prices.url.replace(/^\/media\/0/, "/media/%30");
    expect(encoded).not.toBe(prices.url);
    expect((await made.app.request(encoded)).status).toBe(200);
    const footer = { items: [menuLink("Prices", encoded)] };
    expect((await owner.put("/api/admin/menus/footer", footer)).status).toBe(200);

    const menuUse = { id: "menu", type: "menu", title: "", url: "/", inDraft: false };
    expect((await (await editor.get(`${MEDIA}/${prices.id}/usage`)).json()).uses).toEqual([
      menuUse,
    ]);
    const trashed = await (await editor.post(`${MEDIA}/${prices.id}/trash`, {})).json();
    expect(trashed.uses).toEqual([menuUse]);
    expect((await owner.delete(`${MEDIA}/${prices.id}`)).status).toBe(409);
    made.clock.time += 31 * DAY_MS;
    await cleanUpMedia(made.orm, new MediaStore(made.uploadsDir), made.clock.time);
    expect(await getMedia(made.orm, prices.id)).toBeDefined();
  });
});

describe("uploads before sign-in, and how many at once (api-2)", () => {
  test("nothing is read before sign-in is checked, even sent in chunks", async () => {
    const made = await makeApp();
    await setUp(made);
    const upload = trickle(20 * 1024 * 1024);
    const refused = await sendBody(made, MEDIA, upload.stream, {
      "Content-Type": "application/octet-stream",
      "Transfer-Encoding": "chunked",
    });
    expect(refused.status).toBe(401);
    expect(upload.pulled()).toBe(0);

    const json = trickle(2 * 1024 * 1024 - 1024);
    const alsoRefused = await sendBody(made, ENTRIES, json.stream, {
      "Content-Type": "application/json",
    });
    expect(alsoRefused.status).toBe(401);
    expect(json.pulled()).toBe(0);
  });

  test("an upload that doesn't say its size is refused before it's read, saying what to do", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const upload = trickle(20 * 1024 * 1024);
    const refused = await sendBody(made, MEDIA, upload.stream, {
      Cookie: cookieOf(owner),
      "Content-Type": "application/octet-stream",
      "Transfer-Encoding": "chunked",
    });
    expect(refused.status).toBe(411);
    const error = await refusalOf(refused);
    expect(error.code).toBe("needs_length");
    expect(error.fix).toMatch(/Content-Length/);
    expect(upload.pulled()).toBe(0);
  });

  test("past four uploads at once, the next is asked to wait, and gets in once one is done", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const { client: editor } = await signedInAs(made, "editor");
    const { client: admin } = await signedInAs(made, "admin");
    const headers = (client: Client) => ({
      Cookie: cookieOf(client),
      "Content-Type": "application/octet-stream",
      "Content-Length": String(1024 * 1024),
      "X-File-Name": "big.png",
    });
    // Each sends half of what it said it would, then stops, holding its place: three of the
    // Owner's, which is all one account can hold, and one of an Editor's.
    const stalled = [owner, owner, owner, editor].map((client) => ({
      client,
      upload: trickle(1024 * 1024, { stallAfter: 512 * 1024 }),
    }));
    const held = stalled.map(({ client, upload }) =>
      sendBody(made, MEDIA, upload.stream, headers(client)),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    const fifth = trickle(1024 * 1024);
    const answer = await within(2000, sendBody(made, MEDIA, fifth.stream, headers(admin)));
    expect(answer).not.toBe("still waiting");
    const busy = answer as Response;
    expect(busy.status).toBe(503);
    expect(busy.headers.get("retry-after")).toBe("2");
    const error = await refusalOf(busy);
    expect(error).toMatchObject({
      code: "uploads_busy",
      message: "Tend is busy with other uploads right now.",
      fix: "Wait a moment, then try again.",
      docs: "https://tendcms.dev/errors/uploads_busy",
    });
    expect(fifth.pulled()).toBe(0);

    for (const { upload } of stalled) upload.hangUp();
    await Promise.all(held);
    const after = await admin.upload(MEDIA, await png(), "dot.png");
    expect(after.status).toBe(201);
  });

  test("one account can't take every place, so someone else's upload still gets in", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const { client: editor } = await signedInAs(made, "editor");
    const headers = {
      Cookie: cookieOf(owner),
      "Content-Type": "application/octet-stream",
      "Content-Length": String(1024 * 1024),
      "X-File-Name": "big.png",
    };
    const stalled = Array.from({ length: 3 }, () =>
      trickle(1024 * 1024, { stallAfter: 512 * 1024 }),
    );
    const held = stalled.map((upload) => sendBody(made, MEDIA, upload.stream, headers));
    await new Promise((resolve) => setTimeout(resolve, 50));

    // A fourth of the Owner's waits, though there's a place left...
    const fourth = trickle(1024 * 1024);
    const answer = await within(2000, sendBody(made, MEDIA, fourth.stream, headers));
    expect(answer).not.toBe("still waiting");
    expect((answer as Response).status).toBe(503);
    expect((await refusalOf(answer as Response)).code).toBe("uploads_busy");
    expect(fourth.pulled()).toBe(0);
    // ...because it's someone else's to take.
    expect((await editor.upload(MEDIA, await png(), "dot.png")).status).toBe(201);

    for (const upload of stalled) upload.hangUp();
    await Promise.all(held);
    expect((await owner.upload(MEDIA, await png("#aa3300"), "dot.png")).status).toBe(201);
  });

  test("an upload that keeps arriving, however slowly, isn't cut off", async () => {
    const made = await makeApp({ uploadIdleMs: 1000 });
    const owner = await setUp(made);
    const picture = await png("#336699", 64, 64);
    // Twelve pieces a tenth of a second apart: longer than Tend waits for nothing at all.
    const reply = await sendBody(made, MEDIA, drip(picture, 12, 100), {
      Cookie: cookieOf(owner),
      "Content-Type": "application/octet-stream",
      "X-File-Name": "slow.png",
    });
    expect(reply.status).toBe(201);
  });

  test("over a real connection: chunked uploads are refused, and sized ones get in", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const server = await serve(made);
    try {
      const picture = await png();
      const file = { "Content-Type": "application/octet-stream", "X-File-Name": "dot.png" };
      const chunked = await sendOver(server.port, { ...file, Cookie: cookieOf(owner) }, [
        picture,
        picture,
      ]);
      expect(chunked.status).toBe(411);
      expect(JSON.parse(chunked.body).error).toMatchObject({
        code: "needs_length",
        fix: "Send its size in a Content-Length header, or upload it from Media instead.",
        docs: "https://tendcms.dev/errors/needs_length",
      });
      const anonymous = await sendOver(server.port, file, [picture]);
      expect(anonymous.status).toBe(401);
      const sized = await sendOver(
        server.port,
        { ...file, Cookie: cookieOf(owner), "Content-Length": String(picture.length) },
        [picture],
      );
      expect(sized.status).toBe(201);
    } finally {
      await server.close();
    }
  });

  test("over a real connection: an upload that stops arriving gives its place back, and is told why", async () => {
    // Long enough that a busy machine still asks for a fifth place before any is given back.
    const made = await makeApp({ uploadIdleMs: 2000 });
    const owner = await setUp(made);
    const { client: editor } = await signedInAs(made, "editor");
    const { client: admin } = await signedInAs(made, "admin");
    const server = await serve(made);
    const picture = await png();
    const sized = {
      Cookie: cookieOf(admin),
      "Content-Type": "application/octet-stream",
      "X-File-Name": "dot.png",
      "Content-Length": String(picture.length),
    };
    // Every place taken by uploads that stopped halfway without hanging up.
    const stalled = [owner, owner, owner, editor].map((client) =>
      stalledUpload(server.port, cookieOf(client)),
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect((await sendOver(server.port, sized, [picture])).status).toBe(503);

      // Once nothing more has arrived for a while, each is told why, and hung up on.
      const closed = await within(8000, Promise.all(stalled.map((upload) => upload.closed)));
      expect(closed).not.toBe("still waiting");
      for (const upload of stalled) {
        const reply = upload.reply();
        expect(reply.status).toBe(408);
        expect(reply.headers.connection).toBe("close");
        expect(JSON.parse(reply.body).error).toEqual({
          code: "upload_stalled",
          message: "That file stopped arriving partway through, so it wasn't uploaded.",
          fix: "Check your connection, then try again.",
          docs: "https://tendcms.dev/errors/upload_stalled",
        });
      }
      // Their places are free again.
      expect((await sendOver(server.port, sized, [picture])).status).toBe(201);
    } finally {
      for (const upload of stalled) upload.hangUp();
      await server.close();
    }
  });
});

describe("looking up a document's pictures (api-3, api-8)", () => {
  test("every picture asked about is answered, however many there are", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const ids = Array.from({ length: 205 }, (_, index) => uuidv7(made.clock.time + index));
    const insert = made.db.prepare(
      "INSERT INTO media (id, kind, original_name, mime, ext, size_bytes, width, height, sha256, variants, created_at, updated_at) VALUES (?, 'image', ?, 'image/png', 'png', 10, 8, 8, ?, '[8]', ?, ?)",
    );
    for (const [index, id] of ids.entries()) {
      insert.run(
        id,
        `${index}.png`,
        `${index}`.padStart(64, "0"),
        made.clock.time,
        made.clock.time,
      );
    }
    const reply = await (await owner.get(`${MEDIA}?ids=${ids.join(",")}`)).json();
    expect(reply.media.map((item: { id: string }) => item.id).sort()).toEqual([...ids].sort());
  });
});

describe("what a Writer can do with pictures (api-4, api-5)", () => {
  test("a Writer can't replace a picture, nor describe one once the site shows it", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const { client: writer } = await signedInAs(made, "writer");
    const { client: editor } = await signedInAs(made, "editor");
    const garden = await uploaded(writer, await png("#00aa00"), "garden.png");
    const spare = await uploaded(writer, await png("#0000aa"), "spare.png");

    // Their own picture, not on the site yet: theirs to describe.
    expect((await writer.patch(`${MEDIA}/${spare.id}`, { alt: "A spare" })).status).toBe(200);

    await publish(owner, "post", { title: "Garden open day", doc: doc(image(garden.id)) });
    const replaced = await writer.upload(
      `${MEDIA}/${garden.id}/replace`,
      await png("#ff0000"),
      "x.png",
    );
    expect(replaced.status).toBe(403);
    const described = await writer.patch(`${MEDIA}/${garden.id}`, { credit: "Unreviewed words" });
    expect(described.status).toBe(403);
    const { error } = await described.json();
    expect(error.code).toBe("on_your_site");
    expect(error.fix).toBeTruthy();
    const html = await (await made.app.request("/blog/garden-open-day")).text();
    expect(html).not.toContain("Unreviewed words");

    // Someone who can publish still can.
    expect((await editor.patch(`${MEDIA}/${garden.id}`, { credit: "By Sam" })).status).toBe(200);
    const byEditor = await editor.upload(
      `${MEDIA}/${garden.id}/replace`,
      await png("#ff0000"),
      "x.png",
    );
    expect(byEditor.status).toBe(200);
  });

  test("a Writer can't describe their picture once the site itself uses it, not only a page", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const { client: writer } = await signedInAs(made, "writer");
    const logo = await uploaded(writer, await png("#111111"), "logo.png");
    const icon = await uploaded(writer, await png("#222222"), "icon.png");
    const share = await uploaded(writer, await png("#333333"), "share.png");
    const sign = await uploaded(writer, await png("#444444"), "sign.png");
    const spare = await uploaded(writer, await png("#555555"), "spare.png");
    const design = await (await owner.get("/api/admin/design")).json();
    const chosen = { ...design.value, logoId: logo.id, iconId: icon.id };
    expect((await owner.put("/api/admin/design", chosen)).status).toBe(200);
    const seo = { description: null, imageId: share.id };
    expect((await owner.put("/api/admin/settings/seo", seo)).status).toBe(200);
    const footer = { items: [menuLink("Our sign", sign.url)] };
    expect((await owner.put("/api/admin/menus/footer", footer)).status).toBe(200);

    for (const item of [logo, icon, share, sign]) {
      const described = await writer.patch(`${MEDIA}/${item.id}`, { alt: "Unreviewed words" });
      expect(described.status, item.name).toBe(403);
      expect((await described.json()).error.code, item.name).toBe("on_your_site");
    }
    // One the site doesn't use is still theirs to describe.
    expect((await writer.patch(`${MEDIA}/${spare.id}`, { alt: "A spare" })).status).toBe(200);
  });

  test("Used in shows a Writer their own drafts, and other people's posts only as published", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const { client: writer } = await signedInAs(made, "writer");
    const picture = await uploaded(owner, await png(), "shop.png");

    await draft(owner, "post", {
      title: "DRAFT: closing the shop in March",
      doc: doc(image(picture.id)),
    });
    const live = await publish(owner, "post", {
      title: "Garden open day",
      doc: doc(image(picture.id)),
    });
    await owner.patch(
      `${ENTRIES}/${live.id}`,
      { title: "Garden closing for good (not announced)" },
      { "If-Match": String(live.rev) },
    );
    // Live, but only its draft uses the picture: not the Writer's to know about.
    const other = await publish(owner, "post", { title: "Opening hours" });
    await owner.patch(
      `${ENTRIES}/${other.id}`,
      { doc: doc(image(picture.id)) },
      { "If-Match": String(other.rev) },
    );
    const mine = await draft(writer, "post", { title: "My draft", doc: doc(image(picture.id)) });

    const usage = await (await writer.get(`${MEDIA}/${picture.id}/usage`)).json();
    expect(usage.uses).toEqual([
      {
        id: live.id,
        type: "post",
        title: "Garden open day",
        url: "/blog/garden-open-day",
        inDraft: false,
      },
      { id: mine.id, type: "post", title: "My draft", url: null, inDraft: true },
    ]);
    // Everyone else still sees everything.
    const all = await (await owner.get(`${MEDIA}/${picture.id}/usage`)).json();
    expect(all.uses).toHaveLength(4);
  });
});

describe("an Editor and the parts of the site only Design and Settings change (api-6)", () => {
  test("an Editor can't replace or trash the logo, site icon or picture for sharing", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const { client: editor } = await signedInAs(made, "editor");
    const logo = await uploaded(owner, await png("#111111"), "logo.png");
    const icon = await uploaded(owner, await png("#222222"), "icon.png");
    const share = await uploaded(owner, await png("#333333"), "share.png");
    const design = await (await owner.get("/api/admin/design")).json();
    await owner.put("/api/admin/design", { ...design.value, logoId: logo.id, iconId: icon.id });
    await owner.put("/api/admin/settings/seo", { description: null, imageId: share.id });

    const fixes = {
      [logo.id]: "Ask whoever runs this site to choose another logo first.",
      [icon.id]: "Ask whoever runs this site to choose another site icon first.",
      [share.id]: "Ask whoever runs this site to choose another picture for sharing first.",
    };
    for (const item of [logo, icon, share]) {
      const replaced = await editor.upload(
        `${MEDIA}/${item.id}/replace`,
        await png("#ff0000"),
        "x.png",
      );
      expect(replaced.status, item.name).toBe(403);
      expect((await replaced.json()).error).toMatchObject({
        code: "used_by_site",
        fix: fixes[item.id],
      });
      const trashed = await editor.post(`${MEDIA}/${item.id}/trash`, {});
      expect(trashed.status, item.name).toBe(403);
    }
    // Visitors still see the logo as it was: its address, up to the version, is unchanged.
    const home = await (await made.app.request("/")).text();
    expect(home).toContain(logo.thumbUrl.split("/").slice(0, 4).join("/"));

    // Whoever runs the site still can, and an Editor can for everything else.
    expect(
      (await owner.upload(`${MEDIA}/${logo.id}/replace`, await png("#00ff00"), "l.png")).status,
    ).toBe(200);
    expect((await owner.post(`${MEDIA}/${share.id}/trash`, {})).status).toBe(200);
    const other = await uploaded(owner, await png(), "other.png");
    expect((await editor.post(`${MEDIA}/${other.id}/trash`, {})).status).toBe(200);
  });

  test("an Editor can replace and trash a PDF the site menu links to, since the menu is theirs", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const { client: editor } = await signedInAs(made, "editor");
    const lunch = await uploaded(owner, PDF, "Lunch menu.pdf");
    const footer = { items: [menuLink("Lunch menu", lunch.url)] };
    expect((await owner.put("/api/admin/menus/footer", footer)).status).toBe(200);
    const menuUse = { id: "menu", type: "menu", title: "", url: "/", inDraft: false };
    expect((await (await editor.get(`${MEDIA}/${lunch.id}/usage`)).json()).uses).toEqual([menuUse]);

    // This week's menu, at the same address.
    const replaced = await editor.upload(`${MEDIA}/${lunch.id}/replace`, OTHER_PDF, "Lunch.pdf");
    expect(replaced.status).toBe(200);
    const trashed = await editor.post(`${MEDIA}/${lunch.id}/trash`, {});
    expect(trashed.status).toBe(200);
    expect((await trashed.json()).uses).toEqual([menuUse]);
  });
});

describe("Writers write posts, not pages (api-9)", () => {
  test("a Writer can't make a page, and is told who can", async () => {
    const made = await makeApp();
    await setUp(made);
    const { client: writer, id } = await signedInAs(made, "writer");
    const { client: editor } = await signedInAs(made, "editor");
    const refused = await writer.post(ENTRIES, { type: "page" });
    expect(refused.status).toBe(403);
    const { error } = await refused.json();
    expect(error.message).toBe("Your account can write posts, but not pages.");
    expect(error.fix).toBe("Ask whoever runs this site to add the page.");
    expect((await writer.post(ENTRIES, { type: "post" })).status).toBe(201);
    expect((await editor.post(ENTRIES, { type: "page" })).status).toBe(201);

    // Not even a page that's somehow their own.
    const writerActor = { id, role: "writer", isOwner: 0 } as const;
    expect(can(writerActor, "entry:update", { authorId: id, type: "page" })).toBe(false);
    expect(can(writerActor, "entry:update", { authorId: id, type: "post" })).toBe(true);
  });

  test("a page a Writer wrote still isn't theirs to open, change, copy, look back through or preview", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const { client: writer, id: writerId } = await signedInAs(made, "writer");

    /** Something with a version kept in History, and the Writer as its author. */
    async function written(type: "post" | "page") {
      const entry = await (await owner.post(ENTRIES, { type })).json();
      const path = `${ENTRIES}/${entry.id}`;
      const first = await (
        await owner.patch(path, { title: "About us" }, { "If-Match": String(entry.rev) })
      ).json();
      // The second save keeps the first in History.
      await owner.patch(path, { title: "About us, again" }, { "If-Match": String(first.rev) });
      // Written while they were an Editor, say, which was when they could still make pages.
      made.db.prepare("UPDATE entries SET author_id = ? WHERE id = ?").run(writerId, entry.id);
      const { revisions } = await (await owner.get(`${path}/revisions`)).json();
      return { id: entry.id as string, versionId: revisions[0].id as string };
    }

    async function everything(entry: Awaited<ReturnType<typeof written>>) {
      const path = `${ENTRIES}/${entry.id}`;
      const version = `/api/admin/revisions/${entry.versionId}`;
      // The newest version each time, so whatever's let through really runs.
      const newest = async () => ({
        "If-Match": String((await (await owner.get(path)).json()).rev),
      });
      return {
        open: (await writer.get(path)).status,
        change: (await writer.patch(path, { title: "Changed by a Writer" }, await newest())).status,
        copy: (await writer.post(`${path}/duplicate`, {})).status,
        history: (await writer.get(`${path}/revisions`)).status,
        version: (await writer.get(version)).status,
        restore: (await writer.post(`${version}/restore`, {}, await newest())).status,
        preview: (await writer.get(`/api/admin/preview/${entry.id}`)).status,
      };
    }

    const page = await written("page");
    expect(await everything(page)).toEqual({
      open: 403,
      change: 403,
      copy: 403,
      history: 403,
      version: 403,
      restore: 403,
      preview: 403,
    });
    expect((await (await owner.get(`${ENTRIES}/${page.id}`)).json()).title).toBe("About us, again");
    // A post they wrote, kept the same way, is theirs to do all of that with.
    expect(await everything(await written("post"))).toEqual({
      open: 200,
      change: 200,
      copy: 201,
      history: 200,
      version: 200,
      restore: 200,
      preview: 200,
    });
  });
});

describe("only posts have tags (api-10)", () => {
  test("tags sent for a page are ignored, so the sitemap never lists an empty tag page", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const seasonal = await (await owner.post("/api/admin/tags", { name: "Seasonal" })).json();
    const page = await publish(owner, "page", { title: "Spring", tagIds: [seasonal.id] });
    expect(page.data.tagIds).toEqual([]);
    const sitemap = await (await made.app.request("/sitemap.xml")).text();
    expect(sitemap).not.toContain("/tag/seasonal");
  });

  test("only published posts count towards the tags that are listed", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const tag = await createTag(made.orm, { name: "Seasonal", now: made.clock.time });
    // A page that has tags anyway, from before they were ignored.
    const page = await (await owner.post(ENTRIES, { type: "page" })).json();
    const { id } = await (await owner.get("/api/auth/me")).json().then((me) => me.user);
    const saved = await saveEntry(made.orm, {
      id: page.id,
      expectedRev: page.rev,
      patch: { title: "Spring", tagIds: [tag.id] },
      authorId: id,
      now: made.clock.time,
    });
    if (!("saved" in saved)) throw new Error("expected a save");
    await publishEntry(made.orm, {
      id: page.id,
      expectedRev: saved.saved.rev,
      authorId: id,
      now: made.clock.time,
    });
    expect(await usedTags(made.orm)).toEqual([]);

    await publish(owner, "post", { title: "Rye", tagIds: [tag.id] });
    expect((await usedTags(made.orm)).map((used) => used.id)).toEqual([tag.id]);
  });
});
