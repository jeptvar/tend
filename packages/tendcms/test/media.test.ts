import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, test } from "vitest";
import { ApiError } from "../src/api/errors.ts";
import { renderDoc } from "../src/content/render-doc.ts";
import { checkUpload, processImage, sniff, widthsFor } from "../src/media/process.ts";
import { clearSizesIfLow, MediaStore } from "../src/media/store.ts";
import { makeApp, setUp } from "./auth-helpers.ts";

const MEDIA = "/api/admin/media";
const ENTRIES = "/api/admin/entries";

function picture(width: number, height: number, background = "#336699") {
  return sharp({ create: { width, height, channels: 3, background } });
}

async function png(width = 40, height = 30, background?: string): Promise<Buffer> {
  return picture(width, height, background).png().toBuffer();
}

async function jpeg(width = 40, height = 30): Promise<Buffer> {
  return picture(width, height).jpeg().toBuffer();
}

function refusal(work: () => unknown): ApiError {
  try {
    work();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

async function refusalOf(work: () => Promise<unknown>): Promise<ApiError> {
  try {
    await work();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("what a file really is", () => {
  test("pictures and PDFs are known by their first bytes, whatever they're called", async () => {
    expect(sniff(await jpeg())).toEqual({ kind: "image", format: "jpeg" });
    expect(sniff(await png())).toEqual({ kind: "image", format: "png" });
    expect(sniff(await picture(4, 4).gif().toBuffer())).toEqual({ kind: "image", format: "gif" });
    expect(sniff(await picture(4, 4).webp().toBuffer())).toEqual({ kind: "image", format: "webp" });
    expect(sniff(await picture(4, 4).avif().toBuffer())).toEqual({ kind: "image", format: "avif" });
    expect(sniff(Buffer.from("%PDF-1.7\n%âãÏÓ\n"))).toEqual({ kind: "file", format: "pdf" });
  });

  test("HEIC photos and SVG drawings are recognised, so the message can say what to do", () => {
    const heic = Buffer.concat([
      Buffer.from([0, 0, 0, 24]),
      Buffer.from("ftypheic"),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from("mif1heic"),
    ]);
    expect(sniff(heic)).toEqual({ kind: "heic" });
    expect(
      sniff(Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>')),
    ).toEqual({
      kind: "svg",
    });
    expect(sniff(Buffer.from("  <svg><script>alert(1)</script></svg>"))).toEqual({ kind: "svg" });
    expect(sniff(Buffer.from("<html><body>hello</body></html>"))).toBeUndefined();
    expect(sniff(Buffer.from([]))).toBeUndefined();
  });

  test("an upload is refused with a reason and a way forward", async () => {
    const heic = refusal(() => checkUpload("IMG_0001.HEIC", Buffer.from("anything at all")));
    expect(heic.code).toBe("heic_photo");
    expect(heic.details.fix).toMatch(/Most Compatible/);

    const svg = refusal(() => checkUpload("logo.svg", Buffer.from("<svg/>")));
    expect(svg.code).toBe("svg_file");
    expect(svg.details.fix).toMatch(/PNG/);

    expect(refusal(() => checkUpload("notes.txt", Buffer.from("hello"))).code).toBe(
      "unsupported_file",
    );
    // The bytes of a picture with a name that would make it something else.
    expect(refusal(() => checkUpload("run.exe", Buffer.from("%PDF-1.4"))).code).toBe(
      "unsupported_file",
    );
    expect(checkUpload("photo", await png())).toEqual({ kind: "image", format: "png" });
    expect(checkUpload("Photo.JPG", await png())).toEqual({ kind: "image", format: "png" });
  });
});

describe("making pictures ready for visitors", () => {
  test("each picture gets the standard sizes below it, then its own", () => {
    expect(widthsFor(300)).toEqual([300]);
    expect(widthsFor(480)).toEqual([480]);
    expect(widthsFor(700)).toEqual([480, 700]);
    expect(widthsFor(1600)).toEqual([480, 960, 1600]);
    expect(widthsFor(3000)).toEqual([480, 960, 1600, 2400]);
  });

  test("a photo is turned the right way up, and its camera details and location are dropped", async () => {
    const sideways = await picture(60, 20)
      .jpeg()
      .withExif({ IFD0: { Make: "Phone" }, IFD3: { GPSLatitudeRef: "N" } })
      .withMetadata({ orientation: 6 })
      .toBuffer();
    expect((await sharp(sideways).metadata()).orientation).toBe(6);
    const done = await processImage(sideways, "jpeg");
    expect([done.width, done.height]).toEqual([20, 60]);
    const meta = await sharp(done.original).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
    expect(done.variants.map((variant) => variant.width)).toEqual([20]);
  });

  test("sizes are WebP, smallest first, and the colour behind it is picked out", async () => {
    const done = await processImage(await png(2000, 1000, "#cc3300"), "png");
    expect(done.variants.map((variant) => variant.width)).toEqual([480, 960, 1600, 2000]);
    for (const variant of done.variants) {
      const meta = await sharp(variant.data).metadata();
      expect(meta.format).toBe("webp");
      expect(meta.width).toBe(variant.width);
    }
    expect(done.dominantColor).toMatch(/^#[0-9a-f]{6}$/);
    expect(done.mime).toBe("image/png");
    expect(done.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a picture over 50 megapixels is refused before it's opened", async () => {
    const huge = await picture(8000, 7000).png({ compressionLevel: 1 }).toBuffer();
    const error = await refusalOf(() => processImage(huge, "png"));
    expect(error.code).toBe("too_many_pixels");
    expect(error.status).toBe(413);
  });

  test("a damaged picture is refused with a reason", async () => {
    const good = await jpeg();
    const error = await refusalOf(() => processImage(good.subarray(0, 20), "jpeg"));
    expect(error.code).toBe("unreadable_picture");
  });
});

async function withPicture(owner: Awaited<ReturnType<typeof setUp>>, data?: Buffer) {
  const reply = await owner.upload(MEDIA, data ?? (await png(1200, 800)), "Sunny day.png");
  expect(reply.status).toBe(201);
  return reply.json();
}

function inDoc(...content: unknown[]) {
  return { type: "doc", content };
}

function image(mediaId: string, attrs: Record<string, unknown> = {}) {
  return { type: "image", attrs: { mediaId, ...attrs } };
}

async function publish(
  owner: Awaited<ReturnType<typeof setUp>>,
  fields: Record<string, unknown>,
  type = "post",
) {
  const entry = await (await owner.post(ENTRIES, { type })).json();
  const saved = await (
    await owner.patch(
      `${ENTRIES}/${entry.id}`,
      { title: "With a picture", ...fields },
      { "If-Match": "1" },
    )
  ).json();
  const published = await owner.post(
    `${ENTRIES}/${entry.id}/publish`,
    {},
    { "If-Match": String(saved.rev) },
  );
  expect(published.status).toBe(200);
  return published.json();
}

describe("uploading", () => {
  test("a picture is stored with its sizes and can be described", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const uploaded = await withPicture(owner);
    expect(uploaded).toMatchObject({
      kind: "image",
      name: "Sunny day.png",
      width: 1200,
      height: 800,
      alt: null,
      decorative: false,
      uploadedBy: { name: "Tom Baker" },
    });
    expect(uploaded.srcset).toContain(" 480w");
    expect(uploaded.srcset).toContain(" 1200w");

    const described = await owner.patch(`${MEDIA}/${uploaded.id}`, { alt: "  A bakery window  " });
    expect((await described.json()).alt).toBe("A bakery window");

    const list = await (await owner.get(`${MEDIA}?q=bakery`)).json();
    expect(list.media.map((item: { id: string }) => item.id)).toEqual([uploaded.id]);
    expect((await (await owner.get(`${MEDIA}?q=nothing-like-it`)).json()).media).toEqual([]);
  });

  test("the file is the body itself, and nothing else is accepted for it", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const asJson = await owner.post(MEDIA, { file: "nope" });
    expect(asJson.status).toBe(415);
    expect((await asJson.json()).error.code).toBe("needs_file");

    const empty = await owner.upload(MEDIA, Buffer.alloc(0), "empty.png");
    expect((await empty.json()).error.code).toBe("empty_file");
  });

  test("another website can't upload with someone's sign-in", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const cookie = [...owner.jar].map(([name, value]) => `${name}=${value}`).join("; ");
    const response = await made.app.request(MEDIA, {
      method: "POST",
      headers: {
        Cookie: cookie,
        "Content-Type": "application/octet-stream",
        "Sec-Fetch-Site": "cross-site",
      },
      body: new Uint8Array(await png()),
    });
    expect(response.status).toBe(403);
  });

  test("anything over 20 MB is refused, saying what to do", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const reply = await owner.upload(MEDIA, Buffer.alloc(21 * 1024 * 1024, 1), "huge.jpg");
    expect(reply.status).toBe(413);
    const body = await reply.json();
    expect(body.error.code).toBe("file_too_large");
    expect(body.error.fix).toMatch(/smaller/);
  });

  test("a PDF is kept as it is, under a readable name", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const pdf = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
    const reply = await owner.upload(MEDIA, pdf, "Lunch Menü (2026).pdf");
    expect(reply.status).toBe(201);
    const file = await reply.json();
    expect(file.kind).toBe("file");
    expect(file.url).toMatch(/\/lunch-menu-2026\.pdf$/);
    const served = await made.app.request(file.url);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("application/pdf");
    expect(served.headers.get("content-disposition")).toContain("lunch-menu-2026.pdf");
    // Saved, not opened in a viewer at the site's own address (PLAN.md §12).
    expect(served.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(Buffer.from(await served.arrayBuffer()).equals(pdf)).toBe(true);
  });
});

describe("serving pictures", () => {
  test("each size has an address that never changes, so browsers keep it", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const uploaded = await withPicture(owner);
    const url = uploaded.srcset.split(", ")[0].split(" ")[0];
    const served = await made.app.request(url);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/webp");
    expect(served.headers.get("cache-control")).toContain("immutable");
    expect((await sharp(Buffer.from(await served.arrayBuffer())).metadata()).width).toBe(480);

    // A size it doesn't have leads to the nearest one it does.
    const missing = await made.app.request(url.replace("/480.webp", "/700.webp"));
    expect(missing.status).toBe(302);
    expect(missing.headers.get("location")).toMatch(/\/960\.webp$/);
    // So does a made-up name.
    const parts = url.split("/");
    parts[3] = "000000000000";
    expect((await made.app.request(parts.join("/"))).status).toBe(302);
    expect((await made.app.request("/media/not-an-id/x/480.webp")).status).toBe(404);
  });

  test("a size that's gone is made again from the original, as after a restore", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const uploaded = await withPicture(owner);
    const url: string = uploaded.srcset.split(", ")[1].split(" ")[0];
    expect(url).toMatch(/\/960\.webp$/);
    const before = Buffer.from(await (await made.app.request(url)).arrayBuffer());
    // Backups leave the sizes out, so after a restore there are none.
    const variants = join(made.uploadsDir, "variants");
    rmSync(variants, { recursive: true, force: true });

    // Two visitors at once: it's made once, and both get it.
    const [first, second] = await Promise.all([made.app.request(url), made.app.request(url)]);
    for (const served of [first, second]) {
      expect(served.status).toBe(200);
      expect(served.headers.get("content-type")).toBe("image/webp");
      // From the same original, made the same way, so it's the very file it was.
      expect(Buffer.from(await served.arrayBuffer()).equals(before)).toBe(true);
    }
    // And kept, so the next visitor doesn't wait for it.
    const kept = readdirSync(variants, { recursive: true }).map(String);
    expect(kept.filter((name) => name.endsWith("960.webp"))).toHaveLength(1);

    // With the original gone as well, there's nothing to make it from.
    rmSync(join(made.uploadsDir, "originals"), { recursive: true, force: true });
    expect((await made.app.request(url.replace("/960.webp", "/480.webp"))).status).toBe(404);
  });

  test("replacing a picture keeps its place, and old addresses lead to the new one", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const uploaded = await withPicture(owner);
    await owner.patch(`${MEDIA}/${uploaded.id}`, { alt: "The shop" });
    const replaced = await owner.upload(
      `${MEDIA}/${uploaded.id}/replace`,
      await png(800, 600, "#00aa00"),
      "Better.png",
    );
    expect(replaced.status).toBe(200);
    const after = await replaced.json();
    expect(after.id).toBe(uploaded.id);
    expect(after.alt).toBe("The shop");
    expect(after.width).toBe(800);
    expect(after.thumbUrl).not.toBe(uploaded.thumbUrl);

    const old = await made.app.request(uploaded.thumbUrl);
    expect(old.status).toBe(302);
    expect(old.headers.get("location")).toBe(after.thumbUrl);

    const pdf = await owner.upload(
      `${MEDIA}/${uploaded.id}/replace`,
      Buffer.from("%PDF-1.4"),
      "a.pdf",
    );
    expect((await pdf.json()).error.code).toBe("different_kind");
  });

  test("something in the Trash isn't shown, and comes back when restored", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const uploaded = await withPicture(owner);
    await owner.post(`${MEDIA}/${uploaded.id}/trash`, {});
    expect((await made.app.request(uploaded.thumbUrl)).status).toBe(404);
    const trash = await (await owner.get(`${MEDIA}?view=trash`)).json();
    expect(trash.media.map((item: { id: string }) => item.id)).toEqual([uploaded.id]);
    await owner.post(`${MEDIA}/${uploaded.id}/restore`, {});
    expect((await made.app.request(uploaded.thumbUrl)).status).toBe(200);
  });
});

describe("a nearly full disk", () => {
  test("loses its picture sizes first, which are made again when next asked for", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const uploaded = await withPicture(owner);
    const url: string = uploaded.srcset.split(", ")[0].split(" ")[0];
    expect((await made.app.request(url)).status).toBe(200);
    const store = new MediaStore(made.uploadsDir);
    const originals = readdirSync(join(made.uploadsDir, "originals"), { recursive: true });

    // 85% full is a warning in Settings, not yet a reason to clear anything.
    expect(clearSizesIfLow(store, { total: 100, free: 15 })).toBe(0);
    expect(existsSync(join(made.uploadsDir, "variants"))).toBe(true);

    expect(clearSizesIfLow(store, { total: 100, free: 10 })).toBeGreaterThan(0);
    expect(existsSync(join(made.uploadsDir, "variants"))).toBe(false);
    expect(readdirSync(join(made.uploadsDir, "originals"), { recursive: true })).toEqual(originals);
    expect((await made.app.request(url)).status).toBe(200);
    // With nothing left to clear, there's nothing more it can free.
    rmSync(join(made.uploadsDir, "variants"), { recursive: true, force: true });
    expect(clearSizesIfLow(store, { total: 100, free: 1 })).toBe(0);
  });
});

describe("pictures on pages", () => {
  test("a picture in a post becomes a responsive one, and the first loads straight away", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const first = await withPicture(owner);
    const second = await withPicture(owner);
    await owner.patch(`${MEDIA}/${first.id}`, { alt: 'Bread & "buns"', credit: "Photo: Sam" });
    await owner.patch(`${MEDIA}/${second.id}`, { decorative: true, alt: "Ignored" });
    await publish(owner, {
      doc: inDoc(image(first.id, { caption: "Fresh <today>", size: "wide" }), image(second.id)),
    });
    const html = await (await made.app.request("/blog/with-a-picture")).text();
    expect(html).toContain('<figure class="t-image t-size-wide">');
    expect(html).toContain('alt="Bread &amp; &quot;buns&quot;" fetchpriority="high"');
    expect(html).toContain(
      '<figcaption>Fresh &lt;today&gt; <span class="t-credit">Photo: Sam</span></figcaption>',
    );
    expect(html).toContain('width="1200" height="800"');
    expect(html).toMatch(
      /srcset="[^"]+480\.webp 480w, [^"]+960\.webp 960w, [^"]+1200\.webp 1200w"/,
    );
    expect(html).toContain('alt="" loading="lazy"');
    expect(html).not.toContain("tend-image");
  });

  test("changing a description in Media changes it on every page at once", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const uploaded = await withPicture(owner);
    await publish(owner, { doc: inDoc(image(uploaded.id)) });
    await owner.patch(`${MEDIA}/${uploaded.id}`, { alt: "Now described" });
    const html = await (await made.app.request("/blog/with-a-picture")).text();
    expect(html).toContain('alt="Now described"');
  });

  test("a picture moved to the Trash leaves the page, caption and all", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const uploaded = await withPicture(owner);
    await publish(owner, { doc: inDoc(image(uploaded.id, { caption: "Gone soon" })) });
    const trashed = await (await owner.post(`${MEDIA}/${uploaded.id}/trash`, {})).json();
    expect(trashed.uses).toEqual([
      expect.objectContaining({ title: "With a picture", url: "/blog/with-a-picture" }),
    ]);
    const html = await (await made.app.request("/blog/with-a-picture")).text();
    expect(html).not.toContain("Gone soon");
    expect(html).not.toContain("<figure");
  });

  test("what uses a picture is listed, and it can't be deleted while the site shows it", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const uploaded = await withPicture(owner);
    const post = await publish(owner, { featuredImage: { mediaId: uploaded.id, alt: null } });
    const usage = await (await owner.get(`${MEDIA}/${uploaded.id}/usage`)).json();
    expect(usage.uses).toEqual([
      {
        id: post.id,
        type: "post",
        title: "With a picture",
        url: "/blog/with-a-picture",
        inDraft: true,
      },
    ]);

    expect((await (await owner.delete(`${MEDIA}/${uploaded.id}`)).json()).error.code).toBe(
      "not_in_trash",
    );
    await owner.post(`${MEDIA}/${uploaded.id}/trash`, {});
    const blocked = await owner.delete(`${MEDIA}/${uploaded.id}`);
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).error.message).toContain('"With a picture"');

    await owner.post(`${ENTRIES}/${post.id}/unpublish`, {}, { "If-Match": String(post.rev) });
    expect((await owner.delete(`${MEDIA}/${uploaded.id}`)).status).toBe(204);
    expect((await owner.get(`${MEDIA}/${uploaded.id}`)).status).toBe(404);
    const uploads = join(made.uploadsDir, "variants");
    expect(existsSync(join(uploads, uploaded.id))).toBe(false);
    const originals = readdirSync(join(made.uploadsDir, "originals"), { recursive: true });
    expect(originals.some((name) => String(name).includes(uploaded.id))).toBe(false);
  });

  test("the logo and the picture for sharing count as uses, so they aren't deleted forever", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const uploaded = await withPicture(owner);
    const design = await (await owner.get("/api/admin/design")).json();
    await owner.put("/api/admin/design", { ...design.value, logoId: uploaded.id });
    await owner.put("/api/admin/settings/seo", { description: null, imageId: uploaded.id });
    const usage = await (await owner.get(`${MEDIA}/${uploaded.id}/usage`)).json();
    expect(usage.uses).toEqual([
      { id: "logo", type: "logo", title: "", url: "/", inDraft: false },
      { id: "share", type: "share", title: "", url: "/", inDraft: false },
    ]);

    const trashed = await (await owner.post(`${MEDIA}/${uploaded.id}/trash`, {})).json();
    expect(trashed.uses.map((use: { type: string }) => use.type)).toEqual(["logo", "share"]);
    const blocked = await owner.delete(`${MEDIA}/${uploaded.id}`);
    expect(blocked.status).toBe(409);
    const { error } = await blocked.json();
    expect(error.message).toBe(
      "Your site still uses this as the logo and the picture for sharing.",
    );
    expect(error.fix).toBe("Choose another picture in Design or Settings, then delete it.");

    await owner.put("/api/admin/design", { ...design.value, logoId: null });
    await owner.put("/api/admin/settings/seo", { description: null, imageId: null });
    expect((await owner.delete(`${MEDIA}/${uploaded.id}`)).status).toBe(204);
  });

  test("a picture used by the site and by pages says both, and what to do about each", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const uploaded = await withPicture(owner);
    const design = await (await owner.get("/api/admin/design")).json();
    await owner.put("/api/admin/design", { ...design.value, iconId: uploaded.id });
    await publish(owner, { featuredImage: { mediaId: uploaded.id, alt: null } });
    await owner.post(`${MEDIA}/${uploaded.id}/trash`, {});
    const { error } = await (await owner.delete(`${MEDIA}/${uploaded.id}`)).json();
    expect(error.message).toBe(
      'Your site still uses this as the site icon, and on "With a picture".',
    );
    expect(error.fix).toBe(
      "Choose another picture in Design or Settings, and take it out of those pages and publish them, then delete it.",
    );
  });

  test("a picture still uploading when the page saves is left out, not refused", () => {
    expect(renderDoc(inDoc(image("uploading-1")) as never).html).toBe("");
  });

  test("descriptions and captions are escaped in what's stored", () => {
    const { html } = renderDoc(
      inDoc(
        image("0193a0a0-0000-7000-8000-000000000001", {
          alt: '"><script>alert(1)</script>',
          caption: "<b>bold</b>",
          size: "huge",
        }),
      ) as never,
    );
    expect(html).toBe(
      '<tend-image data-id="0193a0a0-0000-7000-8000-000000000001" data-size="normal" data-alt="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;" data-caption="&lt;b&gt;bold&lt;/b&gt;"></tend-image>',
    );
  });
});
