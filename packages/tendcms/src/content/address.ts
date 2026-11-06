const MAX_LENGTH = 100;

/** Turns a title or typed address into the part of a URL that follows the slash. */
export function slugify(input: string): string {
  const slug = input
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.slice(0, MAX_LENGTH).replace(/-+$/, "");
}

// The first part of these paths belongs to Tend, so a page can't have them (PLAN.md §9).
const RESERVED_FOR_TEND = new Set([
  "admin",
  "api",
  "media",
  "assets",
  "blog",
  "tag",
  "p",
  "search",
  "feed",
  "recover",
  "healthz",
]);

export function isReservedPageAddress(slug: string): boolean {
  return RESERVED_FOR_TEND.has(slug);
}

export function entryPath(entry: { type: string; isHome: number; slug: string }): string {
  if (entry.isHome === 1) return "/";
  return entry.type === "post" ? `/blog/${entry.slug}` : `/${entry.slug}`;
}
