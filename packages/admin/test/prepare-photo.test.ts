import { describe, expect, test } from "vitest";
import { kindOf, mayBeMadeSmaller, sizeOf } from "../src/lib/prepare-photo.ts";

// Getting a photo ready to send (PLAN.md v0.2): what it is and how big it is come from its first
// bytes, so most photos are sent as they are without being drawn first.

const bytes = (...parts: (number[] | string)[]) =>
  Uint8Array.from(
    parts.flatMap((part) =>
      typeof part === "string" ? [...part].map((c) => c.charCodeAt(0)) : part,
    ),
  );
const be16 = (value: number) => [value >> 8, value & 0xff];
const be32 = (value: number) => [
  value >>> 24,
  (value >> 16) & 0xff,
  (value >> 8) & 0xff,
  value & 0xff,
];
const le24 = (value: number) => [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff];

/** A JPEG's start: a camera's details, then a frame header saying how big it is. */
function jpeg(width: number, height: number, frame = 0xc0): Uint8Array {
  const details = [0xff, 0xe1, ...be16(2 + 14), ...Array(14).fill(0x45)];
  const table = [0xff, 0xc4, ...be16(2 + 3), 0, 0, 0];
  const header = [
    0xff,
    frame,
    ...be16(17),
    8,
    ...be16(height),
    ...be16(width),
    3,
    ...Array(9).fill(0),
  ];
  return bytes([0xff, 0xd8], details, table, header, [0xff, 0xda]);
}

describe("what a picture is", () => {
  test("from its first bytes", () => {
    expect(kindOf(jpeg(10, 10), "a.jpg", "image/jpeg")).toBe("jpeg");
    expect(kindOf(bytes([0x89], "PNG\r\n\x1a\n"), "a.png", "")).toBe("png");
    expect(kindOf(bytes("GIF89a"), "a.gif", "")).toBe("gif");
    expect(kindOf(bytes("RIFF", be32(0), "WEBPVP8 "), "a.webp", "")).toBe("webp");
    const heic = bytes(be32(24), "ftypheic", be32(0), "mif1heic");
    expect(kindOf(heic, "IMG_0042.HEIC", "image/heic")).toBe("heic");
    expect(kindOf(bytes(be32(24), "ftypmif1", be32(0), "mif1heic"), "x", "")).toBe("heic");
    // AVIF is mif1 too, but says avif.
    expect(kindOf(bytes(be32(24), "ftypavif", be32(0), "mif1miaf"), "x", "")).toBe("avif");
    expect(kindOf(bytes(be32(24), "ftypmif1", be32(0), "mif1avif"), "x", "")).toBe("avif");
  });

  test("or, for a HEIC whose bytes aren't known, its name or type", () => {
    expect(kindOf(bytes("????"), "IMG_0042.HEIC", "")).toBe("heic");
    expect(kindOf(bytes("????"), "photo", "image/heif")).toBe("heic");
    expect(kindOf(bytes("%PDF-1.7"), "menu.pdf", "application/pdf")).toBeNull();
  });
});

describe("how big it says it is", () => {
  test("a JPEG, after its camera's details and tables", () => {
    expect(sizeOf(jpeg(9000, 6000), "jpeg")).toEqual({ width: 9000, height: 6000 });
    // Progressive ones too.
    expect(sizeOf(jpeg(4032, 3024, 0xc2), "jpeg")).toEqual({ width: 4032, height: 3024 });
    // Cut short before its frame header: not known.
    expect(sizeOf(jpeg(9000, 6000).subarray(0, 30), "jpeg")).toBeNull();
  });

  test("a PNG", () => {
    const png = bytes([0x89], "PNG\r\n\x1a\n", be32(13), "IHDR", be32(12000), be32(5000));
    expect(sizeOf(png, "png")).toEqual({ width: 12000, height: 5000 });
  });

  test("a WebP, in each of its three forms", () => {
    const extended = bytes(
      "RIFF",
      be32(0),
      "WEBPVP8X",
      [10, 0, 0, 0],
      [0, 0, 0, 0],
      le24(8999),
      le24(5999),
    );
    expect(sizeOf(extended, "webp")).toEqual({ width: 9000, height: 6000 });
    const lossy = bytes(
      "RIFF",
      be32(0),
      "WEBPVP8 ",
      be32(0),
      [0, 0, 0],
      [0x9d, 0x01, 0x2a],
      [0x28, 0x23],
      [0x70, 0x17],
    );
    expect(sizeOf(lossy, "webp")).toEqual({ width: 9000, height: 6000 });
    const packed = (8999 & 0x3fff) | ((5999 & 0x3fff) << 14);
    const lossless = bytes(
      "RIFF",
      be32(0),
      "WEBPVP8L",
      be32(0),
      [0x2f],
      [packed & 0xff, (packed >> 8) & 0xff, (packed >> 16) & 0xff, (packed >>> 24) & 0xff],
    );
    expect(sizeOf(lossless, "webp")).toEqual({ width: 9000, height: 6000 });
  });

  test("and nothing for the kinds that only drawing them can say", () => {
    expect(sizeOf(bytes(be32(24), "ftypheic"), "heic")).toBeNull();
    expect(sizeOf(bytes(be32(24), "ftypavif"), "avif")).toBeNull();
  });
});

test("only a photo too big as it is may be made smaller, not a PDF or a GIF", () => {
  const file = (name: string, type: string) => new File([], name, { type });
  expect(mayBeMadeSmaller(file("IMG_0042.JPG", "image/jpeg"))).toBe(true);
  expect(mayBeMadeSmaller(file("IMG_0042.HEIC", ""))).toBe(true);
  expect(mayBeMadeSmaller(file("scan.png", "image/png"))).toBe(true);
  expect(mayBeMadeSmaller(file("menu.pdf", "application/pdf"))).toBe(false);
  expect(mayBeMadeSmaller(file("dance.gif", "image/gif"))).toBe(false);
});
