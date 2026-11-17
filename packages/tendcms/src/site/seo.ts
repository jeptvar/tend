import { escapeHtml } from "../content/render-doc.ts";

// What goes in a page's <head> for search engines and sharing (PLAN.md §5): Tend writes
// it, so every theme gets it right without trying, and nothing in it runs in a browser.

export interface SharedImage {
  /** A full address: other sites fetch it on their own. */
  url: string;
  width: number;
  height: number;
  alt: string;
}

export interface HeadInput {
  origin: string;
  /** This page's own address, for the canonical link. */
  path: string;
  title: string;
  description: string | null;
  siteName: string;
  locale: string;
  type: "website" | "article";
  image: SharedImage | null;
  noindex: boolean;
  publishedAt?: number | null;
  modifiedAt?: number | null;
  /** Structured data: what this page is about, in schema.org's terms. */
  structured: object[];
  icon: { small: string; touch: string } | null;
  hasFeed: boolean;
  customCss: string | null;
  /** Settings, Advanced, "Add code to every page". Never in a preview. */
  extraHead: string | null;
}

const DESCRIPTION_LIMIT = 300;

function meta(name: string, content: string): string {
  return `<meta name="${name}" content="${escapeHtml(content)}">`;
}

function property(name: string, content: string): string {
  return `<meta property="${name}" content="${escapeHtml(content)}">`;
}

/** JSON inside a script element: "</script>" in someone's words mustn't end it early. */
export function jsonForScript(value: unknown): string {
  // Line and paragraph separators end a line in older JavaScript, so they're escaped too.
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replaceAll(String.fromCharCode(0x2028), "\\u2028")
    .replaceAll(String.fromCharCode(0x2029), "\\u2029");
}

/**
 * CSS inside a style element can't close it, whatever was typed. Only "</" can start the
 * closing tag, so only that changes: "<\/" means the same to CSS. A bare "<" has to stay as it
 * is, because CSS needs it in range queries like `@media (width < 600px)`.
 */
export function cssForStyle(css: string): string {
  return css.replaceAll("</", "<\\/");
}

export function shorten(text: string, limit = DESCRIPTION_LIMIT): string {
  const words = text.replace(/\s+/g, " ").trim();
  if ([...words].length <= limit) return words;
  const cut = [...words].slice(0, limit).join("");
  const space = cut.lastIndexOf(" ");
  return `${(space > 0 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export function buildHead(input: HeadInput): string {
  const url = `${input.origin}${input.path}`;
  const description = input.description ? shorten(input.description) : null;
  const parts = [`<title>${escapeHtml(input.title)}</title>`];
  if (description) parts.push(meta("description", description));
  parts.push(`<link rel="canonical" href="${escapeHtml(url)}">`);
  if (input.noindex) parts.push(meta("robots", "noindex"));
  parts.push(
    property("og:type", input.type),
    property("og:title", input.title),
    property("og:url", url),
    property("og:site_name", input.siteName),
    property("og:locale", input.locale.replace("-", "_")),
  );
  if (description) parts.push(property("og:description", description));
  if (input.image) {
    parts.push(
      property("og:image", input.image.url),
      property("og:image:width", String(input.image.width)),
      property("og:image:height", String(input.image.height)),
    );
    if (input.image.alt) parts.push(property("og:image:alt", input.image.alt));
  }
  parts.push(meta("twitter:card", input.image ? "summary_large_image" : "summary"));
  if (input.type === "article" && input.publishedAt) {
    parts.push(property("article:published_time", new Date(input.publishedAt).toISOString()));
    if (input.modifiedAt) {
      parts.push(property("article:modified_time", new Date(input.modifiedAt).toISOString()));
    }
  }
  if (input.icon) {
    parts.push(
      `<link rel="icon" href="${escapeHtml(input.icon.small)}" sizes="32x32" type="image/png">`,
      `<link rel="apple-touch-icon" href="${escapeHtml(input.icon.touch)}">`,
    );
  }
  if (input.hasFeed) {
    parts.push(
      `<link rel="alternate" type="application/rss+xml" title="${escapeHtml(input.siteName)}" href="${escapeHtml(`${input.origin}/rss.xml`)}">`,
    );
  }
  for (const data of input.structured) {
    parts.push(`<script type="application/ld+json">${jsonForScript(data)}</script>`);
  }
  if (input.customCss) parts.push(`<style>${cssForStyle(input.customCss)}</style>`);
  if (input.extraHead) parts.push(input.extraHead);
  return parts.join("\n");
}
