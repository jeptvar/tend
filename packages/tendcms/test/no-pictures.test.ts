import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { media } from "../src/db/schema.ts";
import { MediaStore } from "../src/media/store.ts";
import { type MadeApp, makeApp, setUp, signedInAs } from "./auth-helpers.ts";

// The picture component can't load on this computer, so the site goes on without it (PLAN.md
// §18). Everything here runs as it would then.

vi.mock("sharp", () => {
  throw new Error("Could not load the sharp module using the linux-x64 runtime");
});

const MEDIA = "/api/admin/media";
const ID = "019a0000-0000-7000-8000-00000000000a";
const HASH = "abcdef012345";

/** Enough of a PNG to be known as one. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("the rest of a picture"),
]);
const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");

/** A picture from when the component worked, whose sizes a restored backup left out. */
function storedPicture(made: MadeApp): void {
  const store = new MediaStore(join(made.root, "uploads"));
  const path = store.originalPath(ID, HASH, "png");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, PNG);
  made.orm
    .insert(media)
    .values({
      id: ID,
      kind: "image",
      originalName: "loaf.png",
      mime: "image/png",
      ext: "png",
      sizeBytes: PNG.length,
      width: 600,
      height: 400,
      sha256: HASH.padEnd(64, "0"),
      variants: [480, 600],
      createdAt: made.clock.time,
      updatedAt: made.clock.time,
    })
    .run();
}

describe("without the picture component", () => {
  test("a picture is refused, with what to do, and a PDF is taken", async () => {
    const made = await makeApp();
    const owner = await setUp(made, { starter: "blank" });
    const refused = await owner.upload(MEDIA, PNG, "loaf.png");
    expect(refused.status).toBe(503);
    expect((await refused.json()).error).toEqual({
      code: "pictures_unavailable",
      message: "Tend can't prepare pictures on this server, so that wasn't done.",
      fix: "Everything else works. Ask whoever looks after this server to look at Help.",
      docs: "https://tendcms.dev/errors/pictures_unavailable",
    });
    // It's still the kind of file that's looked at first: this one couldn't be used anyway.
    expect((await owner.upload(MEDIA, Buffer.from("hello"), "note.txt")).status).toBe(415);
    const taken = await owner.upload(MEDIA, PDF, "menu.pdf");
    expect(taken.status).toBe(201);
    expect((await taken.json()).kind).toBe("file");

    // Nothing of the refused one stays, and the next thing asked of Media is answered.
    const list = await (await owner.get(MEDIA)).json();
    expect(list.media.map((item: { name: string }) => item.name)).toEqual(["menu.pdf"]);
  });

  test("a starting point's pictures are sent as they are", async () => {
    const made = await makeApp();
    const owner = await setUp(made, { starter: "business" });
    const home = await (await made.app.request("/")).text();
    const size = home.match(/\/media\/[^ "]+\/960\.webp/)?.[0] as string;
    const sent = await owner.get(size);
    expect(sent.status).toBe(200);
    expect(sent.headers.get("content-type")).toBe("image/jpeg");
    expect(sent.headers.get("cache-control")).toBe("no-store");
  });

  test("a picture's missing sizes are sent as it was uploaded, and nobody keeps that", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    storedPicture(made);
    const missing = await owner.get(`/media/${ID}/${HASH}/480.webp`);
    expect(missing.status).toBe(200);
    expect(missing.headers.get("content-type")).toBe("image/png");
    expect(missing.headers.get("cache-control")).toBe("no-store");
    expect(await missing.bytes()).toEqual(PNG);

    // A size that's here is sent as always.
    const store = new MediaStore(join(made.root, "uploads"));
    store.write(store.variantPath(ID, HASH, "600.webp"), Buffer.from("a webp"));
    const kept = await owner.get(`/media/${ID}/${HASH}/600.webp`);
    expect(kept.headers.get("content-type")).toBe("image/webp");
    expect(kept.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");

    const design = await (await owner.get("/api/admin/design")).json();
    await owner.put("/api/admin/design", { ...design.value, logoId: ID });
    const icon = await owner.get(`/media/${ID}/${HASH}/icon-32.png`);
    expect(icon.status).toBe(200);
    expect(icon.headers.get("cache-control")).toBe("no-store");
    expect(await icon.bytes()).toEqual(PNG);
  });

  test("the site still shows its pages", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    expect((await owner.get("/")).status).toBe(200);
    expect((await owner.get("/blog")).status).toBe(200);
  });

  test("the admin says so, and Help says why and what to do", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    expect((await (await owner.get("/api/auth/me")).json()).picturesWork).toBe(false);
    const { client: writer } = await signedInAs(made, "writer");
    expect((await (await writer.get("/api/auth/me")).json()).picturesWork).toBe(false);
    const { findings } = await (await owner.get("/api/admin/health")).json();
    expect(findings).toContainEqual({
      kind: "FIX",
      text: expect.stringMatching(
        /^Tend's picture component couldn't load on this computer \(.+\)\. Your site works and shows the pictures it has, but none can be added\. Install Tend again/,
      ),
    });
  });
});
