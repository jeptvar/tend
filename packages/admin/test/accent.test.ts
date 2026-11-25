import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ACCENTS, contrast, hardToReadOn, readableOn } from "../src/lib/site.ts";

// The Design screen checks a colour against the backgrounds the theme says it goes on
// (contrastAgainst), so the colour it suggests is readable wherever a link is, not only on white.

const MEADOW = join(import.meta.dirname, "..", "..", "..", "themes", "meadow");

/** What Meadow's theme.json says its accent goes on. */
function saidBackgrounds(): string[] {
  const { settings } = JSON.parse(readFileSync(join(MEADOW, "theme.json"), "utf8"));
  return settings.find((setting: { id: string }) => setting.id === "accent").contrastAgainst;
}

describe("the accent colour on the Design screen", () => {
  test("is checked against white and a soft background", () => {
    // Meadow's own are made from the accent. A colour readable on these two makes a link that's
    // readable on all of them, which packages/tendcms/test/meadow.test.ts checks.
    expect(saidBackgrounds()).toEqual(["#ffffff", "#f1f2f2"]);
  });

  test("is suggested readable on both of them, whatever the colour", () => {
    const backgrounds = saidBackgrounds();
    const levels = Array.from({ length: 18 }, (_, index) => index * 15);
    const failing: string[] = [];
    for (const r of levels) {
      for (const g of levels) {
        for (const b of levels) {
          const color = `#${[r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
          const suggestion = readableOn(color, backgrounds);
          if (hardToReadOn(suggestion, backgrounds) !== null) {
            failing.push(`${color} → ${suggestion}`);
          }
          for (const behind of backgrounds) {
            const ratio = contrast(suggestion, behind);
            if (ratio < 4.5)
              failing.push(`${color} → ${suggestion}: ${ratio.toFixed(2)} on ${behind}`);
          }
        }
      }
    }
    expect(failing.length, failing.slice(0, 5).join("; ")).toBe(0);
  });

  test("that only just reads on white is hard to read in a Soft section, and is fixed for both", () => {
    const [white, soft] = saidBackgrounds() as [string, string];
    // 4.70:1 on white, but 4.19:1 on a Soft section's grey.
    expect(hardToReadOn("#e11d48", [white, soft])).toBe(soft);
    expect(hardToReadOn("#e11d48", [white])).toBeNull();
    expect(readableOn("#e11d48", [white, soft])).toBe("#d61c44");
    // What the screen used to suggest for #ffcc00 is just as hard to read there.
    expect(hardToReadOn("#8c7000", [white, soft])).toBe(soft);
    for (const suggestion of ["#d61c44", readableOn("#8c7000", [white, soft])]) {
      for (const behind of [white, soft]) {
        expect(contrast(suggestion, behind), `${suggestion} on ${behind}`).toBeGreaterThanOrEqual(
          4.5,
        );
      }
    }
  });

  test("that's hard to read on white says so first, and is fixed for both", () => {
    const backgrounds = saidBackgrounds();
    expect(hardToReadOn("#ffcc00", backgrounds)).toBe("#ffffff");
    expect(readableOn("#ffcc00", backgrounds)).toBe("#806600");
    expect(hardToReadOn("#806600", backgrounds)).toBeNull();
  });

  test("on a dark background is lightened instead", () => {
    const dark = ["#141a17"];
    expect(hardToReadOn("#1f6f4a", dark)).toBe("#141a17");
    const suggestion = readableOn("#1f6f4a", dark);
    expect(contrast(suggestion, "#141a17")).toBeGreaterThanOrEqual(4.5);
  });

  test("with nothing said about where it goes isn't checked", () => {
    expect(hardToReadOn("#ffffff", [])).toBeNull();
    expect(readableOn("#FFFFFF", [])).toBe("#ffffff");
  });

  test("that's offered to start from reads everywhere", () => {
    const backgrounds = saidBackgrounds();
    for (const { id, value } of ACCENTS) expect(hardToReadOn(value, backgrounds), id).toBeNull();
  });

  test("that reads everywhere is left as it is", () => {
    const backgrounds = saidBackgrounds();
    for (const color of ["#1f6f4a", "#2563EB", "#000000"]) {
      expect(hardToReadOn(color, backgrounds)).toBeNull();
      expect(readableOn(color, backgrounds)).toBe(color.toLowerCase());
    }
  });
});
