import { existsSync } from "node:fs";
import sharp from "sharp";
import { expect, test, vi } from "vitest";
import {
  getMedia,
  mediaHash,
  mediaWidths,
  replaceMedia,
  variantUrl,
} from "../src/media/library.ts";
import { MediaStore } from "../src/media/store.ts";
import { makeApp, setUp } from "./auth-helpers.ts";

// A file of its own, because finishing two pictures at the same moment needs processImage
// held back, and a module mock covers the whole file.

const gate = vi.hoisted(() => ({
  armed: false,
  waiting: 0,
  open: () => {},
  opened: Promise.resolve(),
}));

vi.mock("../src/media/process.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/media/process.ts")>();
  return {
    ...real,
    processImage: async (...args: Parameters<typeof real.processImage>) => {
      const done = await real.processImage(...args);
      if (gate.armed) {
        gate.waiting += 1;
        await gate.opened;
      }
      return done;
    },
  };
});

function arm(): void {
  gate.armed = true;
  gate.waiting = 0;
  gate.opened = new Promise<void>((resolve) => {
    gate.open = resolve;
  });
}

function png(width: number, background: string): Promise<Buffer> {
  return sharp({ create: { width, height: 700, channels: 3, background } })
    .png()
    .toBuffer();
}

test("the same picture again, replaced at the same moment as another, keeps its files", async () => {
  const made = await makeApp();
  const owner = await setUp(made);
  const original = await png(1000, "#336699");
  const item = await (await owner.upload("/api/admin/media", original, "A.png")).json();
  const store = new MediaStore(made.uploadsDir);

  // A new picture finishes first, then the original again. Both are let go together.
  arm();
  const replace = (name: string, data: Buffer) =>
    replaceMedia(made.orm, store, { id: item.id, name, data, now: made.clock.time });
  const newer = replace("B.png", await png(1100, "#aa0000"));
  await vi.waitFor(() => expect(gate.waiting).toBe(1), { timeout: 10_000 });
  const again = replace("A.png", original);
  // One at a time, the second never gets this far before the first is let go.
  await vi.waitFor(() => expect(gate.waiting).toBe(2), { timeout: 2000 }).catch(() => {});
  gate.open();
  const results = await Promise.allSettled([newer, again]);
  gate.armed = false;
  expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);

  const row = await getMedia(made.orm, item.id);
  if (!row) throw new Error("The picture has gone");
  const hash = mediaHash(row);
  expect(existsSync(store.originalPath(row.id, hash, row.ext))).toBe(true);
  const widths = mediaWidths(row);
  expect(widths.length).toBeGreaterThan(0);
  for (const width of widths) {
    expect(existsSync(store.variantPath(row.id, hash, `${width}.webp`)), String(width)).toBe(true);
    expect((await made.app.request(variantUrl(row, width))).status, String(width)).toBe(200);
  }
});
