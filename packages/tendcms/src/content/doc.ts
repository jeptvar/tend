import { z } from "zod";

// The document format (PLAN.md §8). Only what's listed here can be stored, and it's
// checked by hand rather than with a recursive schema so that depth and size are limited
// first: a deeply nested document could otherwise overflow the stack and take the request
// down with it.

const MAX_DEPTH = 40;
const MAX_NODES = 100_000;

const HEADING_LEVELS = new Set([2, 3, 4]);
const SECTION_KINDS = new Set(["intro", "pictureText", "contact"]);
const SECTION_TONES = new Set(["none", "muted", "accent"]);
const SECTION_ALIGNS = new Set(["left", "center"]);
const SIMPLE_MARKS = new Set(["bold", "italic", "underline", "strike", "code"]);
const IMAGE_SIZES = new Set(["normal", "wide", "full"]);
const MEDIA_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IMAGE_TEXT_LIMIT = 1000;

export type Mark =
  | { type: "bold" | "italic" | "underline" | "strike" | "code" }
  | { type: "link"; attrs: { href: string } };

export type InlineNode =
  | { type: "text"; text: string; marks?: Mark[] }
  | { type: "hardBreak"; marks?: Mark[] };

export type BlockNode =
  | { type: "paragraph"; content?: InlineNode[] }
  | { type: "heading"; attrs: { level: 2 | 3 | 4 }; content?: InlineNode[] }
  | { type: "bulletList"; content: ListItem[] }
  | { type: "orderedList"; attrs?: { start: number }; content: ListItem[] }
  | { type: "blockquote"; content: BlockNode[] }
  | { type: "codeBlock"; content?: { type: "text"; text: string }[] }
  | { type: "horizontalRule" }
  | { type: "button"; attrs: { href: string; label: string } }
  | { type: "image"; attrs: ImageAttrs }
  | { type: "section"; attrs: SectionAttrs; content: BlockNode[] };

export interface ImageAttrs {
  mediaId: string;
  /** Null uses the description from Media, so changing it there changes it everywhere. */
  alt: string | null;
  decorative: boolean;
  caption: string | null;
  size: "normal" | "wide" | "full";
}

export interface FeaturedImage {
  mediaId: string;
  alt: string | null;
}

export interface ListItem {
  type: "listItem";
  content: BlockNode[];
}

export interface SectionAttrs {
  kind: "intro" | "pictureText" | "contact";
  preset: string;
  tone: "none" | "muted" | "accent";
  align: "left" | "center";
}

export interface Doc {
  type: "doc";
  content: BlockNode[];
}

export interface EntryData {
  doc: Doc;
  /** Null means "fill in automatically". The same goes for the seo fields. */
  summary: string | null;
  featuredImage: FeaturedImage | null;
  seo: {
    title: string | null;
    description: string | null;
    imageId: string | null;
    noindex: boolean;
  };
  tagIds: string[];
  showInMenu: boolean;
  fields: Record<string, never>;
}

export function newEntryData(doc: Doc = { type: "doc", content: [] }): EntryData {
  return {
    doc,
    summary: null,
    featuredImage: null,
    seo: { title: null, description: null, imageId: null, noindex: false },
    tagIds: [],
    showInMenu: false,
    fields: {},
  };
}

/** Blank lines separate paragraphs, and a single line break stays a line break. */
export function textToDoc(text: string): Doc {
  const content = text
    .replace(/\r\n?/g, "\n")
    .split(/\n[^\S\n]*\n\s*/)
    .map((block) => block.trim())
    .filter((block) => block !== "")
    .map((block): BlockNode => {
      const lines = block.split("\n").map((line) => line.trim());
      return {
        type: "paragraph",
        content: lines.flatMap((line, index): InlineNode[] => [
          ...(index > 0 ? [{ type: "hardBreak" as const }] : []),
          ...(line ? [{ type: "text" as const, text: line }] : []),
        ]),
      };
    });
  return { type: "doc", content };
}

const ENTRY_LINK = /^entry:[0-9a-f-]{36}$/;
const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

/**
 * Whether an address is safe to put on a page: web, email and phone links, paths on this
 * site, and links to another entry by its ID. Everything else is refused, including
 * javascript: however it's disguised, which is why this asks the URL parser rather than
 * looking at the text.
 */
export function isAllowedHref(href: string): boolean {
  if (href === "" || href.length > 2048) return false;
  if (ENTRY_LINK.test(href)) return true;
  let url: URL;
  try {
    url = new URL(href, "https://relative.invalid/");
  } catch {
    return false;
  }
  return ALLOWED_PROTOCOLS.has(url.protocol);
}

export class DocProblem extends Error {}

export function isMediaId(value: unknown): value is string {
  return typeof value === "string" && MEDIA_ID.test(value);
}

function optionalText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed.slice(0, IMAGE_TEXT_LIMIT);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class Validator {
  nodes = 0;
  readonly allowSections: boolean;

  constructor(allowSections: boolean) {
    this.allowSections = allowSections;
  }

  #count(depth: number): void {
    this.nodes++;
    if (this.nodes > MAX_NODES) throw new DocProblem("too many nodes");
    if (depth > MAX_DEPTH) throw new DocProblem("nested too deeply");
  }

  marks(value: unknown): Mark[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) throw new DocProblem("marks must be a list");
    // One of each kind. Two links on the same words would nest, which isn't valid HTML.
    const seen = new Set<string>();
    const keep = (mark: Mark): Mark[] => {
      if (seen.has(mark.type)) return [];
      seen.add(mark.type);
      return [mark];
    };
    const marks = value.flatMap((mark): Mark[] => {
      if (!isObject(mark) || typeof mark.type !== "string") throw new DocProblem("bad mark");
      if (SIMPLE_MARKS.has(mark.type)) return keep({ type: mark.type as "bold" });
      if (mark.type === "link" && isObject(mark.attrs) && typeof mark.attrs.href === "string") {
        const href = mark.attrs.href.trim();
        // An address that isn't allowed loses its link and keeps its words. Refusing the
        // whole document would stop everything else being saved because of one link.
        return isAllowedHref(href) ? keep({ type: "link", attrs: { href } }) : [];
      }
      throw new DocProblem(`unknown mark ${mark.type}`);
    });
    return marks.length > 0 ? marks : undefined;
  }

  inline(value: unknown, depth: number): InlineNode[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) throw new DocProblem("content must be a list");
    return value.map((node): InlineNode => {
      this.#count(depth);
      if (!isObject(node)) throw new DocProblem("bad node");
      const marks = this.marks(node.marks);
      if (node.type === "text") {
        if (typeof node.text !== "string" || node.text === "") throw new DocProblem("bad text");
        return { type: "text", text: node.text, ...(marks ? { marks } : {}) };
      }
      if (node.type === "hardBreak") return { type: "hardBreak", ...(marks ? { marks } : {}) };
      throw new DocProblem(`unknown inline node ${String(node.type)}`);
    });
  }

  blocks(value: unknown, depth: number): BlockNode[] {
    if (!Array.isArray(value)) throw new DocProblem("content must be a list");
    return value.flatMap((node) => this.block(node, depth) ?? []);
  }

  items(value: unknown, depth: number): ListItem[] {
    if (!Array.isArray(value)) throw new DocProblem("content must be a list");
    return value.map((item): ListItem => {
      this.#count(depth);
      if (!isObject(item) || item.type !== "listItem") throw new DocProblem("bad list item");
      return { type: "listItem", content: this.blocks(item.content, depth + 1) };
    });
  }

  /** A node, cleaned up, or nothing for one that can be left out without losing words. */
  block(node: unknown, depth: number): BlockNode | undefined {
    this.#count(depth);
    if (!isObject(node)) throw new DocProblem("bad node");
    const attrs = isObject(node.attrs) ? node.attrs : {};
    switch (node.type) {
      case "paragraph": {
        const content = this.inline(node.content, depth + 1);
        return { type: "paragraph", ...(content ? { content } : {}) };
      }
      case "heading": {
        if (!HEADING_LEVELS.has(attrs.level as number)) throw new DocProblem("bad heading level");
        const content = this.inline(node.content, depth + 1);
        return {
          type: "heading",
          attrs: { level: attrs.level as 2 | 3 | 4 },
          ...(content ? { content } : {}),
        };
      }
      case "bulletList":
        return { type: "bulletList", content: this.items(node.content, depth + 1) };
      case "orderedList": {
        const start = attrs.start;
        const content = this.items(node.content, depth + 1);
        return Number.isSafeInteger(start) && start !== 1
          ? { type: "orderedList", attrs: { start: start as number }, content }
          : { type: "orderedList", content };
      }
      case "blockquote":
        return { type: "blockquote", content: this.blocks(node.content, depth + 1) };
      case "codeBlock": {
        const content = this.inline(node.content, depth + 1);
        if (content?.some((child) => child.type !== "text" || child.marks)) {
          throw new DocProblem("code blocks hold plain text");
        }
        return {
          type: "codeBlock",
          ...(content ? { content: content as { type: "text"; text: string }[] } : {}),
        };
      }
      case "horizontalRule":
        return { type: "horizontalRule" };
      case "button": {
        const { href, label } = attrs;
        if (typeof href !== "string" || typeof label !== "string" || label.length > 200) {
          throw new DocProblem("bad button");
        }
        // The same goes for a button: it keeps its words, and goes nowhere until it's fixed.
        const safe = isAllowedHref(href.trim()) ? href.trim() : "";
        return { type: "button", attrs: { href: safe, label } };
      }
      case "image": {
        // A picture still uploading has nothing to show yet. It's saved once it arrives.
        if (!isMediaId(attrs.mediaId)) return undefined;
        return {
          type: "image",
          attrs: {
            mediaId: attrs.mediaId,
            alt: optionalText(attrs.alt),
            decorative: attrs.decorative === true,
            caption: optionalText(attrs.caption),
            size: IMAGE_SIZES.has(attrs.size as string)
              ? (attrs.size as ImageAttrs["size"])
              : "normal",
          },
        };
      }
      case "section": {
        if (!this.allowSections) throw new DocProblem("sections are for pages");
        if (depth !== 0) throw new DocProblem("sections can't go inside anything");
        const { kind, preset, tone, align } = attrs;
        if (!SECTION_KINDS.has(kind as string)) throw new DocProblem("bad section");
        return {
          type: "section",
          attrs: {
            kind: kind as SectionAttrs["kind"],
            preset: typeof preset === "string" && /^[a-z0-9-]{1,32}$/.test(preset) ? preset : "1",
            tone: SECTION_TONES.has(tone as string) ? (tone as SectionAttrs["tone"]) : "none",
            align: SECTION_ALIGNS.has(align as string) ? (align as SectionAttrs["align"]) : "left",
          },
          content: this.blocks(node.content, depth + 1),
        };
      }
      default:
        throw new DocProblem(`unknown block ${String(node.type)}`);
    }
  }
}

/** Checks a document that came from outside and returns a clean copy with only what's allowed. */
export function parseDoc(value: unknown, options: { allowSections: boolean }): Doc {
  if (!isObject(value) || value.type !== "doc") throw new DocProblem("not a document");
  return {
    type: "doc",
    content: new Validator(options.allowSections).blocks(value.content, 0),
  };
}

/** Accepts anything that's shaped like a document here. parseDoc does the real checking. */
export const docField = z.custom<unknown>((value) => isObject(value));

/** A featured image as sent by the editor, or null for none. */
export function parseFeaturedImage(value: unknown): FeaturedImage | null {
  if (!isObject(value) || !isMediaId(value.mediaId)) return null;
  return { mediaId: value.mediaId, alt: optionalText(value.alt) };
}

/** Every picture a version shows: in its text, as its featured image or for sharing. */
export function shownMediaIds(data: Pick<EntryData, "doc" | "featuredImage" | "seo">): string[] {
  const found = new Set<string>();
  const visit = (nodes: readonly (BlockNode | ListItem)[]) => {
    for (const node of nodes) {
      if (node.type === "image") found.add(node.attrs.mediaId);
      if ("content" in node && node.content) visit(node.content as (BlockNode | ListItem)[]);
    }
  };
  visit(data.doc.content);
  if (data.featuredImage) found.add(data.featuredImage.mediaId);
  if (data.seo?.imageId) found.add(data.seo.imageId);
  return [...found];
}

/**
 * Every picture and file a version uses: the pictures it shows, and whatever its links and
 * buttons lead to. A PDF is only ever on a page as a link, so without those it would never
 * count as used, and could be deleted forever from under a published page.
 */
export function usedMediaIds(data: Pick<EntryData, "doc" | "featuredImage" | "seo">): string[] {
  return [...new Set([...shownMediaIds(data), ...linkedMediaIds(data.doc)])];
}

/** The first picture in the text, which stands in when no featured image is chosen. */
export function firstImageId(doc: Doc): string | null {
  const find = (nodes: readonly (BlockNode | ListItem)[]): string | null => {
    for (const node of nodes) {
      if (node.type === "image") return node.attrs.mediaId;
      if ("content" in node && node.content) {
        const found = find(node.content as (BlockNode | ListItem)[]);
        if (found) return found;
      }
    }
    return null;
  };
  return find(doc.content);
}

/** Calls back with the address of every link and button in a document. */
function eachHref(doc: Doc, visit: (href: string) => void): void {
  const walk = (nodes: readonly (BlockNode | InlineNode | ListItem)[]) => {
    for (const node of nodes) {
      if (node.type === "button") visit(node.attrs.href);
      if ("marks" in node) {
        for (const mark of node.marks ?? []) {
          if (mark.type === "link") visit(mark.attrs.href);
        }
      }
      if ("content" in node && node.content) walk(node.content);
    }
  };
  walk(doc.content);
}

/** Every other entry this document links to. */
export function linkedEntryIds(doc: Doc): string[] {
  const found = new Set<string>();
  eachHref(doc, (href) => {
    if (ENTRY_LINK.test(href)) found.add(href.slice("entry:".length));
  });
  return [...found];
}

const MEDIA_PATH = /^\/media\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//;

/**
 * The picture or file a link leads to, when it's one in Media: its address as a page shows
 * it, or as Copy address gives it, with the site's own origin in front. Any origin counts,
 * because the site's own address isn't always known (on localhost, or behind a proxy), and
 * an ID only ever belongs to one file.
 */
export function mediaIdInHref(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href, "https://relative.invalid/");
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  let path = url.pathname;
  try {
    // An address with its letters written as %-codes still reaches the file.
    path = decodeURIComponent(path);
  } catch {
    // Not a %-code after all: the address as written is all there is to go on.
  }
  return MEDIA_PATH.exec(path)?.[1] ?? null;
}

/** Every picture and file in Media that this document's links and buttons lead to. */
export function linkedMediaIds(doc: Doc): string[] {
  const found = new Set<string>();
  eachHref(doc, (href) => {
    const id = mediaIdInHref(href);
    if (id) found.add(id);
  });
  return [...found];
}
