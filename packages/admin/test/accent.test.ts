import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { contrast, hardToReadOn, readableOn } from "../src/lib/site.ts";

// The Design screen checks a colour against the backgrounds the theme says it goes on
// (contrastAgainst). For Meadow's accent that's every light one it puts links on, so the colour
// it suggests is readable wherever a link is, not only on white.

const MEADOW = join(import.meta.dirname, "..", "..", "..", "themes", "meadow");

/** What Meadow's theme.json says its accent goes on. */
function saidBackgrounds(): string[] {
  const { settings } = JSON.parse(readFileSync(join(MEADOW, "theme.json"), "utf8"));
  return settings.find((setting: { id: string }) => setting.id === "accent").contrastAgainst;
}

/** A colour as six hex digits: #fff is #ffffff. */
function sixDigits(hex: string | undefined): string {
  expect(hex).toMatch(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  const digits = (hex as string).slice(1).toLowerCase();
  return `#${digits.length === 3 ? [...digits].map((digit) => digit + digit).join("") : digits}`;
}

/** Two colours mixed the way the browser does, from 0 (all of b) to 1 (all of a). */
function mix(a: string, b: string, share: number): string {
  const channels = (hex: string) =>
    [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
  const [first, second] = [channels(a), channels(b)];
  return `#${first
    .map((value, index) =>
      Math.round(value * share + (second[index] as number) * (1 - share))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/**
 * The light backgrounds links sit on, read from Meadow's own stylesheet: the page, and every
 * tone that lays a little of the text colour over it.
 */
function lightBackgrounds(): string[] {
  const css = readFileSync(join(MEADOW, "assets", "theme.css"), "utf8");
  // The first :root, before the dark-mode one, which is indented inside its @media.
  const light = css.match(/^:root\s*\{([^}]*)\}/m)?.[1] ?? "";
  const paper = sixDigits(light.match(/--tend-paper:\s*(#[0-9a-f]+)/i)?.[1]);
  const ink = sixDigits(light.match(/--tend-ink:\s*(#[0-9a-f]+)/i)?.[1]);
  const tones = [
    ...css.matchAll(
      /\.t-tone-[a-z-]+\s*\{\s*background:\s*color-mix\(in srgb, var\(--tend-ink\) (\d+)%, transparent\)/g,
    ),
  ].map((match) => mix(ink, paper, Number(match[1]) / 100));
  return [paper, ...tones];
}

describe("the accent colour on the Design screen", () => {
  test("is checked against the light backgrounds Meadow's stylesheet has", () => {
    // The page and Soft sections. If theme.css changes them, theme.json has to as well.
    expect(saidBackgrounds()).toEqual(lightBackgrounds());
  });

  test("is suggested readable on every one of them, whatever the colour", () => {
    const backgrounds = lightBackgrounds();
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

  test("that reads everywhere is left as it is", () => {
    const backgrounds = saidBackgrounds();
    for (const color of ["#1f6f4a", "#2563EB", "#000000"]) {
      expect(hardToReadOn(color, backgrounds)).toBeNull();
      expect(readableOn(color, backgrounds)).toBe(color.toLowerCase());
    }
  });
});
