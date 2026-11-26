import { escapeHtml } from "../content/render-doc.ts";
import { type Media, mediaWidths, variantUrl } from "../media/library.ts";

// Pictures are stored as placeholders naming them (PLAN.md §8), written by the document
// renderer or the theme's {% image %} tag, and become real ones only when a page is shown.
// Everything people type is escaped before it gets here, so only Tend's own markup matches.
const MEDIA_PLACEHOLDER = /<tend-image((?: [a-z-]+="[^"<>]*")*)><\/tend-image>/g;
const ATTRIBUTE = / ([a-z-]+)="([^"<>]*)"/g;
/**
 * A picture's address on its own, from a theme's img_url and srcset filters. Only where an
 * attribute's value starts, which nothing that's been escaped can look like.
 */
const ADDRESS_PLACEHOLDER = /(?<==")tend:(img|srcset):([0-9a-f-]{36})(?::(\d{1,5}))?/g;
export const BUSINESS_PLACEHOLDER = "<tend-business></tend-business>";

/** How wide each kind of picture is shown, to match the theme, so phones get small files. */
const SIZES: Record<string, string> = {
  normal: "(min-width: 46rem) 42rem, 100vw",
  half: "(min-width: 82rem) 41rem, (min-width: 46rem) 52vw, 100vw",
  wide: "(min-width: 82rem) 76rem, 100vw",
  full: "100vw",
  card: "(min-width: 82rem) 24rem, (min-width: 46rem) 46vw, 100vw",
  cover: "(min-width: 82rem) 76rem, 100vw",
};
/** Pictures in the text, which get a frame and can have a caption. */
const IN_TEXT = new Set(["normal", "half", "wide", "full"]);
const LOGO_HEIGHT_PX = 48;
/** The size browsers that ignore srcset get. */
const FALLBACK_WIDTH = 960;

function attributesOf(text: string): Map<string, string> {
  return new Map([...text.matchAll(ATTRIBUTE)].map((match) => [match[1] ?? "", match[2] ?? ""]));
}

/** The pictures a page shows, for one lookup. */
export function mediaPlaceholderIds(html: string): string[] {
  const ids = new Set<string>();
  for (const match of html.matchAll(MEDIA_PLACEHOLDER)) {
    const id = attributesOf(match[1] ?? "").get("data-id");
    if (id) ids.add(id);
  }
  for (const match of html.matchAll(ADDRESS_PLACEHOLDER)) ids.add(match[2] as string);
  return [...ids];
}

export function imageUrl(id: string, width: number): string {
  return `tend:img:${id}:${Math.min(99_999, Math.max(1, Math.floor(width)))}`;
}

export function imageSrcset(id: string): string {
  return `tend:srcset:${id}`;
}

/**
 * What a picture says to someone who can't see it. Marked decorative where it's placed, it
 * says nothing. Words given where it's placed, like the site's name the theme gives its logo,
 * win over Media's; only without them does Media's own decorative mark or description count.
 */
function altText(attributes: Map<string, string>, item: Media): string {
  if (attributes.has("data-decorative")) return "";
  const given = attributes.get("data-alt");
  if (given !== undefined) return given;
  return item.decorative === 1 ? "" : escapeHtml(item.alt ?? "");
}

function srcsetOf(item: Media, widths: number[], origin: string): string {
  return widths.map((width) => `${origin}${variantUrl(item, width)} ${width}w`).join(", ");
}

export interface ResolveOptions {
  /** Put in front of every address, for feeds and other places that need full ones. */
  origin?: string;
}

/**
 * Turns picture placeholders into real pictures, with the sizes the browser picks from.
 * A picture that's gone, or in the Trash, leaves nothing behind, caption and all. The
 * first one that isn't the logo is probably the biggest thing on screen, so it's fetched
 * straight away; the rest wait until they're nearly scrolled to.
 */
export function resolveMediaPlaceholders(
  html: string,
  found: ReadonlyMap<string, Media>,
  options: ResolveOptions = {},
): string {
  const origin = options.origin ?? "";
  let first = true;
  const addressed = html.replace(
    ADDRESS_PLACEHOLDER,
    (_, kind: string, id: string, wanted: string | undefined) => {
      const item = found.get(id);
      if (item?.kind !== "image" || item.trashedAt !== null) return "";
      const widths = mediaWidths(item);
      if (kind === "srcset") return srcsetOf(item, widths, origin);
      // The smallest that's big enough, or else the biggest there is.
      const width = widths.find((each) => each >= Number(wanted)) ?? widths.at(-1);
      return width === undefined ? "" : `${origin}${variantUrl(item, width)}`;
    },
  );
  return addressed.replace(MEDIA_PLACEHOLDER, (_, text: string) => {
    const attributes = attributesOf(text);
    const item = found.get(attributes.get("data-id") ?? "");
    if (item?.kind !== "image" || item.trashedAt !== null) return "";
    const widths = mediaWidths(item);
    if (widths.length === 0 || !item.width || !item.height) return "";

    const requested = attributes.get("data-size") ?? "normal";
    const size = requested === "logo" || requested in SIZES ? requested : "normal";
    const alt = altText(attributes, item);
    const fallback = widths.filter((width) => width <= FALLBACK_WIDTH).pop() ?? widths[0];
    const src = `${origin}${variantUrl(item, fallback as number)}`;
    const srcset = srcsetOf(item, widths, origin);
    const sizes =
      attributes.get("data-sizes") ??
      (size === "logo"
        ? `${Math.round((LOGO_HEIGHT_PX * item.width) / item.height)}px`
        : (SIZES[size] as string));
    const asked = attributes.get("data-priority");
    const eager = asked ? asked === "high" : first && size !== "logo";
    if (size !== "logo") first = false;
    const priority = eager ? ' fetchpriority="high"' : size === "logo" ? "" : ' loading="lazy"';
    // A colour to show while it loads. Media keeps none for a picture with see-through parts,
    // and the logo never gets one, so the header always shows through it.
    const background =
      item.dominantColor && size !== "logo"
        ? ` style="background-color:${item.dominantColor}"`
        : "";
    const className = IN_TEXT.has(size) ? "" : ` class="t-img-${size}"`;
    const image = `<img${className} src="${src}" srcset="${srcset}" sizes="${sizes}" width="${item.width}" height="${item.height}" alt="${alt}"${priority} decoding="async"${background}>`;
    if (!IN_TEXT.has(size)) return image;

    const caption = attributes.get("data-caption") ?? "";
    const credit = item.credit ? `<span class="t-credit">${escapeHtml(item.credit)}</span>` : "";
    const words = [caption, credit].filter(Boolean).join(" ");
    return `<figure class="t-image t-size-${size}">${image}${words ? `<figcaption>${words}</figcaption>` : ""}</figure>`;
  });
}

/** The placeholder for one picture, for the theme's {% image %} tag. */
export function imagePlaceholder(input: {
  id: string;
  size: string;
  alt?: string | null;
  decorative?: boolean;
  /** How wide it's shown, as the sizes attribute says it. */
  sizes?: string | null;
  /** Whether it's fetched first, or only when nearly on screen. Null decides by itself. */
  priority?: boolean | null;
}): string {
  const parts = [`data-id="${escapeHtml(input.id)}"`, `data-size="${escapeHtml(input.size)}"`];
  if (input.sizes) parts.push(`data-sizes="${escapeHtml(input.sizes)}"`);
  if (typeof input.priority === "boolean") {
    parts.push(`data-priority="${input.priority ? "high" : "low"}"`);
  }
  if (input.alt) parts.push(`data-alt="${escapeHtml(input.alt)}"`);
  if (input.decorative) parts.push('data-decorative=""');
  return `<tend-image ${parts.join(" ")}></tend-image>`;
}
