// The versions of Tend a theme says it's made for: "tend": ">=0.1 <2" in its theme.json
// (PLAN.md §10). Only comparisons joined by spaces, which is all a theme needs.

const COMPARISON = /^(>=|<=|>|<|=)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;

type Version = [number, number, number];

function versionOf(text: string): Version | null {
  const match = text.match(/^v?(\d+)\.(\d+)\.(\d+)/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compare(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** Why this Tend isn't one the theme is made for, or null if it is, or it doesn't say. */
export function madeFor(range: unknown, version: string | undefined): string | null {
  if (range === undefined || range === null) return null;
  const parts =
    typeof range === "string"
      ? range
          .replace(/([<>=])\s+/g, "$1")
          .trim()
          .split(/\s+/)
      : [];
  const comparisons = parts.map((part) => part.match(COMPARISON));
  if (comparisons.length === 0 || comparisons.includes(null)) {
    return 'theme.json: "tend" should say which versions of Tend it\'s for, like ">=0.1 <2".';
  }
  const running = version === undefined ? null : versionOf(version);
  // 0.0.0 is Tend run from its own source, which is none of them yet.
  if (!running || compare(running, [0, 0, 0]) === 0) return null;
  const fits = comparisons.every((match) => {
    const [, sign = "=", major, minor, patch] = match as RegExpMatchArray;
    const than: Version = [Number(major), Number(minor ?? 0), Number(patch ?? 0)];
    const order = compare(running, than);
    switch (sign) {
      case ">=":
        return order >= 0;
      case "<=":
        return order <= 0;
      case ">":
        return order > 0;
      case "<":
        return order < 0;
      default:
        return order === 0;
    }
  });
  return fits ? null : `It's made for Tend ${parts.join(" ")}, and this is Tend ${version}.`;
}
