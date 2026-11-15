import { escapeHtml } from "../content/render-doc.ts";
import { type Media, mediaWidths, variantUrl } from "../media/library.ts";

// Pictures are stored as placeholders naming them (PLAN.md §8), written by the document
// renderer or the theme's {% image %} tag, and become real ones only when a page is shown.
// Everything people type is escaped before it gets here, so only Tend's own markup matches.
const MEDIA_PLACEHOLDER = /<tend-image((?: [a-z-]+="[^"<>]*")*)><\/tend-image>/g;
const ATTRIBUTE = / ([a-z-]+)="([^"<>]*)"/g;
export const BUSINESS_PLACEHOLDER = "<tend-business></tend-business>";

/** How wide each kind of picture is shown, to match the theme, so phones get small files. */
const SIZES: Record<string, string> = {
  normal: "(min-width: 46rem) 44rem, 100vw",
  half: "(min-width: 46rem) 22rem, 100vw",
  wide: "(min-width: 66rem) 64rem, 100vw",
  full: "100vw",
  card: "(min-width: 46rem) 44rem, 100vw",
  cover: "(min-width: 66rem) 64rem, 100vw",
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
  return [...ids];
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
  return html.replace(MEDIA_PLACEHOLDER, (_, text: string) => {
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
    const srcset = widths
      .map((width) => `${origin}${variantUrl(item, width)} ${width}w`)
      .join(", ");
    const sizes =
      size === "logo"
        ? `${Math.round((LOGO_HEIGHT_PX * item.width) / item.height)}px`
        : (SIZES[size] as string);
    const eager = first && size !== "logo";
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
}): string {
  const parts = [`data-id="${escapeHtml(input.id)}"`, `data-size="${escapeHtml(input.size)}"`];
  if (input.alt) parts.push(`data-alt="${escapeHtml(input.alt)}"`);
  if (input.decorative) parts.push('data-decorative=""');
  return `<tend-image ${parts.join(" ")}></tend-image>`;
}
