// Contrast (WCAG 2.2): text needs 4.5:1 against what's behind it. Used for the accent colour,
// so a light colour chosen for a light site still gives readable links on a dark one.

const HEX = /^#([0-9a-f]{6})$/i;
export const READABLE = 4.5;

function channels(hex: string): [number, number, number] | undefined {
  const match = hex.match(HEX)?.[1];
  if (!match) return undefined;
  return [0, 2, 4].map((start) => Number.parseInt(match.slice(start, start + 2), 16)) as [
    number,
    number,
    number,
  ];
}

function luminance([r, g, b]: [number, number, number]): number {
  const linear = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

export function contrast(a: string, b: string): number {
  const first = channels(a);
  const second = channels(b);
  if (!first || !second) return 1;
  const [light, dark] = [luminance(first), luminance(second)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (light + 0.05) / (dark + 0.05);
}

function hex(values: [number, number, number]): string {
  return `#${values.map((value) => Math.round(value).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The colour moved towards black or white, whichever the background isn't, just far enough
 * to be readable on it. Given several backgrounds, like a page and the tinted sections on it,
 * it's readable on every one; they're all dark or all light, so there's one way to move.
 * A colour that's readable already comes back as it was.
 */
export function readableOn(
  color: string,
  background: string | readonly string[],
  ratio = READABLE,
): string {
  const backgrounds = typeof background === "string" ? [background] : background;
  const start = channels(color);
  const first = channels(backgrounds[0] ?? "");
  if (!start || !first || !backgrounds.every((each) => channels(each))) return color;
  const readable = (candidate: string) =>
    backgrounds.every((each) => contrast(candidate, each) >= ratio);
  if (readable(color)) return color.toLowerCase();
  const target = luminance(first) > 0.5 ? 0 : 255;
  for (let step = 1; step <= 20; step++) {
    const mix = step / 20;
    const candidate = hex(
      start.map((value) => value + (target - value) * mix) as [number, number, number],
    );
    if (readable(candidate)) return candidate;
  }
  return target === 0 ? "#000000" : "#ffffff";
}
