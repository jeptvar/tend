import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultThemeDir } from "../src/paths.ts";

// Meadow's colours, worked out the way a browser does from theme.css: nearly all of them are
// the accent mixed into something, so they have to be checked with every accent there is.

/** Red, green and blue, from 0 to 1. */
export type Color = [number, number, number];
export type Scheme = "light" | "dark";

export function color(hex: string): Color {
  return [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255) as Color;
}

const linear = (value: number) =>
  value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
const encoded = (value: number) =>
  value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;

/** Oklab (CSS Color 4), which is what theme.css mixes colours in. */
function oklab([r, g, b]: Color): Color {
  const [x, y, z] = [linear(r), linear(g), linear(b)];
  const l = Math.cbrt(0.4122214708 * x + 0.5363325363 * y + 0.0514459929 * z);
  const m = Math.cbrt(0.2119034982 * x + 0.6806995451 * y + 0.1073969566 * z);
  const s = Math.cbrt(0.0883024619 * x + 0.2817188376 * y + 0.6299787005 * z);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function fromOklab([lightness, a, b]: Color): Color {
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((value) => encoded(Math.min(1, Math.max(0, value)))) as Color;
}

/** color-mix(in oklab, first share%, second) */
function mixed(first: Color, second: Color, share: number): Color {
  const [a, b] = [oklab(first), oklab(second)];
  return fromOklab(
    a.map((value, index) => value * share + (b[index] as number) * (1 - share)) as Color,
  );
}

/** One colour laid over another, this much of it. */
export function over(top: Color, under: Color, share: number): Color {
  return top.map((value, index) => value * share + (under[index] as number) * (1 - share)) as Color;
}

/** WCAG 2.2's contrast ratio. */
export function ratio(first: Color, second: Color): number {
  const luminance = (each: Color) => {
    const [r, g, b] = each.map(linear) as Color;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a) as [
    number,
    number,
  ];
  return (light + 0.05) / (dark + 0.05);
}

const css = readFileSync(join(defaultThemeDir, "assets", "theme.css"), "utf8");
const LIGHT = css.match(/:root\s*\{([^}]*)\}/)?.[1] ?? "";
const DARK = css.match(/prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([^}]*)\}/)?.[1] ?? "";
const MIX = /^color-mix\(in oklab, var\(--tend-accent\) (\d+)%, (#[0-9a-f]{6})\)$/;

/** Every colour theme.css names, for one accent: "ink" for --tend-ink, and so on. */
export function meadowColors(scheme: Scheme, accent: string): Record<string, Color> {
  const named = new Map<string, string>();
  for (const block of scheme === "dark" ? [LIGHT, DARK] : [LIGHT]) {
    for (const [, name, value] of block.matchAll(/--tend-([a-z-]+):\s*([^;]+);/g)) {
      named.set(name as string, (value as string).trim());
    }
  }
  const found = (value: string | undefined): Color | undefined => {
    if (value === undefined) return undefined;
    if (/^#[0-9a-f]{6}$/.test(value)) return color(value);
    const other = value.match(/^var\(--tend-([a-z-]+)\)$/)?.[1];
    if (other) return other === "accent" ? color(accent) : found(named.get(other));
    const [, share, base] = value.match(MIX) ?? [];
    return base ? mixed(color(accent), color(base), Number(share) / 100) : undefined;
  };
  return Object.fromEntries([
    ...[...named].flatMap(([name, value]) => {
      const shown = name.startsWith("font") ? undefined : found(value);
      return shown ? [[name, shown] as const] : [];
    }),
    ["accent", color(accent)],
  ]);
}

/** Accents all over the range, close enough together that none between them is far worse. */
export function everyAccent(step = 15): string[] {
  const levels = Array.from({ length: Math.floor(255 / step) + 1 }, (_, index) => index * step);
  return levels.flatMap((r) =>
    levels.flatMap((g) =>
      levels.map(
        (b) => `#${[r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("")}`,
      ),
    ),
  );
}
