import sharp from "sharp";
import { describe, expect, test } from "vitest";
import type { Media } from "../src/media/library.ts";
import { imagePlaceholder, resolveMediaPlaceholders } from "../src/site/placeholders.ts";
import { makeApp, setUp } from "./auth-helpers.ts";

// A picture's focal point (PLAN.md v0.2): what stays in sight where a theme crops it to fit,
// as on a card or behind a Big intro's words.

const ID = "0193a0a0-0000-7000-8000-000000000002";

/** A picture as Media keeps it, without uploading one. */
function stored(overrides: Partial<Media> = {}): Media {
  return {
    id: ID,
    kind: "image",
    originalName: "Shop.jpg",
    mime: "image/jpeg",
    ext: "jpg",
    sizeBytes: 1000,
    width: 1200,
    height: 800,
    sha256: "b".repeat(64),
    variants: [480, 960, 1200],
    alt: "The shop",
    decorative: 0,
    caption: null,
    credit: null,
    focalX: 0.5,
    focalY: 0.5,
    dominantColor: "#884422",
    uploadedBy: null,
    createdAt: 0,
    updatedAt: 0,
    trashedAt: null,
    ...overrides,
  } as Media;
}

function shown(size: string, item: Media): string {
  return resolveMediaPlaceholders(imagePlaceholder({ id: ID, size }), new Map([[ID, item]]));
}

describe("where a cropped picture is placed", () => {
  test("its focal point, wherever a theme can crop it", () => {
    const off = stored({ focalX: 0.3, focalY: 0.725 });
    for (const size of ["card", "cover", "normal", "full"]) {
      expect(shown(size, off), size).toContain(
        'style="background-color:#884422;object-position:30% 72.5%"',
      );
    }
    // Without a colour of its own, the place still goes in.
    expect(shown("card", stored({ focalX: 0, focalY: 1, dominantColor: null }))).toContain(
      'style="object-position:0% 100%"',
    );
  });

  test("nothing for the middle, which is where it goes anyway, and never for the logo", () => {
    expect(shown("card", stored())).not.toContain("object-position");
    expect(shown("logo", stored({ focalX: 0.1, focalY: 0.1 }))).not.toContain("style=");
  });
});

test("the focal point is saved with a picture's details, between 0 and 1", async () => {
  const made = await makeApp();
  const owner = await setUp(made);
  const png = await sharp({
    create: { width: 1200, height: 800, channels: 3, background: "#336699" },
  })
    .png()
    .toBuffer();
  const uploaded = await (await owner.upload("/api/admin/media", png, "Shop.png")).json();
  expect([uploaded.focalX, uploaded.focalY]).toEqual([0.5, 0.5]);

  const saved = await owner.patch(`/api/admin/media/${uploaded.id}`, { focalX: 0.25, focalY: 0.8 });
  expect(saved.status).toBe(200);
  expect(await saved.json()).toMatchObject({ focalX: 0.25, focalY: 0.8 });
  const outside = await owner.patch(`/api/admin/media/${uploaded.id}`, { focalX: 1.5 });
  expect(outside.status).toBe(400);
  const again = await (await owner.get(`/api/admin/media/${uploaded.id}`)).json();
  expect([again.focalX, again.focalY]).toEqual([0.25, 0.8]);
});
