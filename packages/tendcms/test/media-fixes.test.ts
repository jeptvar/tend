import { existsSync, readdirSync } from "node:fs";
import { crc32 } from "node:zlib";
import sharp from "sharp";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ApiError } from "../src/api/errors.ts";
import {
  deleteMediaForever,
  downloadName,
  getMedia,
  mediaHash,
  mediaUsage,
  replaceMedia,
  trashMedia,
} from "../src/media/library.ts";
import {
  checkUpload,
  memoryLimit,
  memoryPlan,
  processImage,
  sniff,
  widthsFor,
} from "../src/media/process.ts";
import { MediaStore } from "../src/media/store.ts";
import { makeApp, setUp } from "./auth-helpers.ts";

const MEDIA = "/api/admin/media";
const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

afterEach(() => {
  vi.restoreAllMocks();
});

function flat(width: number, height: number, background = "#336699", channels: 3 | 4 = 3) {
  return sharp({ create: { width, height, channels, background } });
}

async function png(width = 40, height = 30, background = "#336699"): Promise<Buffer> {
  return flat(width, height, background).png().toBuffer();
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

function refusal(work: () => unknown): ApiError {
  try {
    work();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

/** Every stored file under the uploads folder, as paths inside it. */
function storedFiles(uploadsDir: string): string[] {
  if (!existsSync(uploadsDir)) return [];
  return readdirSync(uploadsDir, { recursive: true })
    .map(String)
    .filter((path) => /\.(png|webp|jpg|gif|avif|pdf)$/.test(path))
    .sort();
}

/** How many codes of each length a JPEG's Huffman tables have, in the order they're stored. */
function huffmanTables(jpeg: Buffer): number[][] {
  const tables: number[][] = [];
  let offset = 2;
  while (offset + 4 <= jpeg.length && jpeg[offset] === 0xff) {
    const marker = jpeg[offset + 1];
    const length = jpeg.readUInt16BE(offset + 2);
    if (marker === 0xda) break;
    if (marker === 0xc4) {
      for (let at = offset + 4; at < offset + 2 + length; ) {
        const counts = [...jpeg.subarray(at + 1, at + 17)];
        tables.push(counts);
        at += 17 + counts.reduce((sum, count) => sum + count, 0);
      }
    }
    offset += 2 + length;
  }
  return tables;
}

/** An animated GIF whose frames are each one pixel, built byte by byte. */
function tinyFramesGif(frames: number): Buffer {
  const parts: Buffer[] = [
    Buffer.from("GIF89a"),
    Buffer.from([1, 0, 1, 0, 0x80, 0, 0]),
    Buffer.from([0, 0, 0, 255, 255, 255]),
    Buffer.from([0x21, 0xff, 0x0b, ...Buffer.from("NETSCAPE2.0"), 3, 1, 0, 0, 0]),
  ];
  for (let frame = 0; frame < frames; frame++) {
    parts.push(Buffer.from([0x21, 0xf9, 4, 0, 2, 0, 0, 0]));
    parts.push(Buffer.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0]));
    // Clear, one colour index, end: three-bit codes, low bits first.
    const bits = 4 | ((frame & 1) << 3) | (5 << 6);
    parts.push(Buffer.from([2, 2, bits & 0xff, (bits >> 8) & 0xff, 0]));
  }
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}

describe("media-1: pictures are prepared within the memory the server has", () => {
  test("the memory limit comes from the container when there is one, never above the computer's", () => {
    const files = (entries: Record<string, string>) => (path: string) => entries[path];
    const total = 16 * GiB;
    expect(memoryLimit(files({}), total)).toBe(total);
    // cgroup v2, as in Docker
    expect(
      memoryLimit(
        files({ "/proc/self/cgroup": "0::/\n", "/sys/fs/cgroup/memory.max": "536870912\n" }),
        total,
      ),
    ).toBe(512 * MiB);
    expect(memoryLimit(files({ "/sys/fs/cgroup/memory.max": "max\n" }), total)).toBe(total);
    // A service of its own, limited by systemd
    expect(
      memoryLimit(
        files({
          "/proc/self/cgroup": "0::/system.slice/tend.service\n",
          "/sys/fs/cgroup/system.slice/tend.service/memory.max": "268435456\n",
        }),
        total,
      ),
    ).toBe(256 * MiB);
    // cgroup v1, unlimited and limited
    expect(
      memoryLimit(
        files({ "/sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712\n" }),
        total,
      ),
    ).toBe(total);
    expect(
      memoryLimit(files({ "/sys/fs/cgroup/memory/memory.limit_in_bytes": "1073741824" }), total),
    ).toBe(GiB);
    expect(memoryLimit(files({ "/sys/fs/cgroup/memory.max": `${64 * GiB}` }), 8 * GiB)).toBe(
      8 * GiB,
    );
  });

  test("a small server prepares one picture at a time, on one thread, within half its memory", () => {
    const small = memoryPlan(512 * MiB);
    expect(small).toEqual({ budget: 136 * MiB, atOnce: 1, oneThread: true });
    expect(memoryPlan(GiB)).toMatchObject({ budget: 392 * MiB, atOnce: 1, oneThread: true });
    expect(memoryPlan(8 * GiB)).toMatchObject({ atOnce: 2, oneThread: false });
    // Even a tiny one can still take ordinary photos.
    expect(memoryPlan(256 * MiB).budget).toBeGreaterThanOrEqual(64 * MiB);
  });

  test("an AVIF too big for a 512 MB server is refused, naming the limit, before it's decoded", async () => {
    const avif = await flat(3000, 2000).avif({ effort: 0 }).toBuffer();
    const decoded = vi.spyOn(sharp.prototype, "toBuffer");
    const error = await refusalOf(() => processImage(avif, "avif", { memoryLimit: 512 * MiB }));
    expect(error.status).toBe(413);
    expect(error.code).toBe("too_big_for_server");
    expect(error.message).toMatch(
      /^That picture is too big for this server to prepare\. Here, an AVIF like this one can be up to \d+(\.\d)? megapixels\.$/,
    );
    expect(error.details.fix).toMatch(
      /^Make it smaller first, for example by exporting it [\d,]+ pixels wide or less\./,
    );
    expect(error.details.fix).toMatch(/Or save it as a JPEG/);
    expect(decoded).not.toHaveBeenCalled();
    // A bigger server takes it.
    const done = await processImage(avif, "avif", { memoryLimit: 4 * GiB });
    expect([done.width, done.height]).toEqual([3000, 2000]);
  });

  test("a picture with see-through parts isn't told to become a JPEG", async () => {
    const logo = await flat(2400, 2400, "#336699", 4).ensureAlpha(0.5).png().toBuffer();
    const error = await refusalOf(() => processImage(logo, "png", { memoryLimit: 512 * MiB }));
    expect(error.code).toBe("too_big_for_server");
    expect(error.message).toMatch(/a PNG like this one can be up to/);
    expect(error.details.fix).not.toMatch(/JPEG/);
  });

  test("an animation too big for a small server says so, counting every frame", async () => {
    // Each frame a different colour, or the encoder would merge them into one.
    const frames = await sharp({
      create: { width: 1500, height: 1500 * 8, channels: 3, background: "#000000" },
    })
      .composite(
        Array.from({ length: 8 }, (_, frame) => ({
          input: {
            create: {
              width: 1500,
              height: 1500,
              channels: 3,
              background: `hsl(${frame * 40}, 60%, 50%)`,
            },
          },
          left: 0,
          top: frame * 1500,
        })),
      )
      .raw()
      .toBuffer();
    const gif = await sharp(frames, {
      raw: { width: 1500, height: 1500 * 8, channels: 3, pageHeight: 1500 },
    })
      .gif()
      .toBuffer();
    const error = await refusalOf(() => processImage(gif, "gif", { memoryLimit: 512 * MiB }));
    expect(error.code).toBe("too_big_for_server");
    expect(error.message).toMatch(
      /^That animation is too big for this server to prepare\. Here, a GIF animation like this one can be up to [\d.]+ megapixels, counting every frame\.$/,
    );
    expect(error.details.fix).toMatch(/smaller or shorter/);
  });

  test("a 49 megapixel JPEG still fits a 512 MB server, because it's never held whole", async () => {
    const jpeg = await flat(7000, 7000).jpeg({ quality: 80 }).toBuffer();
    const done = await processImage(jpeg, "jpeg", { memoryLimit: 512 * MiB });
    expect([done.width, done.height]).toEqual([7000, 7000]);
    expect(done.variants.map((variant) => variant.width)).toEqual([480, 960, 1600, 2400]);
    // Written with the standard tables, a strip at a time. Optimised tables would mean
    // libjpeg kept every coefficient of the picture in memory at once.
    expect(huffmanTables(done.original)[0]).toEqual([
      0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0,
    ]);
  });

  test("so does a phone photo taken upright, which has to be turned", async () => {
    const photo = await flat(4032, 3024).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const done = await processImage(photo, "jpeg", { memoryLimit: 512 * MiB });
    expect([done.width, done.height]).toEqual([3024, 4032]);
  });

  test("a WebP too big for a small server is refused from its first bytes too", async () => {
    const webp = await flat(4000, 4000).webp({ quality: 10 }).toBuffer();
    const headers = vi.spyOn(sharp.prototype, "metadata");
    const error = await refusalOf(() => processImage(webp, "webp", { memoryLimit: 512 * MiB }));
    expect(error.code).toBe("too_big_for_server");
    expect(error.message).toMatch(/a WebP like this one/);
    expect(headers).not.toHaveBeenCalled();
  });

  test("a huge WebP is refused from its first bytes, before sharp sets memory aside for it", async () => {
    // Just reading a WebP's size, sharp sets aside 4 bytes for every pixel: 1 GB for this
    // one, which a real file of under 500 KB can claim.
    const header = Buffer.alloc(30);
    header.write("RIFF", 0, "latin1");
    header.writeUInt32LE(22, 4);
    header.write("WEBPVP8X", 8, "latin1");
    header.writeUInt32LE(10, 16);
    header.writeUIntLE(16000 - 1, 24, 3);
    header.writeUIntLE(16000 - 1, 27, 3);
    expect(checkUpload("huge.webp", header)).toEqual({ kind: "image", format: "webp" });
    const headers = vi.spyOn(sharp.prototype, "metadata");
    const error = await processImage(header, "webp").catch((caught: unknown) => caught);
    expect(headers).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("too_many_pixels");
  });
});

describe("media-2: a file pretending to be an AVIF", () => {
  test("an SVG behind an AVIF-looking start is refused, not drawn on the server", async () => {
    const disguised = Buffer.from(
      '<!--ftypavif    mif1--><svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="100%" height="100%" fill="#c00"/></svg>',
    );
    // Round 2: an AVIF has to start with a real ftyp box, so this is an SVG from its first
    // bytes, and refused as one before sharp sees it.
    expect(refusal(() => checkUpload("pattern.avif", disguised)).code).toBe("svg_file");
    const drawn = vi.spyOn(sharp.prototype, "toBuffer");
    const read = vi.spyOn(sharp.prototype, "metadata");
    const error = await refusalOf(() => processImage(disguised, "avif"));
    expect(error.code).toBe("svg_file");
    expect(error.status).toBe(415);
    expect(drawn).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  test("a real AVIF is still taken", async () => {
    const avif = await flat(64, 48).avif({ effort: 0 }).toBuffer();
    const done = await processImage(avif, "avif");
    expect(done.ext).toBe("avif");
    expect([done.width, done.height]).toEqual([64, 48]);
  });
});

describe("media-3: replacing a picture with the same picture", () => {
  test("a failed write never removes the files pages are using", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const data = await png(1300, 800);
    const item = await (await owner.upload(MEDIA, data, "Shop.png")).json();
    const before = storedFiles(made.uploadsDir);

    class FullDisk extends MediaStore {
      writes = 0;
      override write(path: string, bytes: Buffer): void {
        this.writes++;
        if (this.writes === 3) {
          throw Object.assign(new Error("ENOSPC: no space left on device, write"), {
            code: "ENOSPC",
          });
        }
        super.write(path, bytes);
      }
    }
    await expect(
      replaceMedia(made.orm, new FullDisk(made.uploadsDir), {
        id: item.id,
        name: "Shop.png",
        data,
        now: made.clock.time,
      }),
    ).rejects.toThrow(/ENOSPC/);
    expect(storedFiles(made.uploadsDir)).toEqual(before);
    expect((await made.app.request(item.thumbUrl)).status).toBe(200);
    expect((await made.app.request(item.url)).status).toBe(200);
  });
});

describe("media-4: pictures with see-through parts", () => {
  async function logo(fill: string): Promise<Buffer> {
    const mark = await flat(240, 50, fill, 4).png().toBuffer();
    return sharp({
      create: { width: 400, height: 120, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([{ input: mark, left: 80, top: 35 }])
      .png()
      .toBuffer();
  }

  test("a transparent logo gets no colour behind it", async () => {
    expect((await processImage(await logo("#1a2b5c"), "png")).dominantColor).toBeNull();
    expect((await processImage(await logo("#ffffff"), "png")).dominantColor).toBeNull();
  });

  test("a picture with an alpha channel but no see-through pixels keeps its colour", async () => {
    const opaque = await flat(200, 100, "#cc3300", 4).png().toBuffer();
    expect((await processImage(opaque, "png")).dominantColor).toMatch(/^#[0-9a-f]{6}$/);
  });

  test("an uploaded transparent logo is stored with no colour", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const reply = await owner.upload(MEDIA, await logo("#1a2b5c"), "logo.png");
    expect((await reply.json()).dominantColor).toBeNull();
  });
});

describe("media-5: names with odd endings", () => {
  test("JPEGs named .jfif and the other JPEG endings are taken", async () => {
    const jpeg = await flat(40, 30).jpeg().toBuffer();
    for (const name of ["photo.jfif", "photo.jpe", "photo.jif", "photo.pjpeg", "photo.pjp"]) {
      expect(checkUpload(name, jpeg)).toEqual({ kind: "image", format: "jpeg" });
    }
  });

  test("a dot in a name without an ending isn't taken for one", async () => {
    const pdf = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
    expect(checkUpload("Menu v2.1", pdf)).toEqual({ kind: "file", format: "pdf" });
    expect(checkUpload("Screenshot 2026-11-15 at 10.30.45", await png())).toEqual({
      kind: "image",
      format: "png",
    });
    expect(checkUpload("Dr. Seuss", await png())).toEqual({ kind: "image", format: "png" });
  });

  test("a name that says it's some other kind of file is still refused", async () => {
    const picture = await png();
    expect(refusal(() => checkUpload("run.exe", Buffer.from("%PDF-1.4"))).code).toBe(
      "unsupported_file",
    );
    expect(refusal(() => checkUpload("notes.txt", Buffer.from("hello"))).code).toBe(
      "unsupported_file",
    );
    expect(refusal(() => checkUpload("page.html", picture)).code).toBe("unsupported_file");
    expect(refusal(() => checkUpload("archive.tar.gz", picture)).code).toBe("unsupported_file");
  });

  test("a .jfif photo uploads", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const reply = await owner.upload(MEDIA, await flat(40, 30).jpeg().toBuffer(), "photo.jfif");
    expect(reply.status).toBe(201);
    expect((await reply.json()).url).toMatch(/\/photo\.jpg$/);
  });
});

describe("media-6: animations with very many frames", () => {
  test("an animation with over 1,000 frames is refused quickly, saying what to do", async () => {
    const gif = tinyFramesGif(1001);
    expect(checkUpload("many.gif", gif)).toEqual({ kind: "image", format: "gif" });
    const started = performance.now();
    const error = await refusalOf(() => processImage(gif, "gif"));
    expect(performance.now() - started).toBeLessThan(2000);
    expect(error.status).toBe(413);
    expect(error.code).toBe("too_many_frames");
    expect(error.message).toContain("1,000");
    expect(error.details.fix).toMatch(/shorter/);
  });

  test("an animation with 1,000 frames is taken", async () => {
    const done = await processImage(tinyFramesGif(1000), "gif");
    expect([done.width, done.height]).toEqual([1, 1]);
  });
});

describe("media-7 and media-10: an original named like a size or an icon", () => {
  test("its download name never matches a size's or an icon's", () => {
    expect(downloadName({ originalName: "Icon 512.png", ext: "png" })).toBe(
      "icon-512-original.png",
    );
    expect(downloadName({ originalName: "icon-192.png", ext: "png" })).toBe(
      "icon-192-original.png",
    );
    expect(downloadName({ originalName: "960.webp", ext: "webp" })).toBe("960-original.webp");
    expect(downloadName({ originalName: "2.webp", ext: "webp" })).toBe("2-original.webp");
    expect(downloadName({ originalName: "123456.webp", ext: "webp" })).toBe("123456-original.webp");
    // Only those: other names are as they were.
    expect(downloadName({ originalName: "Photo.png", ext: "png" })).toBe("photo.png");
    expect(downloadName({ originalName: "2024.jpg", ext: "jpg" })).toBe("2024.jpg");
    expect(downloadName({ originalName: "icon-32.jpg", ext: "jpg" })).toBe("icon-32.jpg");
  });

  test("its own address gives the file as uploaded", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const icon = await (await owner.upload(MEDIA, await png(64, 64), "icon-32.png")).json();
    const served = await made.app.request(icon.url);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-disposition")).toContain("icon-32-original.png");
    // A picture shows in the browser. Only other files, like PDFs, are saved instead.
    expect(served.headers.get("content-disposition")).toMatch(/^inline;/);
    const iconMeta = await sharp(Buffer.from(await served.arrayBuffer())).metadata();
    expect([iconMeta.width, iconMeta.height]).toEqual([64, 64]);

    const webp = await flat(1000, 600).webp().toBuffer();
    const size = await (await owner.upload(MEDIA, webp, "480.webp")).json();
    const original = await made.app.request(size.url);
    expect(original.status).toBe(200);
    expect((await sharp(Buffer.from(await original.arrayBuffer())).metadata()).width).toBe(1000);
  });
});

describe("media-8: very tall pictures", () => {
  test("each size fits inside WebP's 16,383 pixels, and says its real width", () => {
    expect(widthsFor(1440, 16384)).toEqual([480, 960, 1439]);
    expect(widthsFor(2400, 16400)).toEqual([480, 960, 1600, 2397]);
    expect(widthsFor(1000, 1000)).toEqual([480, 960, 1000]);
    expect(widthsFor(3000)).toEqual([480, 960, 1600, 2400]);
  });

  test("a long screenshot is taken, with sizes WebP can hold", async () => {
    const tall = await flat(1440, 16384).png({ compressionLevel: 1 }).toBuffer();
    const done = await processImage(tall, "png");
    expect([done.width, done.height]).toEqual([1440, 16384]);
    expect(done.variants.map((variant) => variant.width)).toEqual([480, 960, 1439]);
    for (const variant of done.variants) {
      const meta = await sharp(variant.data).metadata();
      expect(meta.width).toBe(variant.width);
      expect(meta.height).toBeLessThanOrEqual(16383);
    }
  });

  test("a picture too long and thin for any size says so, and how to fix it", async () => {
    const thread = await flat(2, 40000).png().toBuffer();
    const error = await refusalOf(() => processImage(thread, "png"));
    expect(error.code).toBe("too_long");
    expect(error.status).toBe(413);
    expect(error.details.fix).toMatch(/[Cc]rop/);
  });
});

describe("media-9: long file names", () => {
  const pdf = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
  const longName =
    "Smith, J. et al. (2024). A study of sourdough fermentation in small bakeries and its effects on crumb structure, flavour development and shelf life across three seasons of production in the Philippines - final version.pdf";

  test("a long name keeps its ending, so the upload is taken", async () => {
    expect(longName.length).toBeGreaterThan(200);
    const made = await makeApp();
    const owner = await setUp(made);
    const reply = await owner.upload(MEDIA, pdf, longName);
    expect(reply.status).toBe(201);
    const file = await reply.json();
    expect(file.name.endsWith(".pdf")).toBe(true);
    expect([...file.name].length).toBeLessThanOrEqual(200);
    expect(file.name.startsWith("Smith, J. et al.")).toBe(true);

    const replaced = await owner.upload(`${MEDIA}/${file.id}/replace`, pdf, longName);
    expect(replaced.status).toBe(200);
  });

  test("shortening never cuts a character in half", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const picture = await png();
    // 200 characters, counting the emoji as one, so nothing is cut.
    const exact = `${"a".repeat(199)}\u{1F600}`;
    const kept = await (await owner.upload(MEDIA, picture, exact)).json();
    expect(kept.name).toBe(exact);
    // Too long, with the cut falling where the emoji is.
    const reply = await owner.upload(MEDIA, picture, `${"a".repeat(195)}\u{1F600}bcdefgh.png`);
    expect(reply.status).toBe(201);
    const { name } = await reply.json();
    expect(name.isWellFormed()).toBe(true);
    expect(name).toBe(`${"a".repeat(195)}\u{1F600}.png`);
  });
});

describe("media-11: replacing while something else changes the same picture", () => {
  test("two replaces at once leave only the files of the one that's kept", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const item = await (await owner.upload(MEDIA, await png(1000, 700), "A.png")).json();
    const store = new MediaStore(made.uploadsDir);
    const results = await Promise.allSettled([
      replaceMedia(made.orm, store, {
        id: item.id,
        name: "B.png",
        data: await png(1100, 700, "#aa0000"),
        now: made.clock.time,
      }),
      replaceMedia(made.orm, store, {
        id: item.id,
        name: "C.png",
        data: await png(1200, 700, "#00aa00"),
        now: made.clock.time,
      }),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    const row = await getMedia(made.orm, item.id);
    const hash = mediaHash(row as NonNullable<typeof row>);
    const files = storedFiles(made.uploadsDir);
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((path) => path.includes(hash))).toBe(true);
  });

  test("deleting forever during a replace leaves nothing behind", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const item = await (await owner.upload(MEDIA, await png(1000, 700), "A.png")).json();
    await trashMedia(made.orm, { id: item.id, now: made.clock.time });
    const store = new MediaStore(made.uploadsDir);
    const replacing = replaceMedia(made.orm, store, {
      id: item.id,
      name: "B.png",
      data: await png(2600, 1700, "#aa0000"),
      now: made.clock.time,
    });
    await deleteMediaForever(made.orm, store, { id: item.id });
    const error = await refusalOf(() => replacing);
    expect(error.status).toBe(404);
    expect(await getMedia(made.orm, item.id)).toBeUndefined();
    expect(storedFiles(made.uploadsDir)).toEqual([]);
  });

  test("a replace finishing while Delete forever looks up the uses leaves nothing behind", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const item = await (await owner.upload(MEDIA, await png(1000, 700), "A.png")).json();
    await trashMedia(made.orm, { id: item.id, now: made.clock.time });
    const store = new MediaStore(made.uploadsDir);
    const before = await getMedia(made.orm, item.id);
    const next = await processImage(await png(1100, 700, "#aa0000"), "png");
    const nextHash = next.sha256.slice(0, 12);

    // Delete forever reads the picture straight away, then waits while it looks up uses...
    const deleting = deleteMediaForever(made.orm, store, { id: item.id });
    // ...and meanwhile a replace finishes: its files are written, the row points at them, and
    // the old version goes.
    store.write(store.originalPath(item.id, nextHash, "png"), next.original);
    for (const variant of next.variants) {
      store.write(store.variantPath(item.id, nextHash, `${variant.width}.webp`), variant.data);
    }
    made.db
      .prepare("UPDATE media SET sha256 = ?, variants = ? WHERE id = ?")
      .run(next.sha256, JSON.stringify(next.variants.map((variant) => variant.width)), item.id);
    store.removeVersion(item.id, mediaHash(before as NonNullable<typeof before>), "png");
    await deleting;

    expect(await getMedia(made.orm, item.id)).toBeUndefined();
    expect(storedFiles(made.uploadsDir)).toEqual([]);
  });

  test("a picture brought back from the Trash while it was being deleted forever stays", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const item = await (await owner.upload(MEDIA, await png(1000, 700), "A.png")).json();
    await trashMedia(made.orm, { id: item.id, now: made.clock.time });
    const files = storedFiles(made.uploadsDir);
    const deleting = deleteMediaForever(made.orm, new MediaStore(made.uploadsDir), {
      id: item.id,
    });
    made.db.prepare("UPDATE media SET trashed_at = NULL WHERE id = ?").run(item.id);
    const error = await refusalOf(() => deleting);
    expect(error.code).toBe("not_in_trash");
    expect(await getMedia(made.orm, item.id)).toBeDefined();
    expect(storedFiles(made.uploadsDir)).toEqual(files);
  });
});

describe("files linked from the site menu", () => {
  const pdf = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

  function link(id: string, url: string, children: unknown[] = []) {
    return { id, label: "Menu", target: { type: "url", url }, children };
  }

  test("a menu link to a file is one use, and it can't be deleted forever until it's gone", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const file = await (await owner.upload(MEDIA, pdf, "Lunch menu.pdf")).json();
    const other = await (await owner.upload(MEDIA, pdf, "Other.pdf")).json();

    const main = await owner.put("/api/admin/menus/main", {
      items: [link("a", file.url), link("b", "/blog")],
    });
    expect(main.status).toBe(200);
    // The same file again, by its full address, under another link in the footer.
    const footer = await owner.put("/api/admin/menus/footer", {
      items: [link("c", "/about", [link("d", `http://localhost${file.url}?download=1`)])],
    });
    expect(footer.status).toBe(200);

    const usage = await (await owner.get(`${MEDIA}/${file.id}/usage`)).json();
    expect(usage.uses).toEqual([{ id: "menu", type: "menu", title: "", url: "/", inDraft: false }]);
    expect(await mediaUsage(made.orm, other.id)).toEqual([]);

    await owner.post(`${MEDIA}/${file.id}/trash`, {});
    const blocked = await owner.delete(`${MEDIA}/${file.id}`);
    expect(blocked.status).toBe(409);
    const { error } = await blocked.json();
    expect(error.message).toBe("Your site still uses this as a link in the site menu.");
    expect(error.fix).toBe("Take the link out of the Site menu, then delete it.");

    await owner.put("/api/admin/menus/main", { items: [link("b", "/blog")] });
    expect((await owner.delete(`${MEDIA}/${file.id}`)).status).toBe(409);
    await owner.put("/api/admin/menus/footer", { items: [] });
    expect((await owner.delete(`${MEDIA}/${file.id}`)).status).toBe(204);
  });

  test("a menu link with the file's ID written as %-codes is a use too, as it is on a page", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const file = await (await owner.upload(MEDIA, pdf, "Lunch menu.pdf")).json();
    const first = file.id.charCodeAt(0).toString(16);
    const encoded = file.url.replace(`/media/${file.id[0]}`, `/media/%${first}`);
    expect(encoded).not.toBe(file.url);
    const put = await owner.put("/api/admin/menus/main", { items: [link("a", encoded)] });
    expect(put.status).toBe(200);
    expect((await mediaUsage(made.orm, file.id)).map((use) => use.type)).toEqual(["menu"]);
    // An address that only has the ID in it somewhere else isn't a link to the file.
    await owner.put("/api/admin/menus/main", {
      items: [link("a", `/blog/media/${file.id}/x/lunch-menu.pdf`)],
    });
    expect(await mediaUsage(made.orm, file.id)).toEqual([]);
  });

  test("the menu comes after the site's own pictures", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const picture = await (await owner.upload(MEDIA, await png(600, 200), "Logo.png")).json();
    const design = await (await owner.get("/api/admin/design")).json();
    await owner.put("/api/admin/design", { ...design.value, logoId: picture.id });
    await owner.put("/api/admin/menus/main", { items: [link("a", picture.url)] });
    const uses = await mediaUsage(made.orm, picture.id);
    expect(uses.map((use) => use.type)).toEqual(["logo", "menu"]);

    await owner.post(`${MEDIA}/${picture.id}/trash`, {});
    const { error } = await (await owner.delete(`${MEDIA}/${picture.id}`)).json();
    expect(error.message).toBe(
      "Your site still uses this as the logo and a link in the site menu.",
    );
    expect(error.fix).toBe(
      "Choose another picture in Design or Settings, and take the link out of the Site menu, then delete it.",
    );
  });
});

describe("media-1: on a small host", () => {
  test("libvips gets one thread when the module loads on a server under 2 GB", async () => {
    vi.resetModules();
    vi.doMock("node:os", async (original) => {
      const actual = await original<typeof import("node:os")>();
      const small = { ...actual, totalmem: () => 512 * MiB };
      return { ...small, default: small };
    });
    const before = sharp.concurrency();
    try {
      await import("../src/media/process.ts");
      expect(sharp.concurrency()).toBe(1);
    } finally {
      sharp.concurrency(before);
      vi.doUnmock("node:os");
    }
  });
});

// Round 2

/** An animated WebP whose frames are each one pixel, on a square canvas, built chunk by chunk. */
async function tinyFramesWebp(frames: number, side = 1): Promise<Buffer> {
  // One pixel from sharp, as a lossless WebP: its "VP8L" chunk is every frame's picture.
  const pixel = (await flat(1, 1).webp({ lossless: true }).toBuffer()).subarray(12);
  const chunk = (kind: string, body: Buffer) => {
    const head = Buffer.alloc(8);
    head.write(kind, 0, "latin1");
    head.writeUInt32LE(body.length, 4);
    return Buffer.concat([head, body, Buffer.alloc(body.length % 2)]);
  };
  const canvas = Buffer.alloc(10);
  canvas[0] = 0x02;
  canvas.writeUIntLE(side - 1, 4, 3);
  canvas.writeUIntLE(side - 1, 7, 3);
  const placement = Buffer.alloc(16);
  placement.writeUIntLE(20, 12, 3);
  const frame = chunk("ANMF", Buffer.concat([placement, pixel]));
  const body = Buffer.concat([
    Buffer.from("WEBP"),
    chunk("VP8X", canvas),
    chunk("ANIM", Buffer.alloc(6)),
    ...Array.from({ length: frames }, () => frame),
  ]);
  const riff = Buffer.alloc(8);
  riff.write("RIFF", 0, "latin1");
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

/**
 * The first bytes of a WebP with an extended header: its canvas size, and whether it has
 * see-through parts. Nothing after them is read before a picture too big is refused.
 */
function extendedWebpStart(width: number, height: number, seeThrough: boolean): Buffer {
  const start = Buffer.alloc(30);
  start.write("RIFF", 0, "latin1");
  start.writeUInt32LE(22, 4);
  start.write("WEBPVP8X", 8, "latin1");
  start.writeUInt32LE(10, 16);
  start[20] = seeThrough ? 0x10 : 0;
  start.writeUIntLE(width - 1, 24, 3);
  start.writeUIntLE(height - 1, 27, 3);
  return start;
}

/**
 * A small 16-bit PNG from sharp, stored with this orientation, whose header then claims it's
 * width by height. The header is all that's read of a picture too big to be prepared.
 */
async function sixteenBitPngClaiming(width: number, height: number, orientation: number) {
  const png = await flat(8, 8)
    .toColourspace("rgb16")
    .png()
    .withMetadata({ orientation })
    .toBuffer();
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  png.writeUInt32BE(crc32(png.subarray(12, 29)), 29);
  return png;
}

/** A logo on a see-through background, as a WebP. */
async function transparentWebp(side: number): Promise<Buffer> {
  const mark = await flat(Math.round(side * 0.6), Math.round(side * 0.3), "#1a2b5c", 4)
    .png()
    .toBuffer();
  return sharp({
    create: { width: side, height: side, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: mark, left: Math.round(side * 0.2), top: Math.round(side * 0.35) }])
    .webp({ quality: 90 })
    .toBuffer();
}

describe("media-1, round 2: a picture stored upside down is counted whole", () => {
  test("turning one upside down needs all of it, so it's refused before it's decoded", async () => {
    // 49 megapixels at 16 bits a colour: about 370 MB to turn, on a server with 136 MiB.
    const upsideDown = await sixteenBitPngClaiming(7000, 7000, 3);
    const flipped = await sixteenBitPngClaiming(7000, 7000, 4);
    const meta = await sharp(upsideDown).metadata();
    expect([meta.width, meta.height, meta.depth, meta.orientation]).toEqual([
      7000,
      7000,
      "ushort",
      3,
    ]);
    const decoded = vi.spyOn(sharp.prototype, "toBuffer");
    for (const picture of [upsideDown, flipped]) {
      const error = await refusalOf(() => processImage(picture, "png", { memoryLimit: 512 * MiB }));
      expect(error.code).toBe("too_big_for_server");
    }
    expect(decoded).not.toHaveBeenCalled();
  });

  test("an upside-down 49 megapixel JPEG is refused on a small server, and a smaller one is taken", async () => {
    const upsideDown = (width: number, height: number) =>
      flat(width, height).jpeg({ quality: 80 }).withMetadata({ orientation: 3 }).toBuffer();
    const error = await refusalOf(async () =>
      processImage(await upsideDown(7000, 7000), "jpeg", { memoryLimit: 512 * MiB }),
    );
    expect(error.code).toBe("too_big_for_server");
    expect(error.message).toMatch(/a JPEG like this one can be up to \d+ megapixels\.$/);
    const done = await processImage(await upsideDown(3000, 2000), "jpeg", {
      memoryLimit: 512 * MiB,
    });
    expect([done.width, done.height]).toEqual([3000, 2000]);
  });

  test("an AVIF of more than 8 bits a colour counts the extra bytes", async () => {
    const avif = (bitdepth: 8 | 12) => flat(1460, 1095).avif({ effort: 0, bitdepth }).toBuffer();
    const deep = await avif(12);
    expect((await sharp(deep).metadata()).depth).toBe("ushort");
    const error = await refusalOf(() => processImage(deep, "avif", { memoryLimit: 512 * MiB }));
    expect(error.code).toBe("too_big_for_server");
    const done = await processImage(await avif(8), "avif", { memoryLimit: 512 * MiB });
    expect(done.width).toBe(1460);
  });

  test("a still GIF counts what its encoder keeps while the sizes are made", async () => {
    // A noisy one this size used 149 MB, more than a 512 MB server has for pictures. Only its
    // header is read before it's refused, so this one is just that: a GIF from sharp would
    // also have a see-through colour, which is counted differently.
    const le = (value: number) => [value & 0xff, value >> 8];
    const gif = Buffer.concat([
      Buffer.from("GIF89a"),
      Buffer.from([...le(1800), ...le(1333), 0x80, 0, 0, 0, 0, 0, 255, 255, 255]),
      Buffer.from([0x2c, 0, 0, 0, 0, ...le(1800), ...le(1333), 0]),
      Buffer.from([2, 1, 4 | (5 << 3), 0, 0x3b]),
    ]);
    const meta = await sharp(gif).metadata();
    expect([meta.width, meta.height, meta.hasAlpha]).toEqual([1800, 1333, false]);
    const error = await refusalOf(() => processImage(gif, "gif", { memoryLimit: 512 * MiB }));
    expect(error.code).toBe("too_big_for_server");
    expect(error.message).toMatch(/a GIF like this one can be up to [\d.]+ megapixels\.$/);
  });

  test("an animated WebP counts every frame, from its first bytes", async () => {
    // 150 frames on a 400 pixel square: one like it used 142 MB.
    const webp = await tinyFramesWebp(150, 400);
    const read = vi.spyOn(sharp.prototype, "metadata");
    const error = await refusalOf(() => processImage(webp, "webp", { memoryLimit: 512 * MiB }));
    expect(read).not.toHaveBeenCalled();
    expect(error.code).toBe("too_big_for_server");
    expect(error.message).toMatch(/^That animation is too big .* counting every frame\.$/);
  });

  test("a mirror image is still fixed a strip at a time, so it still fits", async () => {
    const mirrored = await flat(7000, 7000)
      .jpeg({ quality: 80 })
      .withMetadata({ orientation: 2 })
      .toBuffer();
    const done = await processImage(mirrored, "jpeg", { memoryLimit: 512 * MiB });
    expect([done.width, done.height]).toEqual([7000, 7000]);
  });
});

describe("media-2, round 2: libvips reads only the kinds Tend takes", () => {
  test("a 16.8 MB SVG behind an AVIF-looking start is refused from its first bytes", async () => {
    const rects = '<rect width="1" height="1"/>'.repeat(600_000);
    const big = Buffer.from(
      `<!--ftypavif    mif1--><svg xmlns="http://www.w3.org/2000/svg" width="300" height="300">${rects}</svg>`,
    );
    expect(big.length).toBeGreaterThan(16_000_000);
    const read = vi.spyOn(sharp.prototype, "metadata");
    const error = refusal(() => checkUpload("pattern.avif", big));
    expect(error.status).toBe(415);
    expect(error.code).toBe("svg_file");
    expect((await refusalOf(() => processImage(big, "avif"))).code).toBe("svg_file");
    expect(read).not.toHaveBeenCalled();
  });

  test("an AVIF has to start with a real ftyp box", async () => {
    const box = (size: number) =>
      Buffer.concat([
        Buffer.from([0, 0, 0, size]),
        Buffer.from("ftypavif"),
        Buffer.alloc(4),
        Buffer.from("mif1avif"),
      ]);
    expect(sniff(box(24))).toEqual({ kind: "image", format: "avif" });
    expect(sniff(await flat(8, 8).avif({ effort: 0 }).toBuffer())).toEqual({
      kind: "image",
      format: "avif",
    });
    // Too small to be a box, or text that only looks like one.
    expect(sniff(box(8))).toBeUndefined();
    expect(sniff(Buffer.from("<!--ftypavif    mif1-->"))).toBeUndefined();
    // An SVG after comments or a doctype is still an SVG.
    expect(sniff(Buffer.from("<!-- made by hand -->\n<svg/>"))).toEqual({ kind: "svg" });
    expect(sniff(Buffer.from('<!DOCTYPE svg [<!ENTITY a "x">]><svg/>'))).toEqual({
      kind: "svg",
    });
    expect(sniff(Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from("<svg/>")]))).toEqual({
      kind: "svg",
    });
  });

  test("an SVG or a TIFF given to sharp straight away isn't read at all", async () => {
    // process.ts is loaded, so libvips has only its readers for the kinds Tend takes.
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"/>');
    await expect(sharp(svg).metadata()).rejects.toThrow(/unsupported image format/);
    const tiff = await flat(40, 30).tiff().toBuffer();
    await expect(sharp(tiff).metadata()).rejects.toThrow(/unsupported image format/);
    for (const kind of ["jpeg", "png", "webp", "gif", "avif"] as const) {
      const data = await flat(40, 30)
        .toFormat(kind, kind === "avif" ? { effort: 0 } : {})
        .toBuffer();
      expect((await sharp(data).metadata()).width).toBe(40);
    }
  });
});

describe("media-5, round 2: the contents decide, unless the name says another kind", () => {
  const pdf = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

  test("words after a dot that aren't a file's ending are part of the name", async () => {
    const jpeg = await flat(40, 30).jpeg().toBuffer();
    expect(checkUpload("Mt.Fuji", jpeg)).toEqual({ kind: "image", format: "jpeg" });
    expect(checkUpload("St.Louis skyline", jpeg)).toEqual({ kind: "image", format: "jpeg" });
    expect(checkUpload("Q3.Menu", pdf)).toEqual({ kind: "file", format: "pdf" });
    expect(checkUpload("Menu v2.final", pdf)).toEqual({ kind: "file", format: "pdf" });
    expect(downloadName({ originalName: "Mt.Fuji", ext: "jpg" })).toBe("mt-fuji.jpg");
    expect(downloadName({ originalName: "Menu v2.final", ext: "pdf" })).toBe("menu-v2-final.pdf");
  });

  test("a file named as another kind is refused, saying how to rename it", async () => {
    const jpeg = await flat(40, 30).jpeg().toBuffer();
    const tiff = refusal(() => checkUpload("photo.tiff", jpeg));
    expect(tiff.status).toBe(415);
    expect(tiff.code).toBe("unsupported_file");
    expect(tiff.message).toBe("That file is a JPEG, but its name ends in .tiff.");
    expect(tiff.details.fix).toBe("Rename it to end in .jpg, then add it again.");
    const docx = refusal(() => checkUpload("Report.DOCX", pdf));
    expect(docx.message).toBe("That file is a PDF, but its name ends in .DOCX.");
    expect(docx.details.fix).toBe("Rename it to end in .pdf, then add it again.");
    // The contents say what it really is, even for endings with a message of their own.
    expect(refusal(() => checkUpload("photo.heic", jpeg)).message).toBe(
      "That file is a JPEG, but its name ends in .heic.",
    );
    expect(refusal(() => checkUpload("logo.svg", jpeg)).details.fix).toBe(
      "Rename it to end in .jpg, then add it again.",
    );
  });

  test("a file Tend can't use keeps the message it had", () => {
    for (const name of ["notes.txt", "Mt.Fuji", "photo.jpg"]) {
      const error = refusal(() => checkUpload(name, Buffer.from("hello")));
      expect(error.message).toBe("Tend can't use that kind of file.");
      expect(error.details.fix).toBe(
        "Tend can use JPG, PNG, WebP, GIF and AVIF pictures, and PDF files.",
      );
    }
    expect(refusal(() => checkUpload("IMG_0001.HEIC", Buffer.from("hello"))).code).toBe(
      "heic_photo",
    );
    expect(refusal(() => checkUpload("logo.svg", Buffer.from("hello"))).code).toBe("svg_file");
  });

  test("Mt.Fuji uploads, and keeps its whole name in its address", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const reply = await owner.upload(MEDIA, await flat(40, 30).jpeg().toBuffer(), "Mt.Fuji");
    expect(reply.status).toBe(201);
    const item = await reply.json();
    expect(item.name).toBe("Mt.Fuji");
    expect(item.url).toMatch(/\/mt-fuji\.jpg$/);
  });
});

describe("media-6, round 2: frames are counted from the bytes, before sharp reads them", () => {
  test("an animated WebP with over 1,000 frames is refused before sharp sees it", async () => {
    const webp = await tinyFramesWebp(1001);
    expect(checkUpload("sticker.webp", webp)).toEqual({ kind: "image", format: "webp" });
    const read = vi.spyOn(sharp.prototype, "metadata");
    const error = await refusalOf(() => processImage(webp, "webp"));
    expect(error.status).toBe(413);
    expect(error.code).toBe("too_many_frames");
    expect(read).not.toHaveBeenCalled();
  });

  test("so is one with 400,000 frames, in milliseconds", async () => {
    const webp = await tinyFramesWebp(400_000);
    expect(webp.length).toBeGreaterThan(19_000_000);
    // sharp's own count took over 30 seconds for this, and two minutes on one thread.
    const read = vi.spyOn(sharp.prototype, "metadata");
    const started = performance.now();
    const error = await refusalOf(() => processImage(webp, "webp"));
    expect(performance.now() - started).toBeLessThan(2000);
    expect(error.code).toBe("too_many_frames");
    expect(read).not.toHaveBeenCalled();
  });

  test("and a GIF with over 1,000 frames", async () => {
    const read = vi.spyOn(sharp.prototype, "metadata");
    const error = await refusalOf(() => processImage(tinyFramesGif(1001), "gif"));
    expect(error.code).toBe("too_many_frames");
    expect(read).not.toHaveBeenCalled();
  });

  test("an animated WebP with 1,000 frames is taken", async () => {
    const done = await processImage(await tinyFramesWebp(1000), "webp");
    expect([done.width, done.height]).toEqual([1, 1]);
  });
});

describe("a WebP refused from its first bytes", () => {
  test("a see-through one is told a size that's then taken, and not to make it a JPEG", async () => {
    // sharp writes a see-through WebP with an extended header that says so, as here.
    const real = await transparentWebp(300);
    expect(real.subarray(12, 16).toString("latin1")).toBe("VP8X");
    expect((real[20] as number) & 0x10).toBe(0x10);
    const read = vi.spyOn(sharp.prototype, "metadata");
    const logo = extendedWebpStart(3000, 3000, true);
    const error = await refusalOf(() => processImage(logo, "webp", { memoryLimit: 512 * MiB }));
    expect(read).not.toHaveBeenCalled();
    expect(error.code).toBe("too_big_for_server");
    expect(error.details.fix).not.toMatch(/JPEG/);
    const wide = Number(
      /exporting it ([\d,]+) pixels wide/.exec(error.details.fix ?? "")?.[1]?.replace(/,/g, ""),
    );
    expect(wide).toBeGreaterThan(0);
    const done = await processImage(await transparentWebp(wide), "webp", {
      memoryLimit: 512 * MiB,
    });
    expect(done.width).toBe(wide);
  });

  test("an animated one is told about its frames", async () => {
    // Three frames on a 2000 pixel square.
    const webp = await tinyFramesWebp(3, 2000);
    const read = vi.spyOn(sharp.prototype, "metadata");
    const error = await refusalOf(() => processImage(webp, "webp", { memoryLimit: 512 * MiB }));
    expect(read).not.toHaveBeenCalled();
    expect(error.code).toBe("too_big_for_server");
    expect(error.message).toMatch(
      /^That animation is too big for this server to prepare\. Here, a WebP animation like this one can be up to [\d.]+ megapixels, counting every frame\.$/,
    );
    expect(error.details.fix).not.toMatch(/JPEG/);
  });
});

describe("a server with many cores", () => {
  test("libvips gets only the threads the memory has room for, so pictures are still taken", async () => {
    vi.resetModules();
    vi.doMock("node:os", async (original) => {
      const actual = await original<typeof import("node:os")>();
      const host = { ...actual, totalmem: () => 2 * GiB };
      return { ...host, default: host };
    });
    const before = sharp.concurrency();
    // As on a 64-core machine, where libvips gives each picture a thread for every core.
    sharp.concurrency(64);
    try {
      const loaded = await import("../src/media/process.ts");
      expect(sharp.concurrency()).toBeLessThanOrEqual(8);
      const small = await loaded.processImage(await flat(64, 48).png().toBuffer(), "png");
      expect(small.width).toBe(64);
      const photo = await flat(4032, 3024).jpeg().toBuffer();
      expect((await loaded.processImage(photo, "jpeg")).width).toBe(4032);
    } finally {
      sharp.concurrency(before);
      vi.doUnmock("node:os");
    }
  });

  test("a picture is prepared on the threads its plan has room for, whatever libvips was set to", async () => {
    const before = sharp.concurrency();
    sharp.concurrency(64);
    try {
      const done = await processImage(await flat(64, 48).png().toBuffer(), "png", {
        memoryLimit: 2 * GiB,
      });
      expect(done.width).toBe(64);
      expect(sharp.concurrency()).toBeLessThanOrEqual(8);
    } finally {
      sharp.concurrency(before);
    }
  });
});
