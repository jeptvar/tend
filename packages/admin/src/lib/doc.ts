// The document format the server stores (PLAN.md §8, and content/doc.ts on the server).
// The editor adds extras of its own, like a link's target, and the server refuses anything
// it doesn't allow. So everything is put in this one tidy form before it's compared or sent.

export interface DocMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface DocNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: DocNode[];
  marks?: DocMark[];
  text?: string;
}

export interface Doc {
  type: "doc";
  content: DocNode[];
}

const ENTRY_LINK = /^entry:[0-9a-f-]{36}$/;
const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

/** The same rule as the server. A link it would refuse must never stop a whole save. */
export function isAllowedHref(href: string): boolean {
  if (href === "" || href.length > 2048) return false;
  if (ENTRY_LINK.test(href)) return true;
  try {
    const url = new URL(href, "https://relative.invalid/");
    // Browsers quietly turn a space in a web address's name into %20. The server refuses
    // such an address, so the link would only be thrown away there.
    return ALLOWED_PROTOCOLS.has(url.protocol) && !url.hostname.includes("%");
  } catch {
    return false;
  }
}

const SIMPLE_MARKS = new Set(["bold", "italic", "underline", "strike", "code"]);
const BUTTON_LABEL_LIMIT = 200;
const SECTION_KINDS = new Set(["intro", "pictureText", "contact"]);
const SECTION_TONES = new Set(["none", "muted", "accent"]);
const SECTION_ALIGNS = new Set(["left", "center"]);
const IMAGE_SIZES = new Set(["normal", "wide", "full"]);
const MEDIA_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IMAGE_TEXT_LIMIT = 1000;

export function isMediaId(value: unknown): value is string {
  return typeof value === "string" && MEDIA_ID.test(value);
}

/** Blank is "nothing", as the server stores it. */
function optionalText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed.slice(0, IMAGE_TEXT_LIMIT);
}

/** What the server would refuse must be tidied here. Pasted HTML can set anything at all. */
function oneOf(value: unknown, allowed: Set<string>, fallback: string): string {
  return typeof value === "string" && allowed.has(value) ? value : fallback;
}

function cleanMarks(marks: DocMark[] | undefined): DocMark[] | undefined {
  const cleaned = (marks ?? []).flatMap((mark): DocMark[] => {
    if (SIMPLE_MARKS.has(mark.type)) return [{ type: mark.type }];
    if (mark.type === "link" && typeof mark.attrs?.href === "string") {
      const href = mark.attrs.href.trim();
      return isAllowedHref(href) ? [{ type: "link", attrs: { href } }] : [];
    }
    return [];
  });
  return cleaned.length > 0 ? cleaned : undefined;
}

function cleanNode(node: DocNode): DocNode | null {
  const content = () => node.content?.flatMap((child) => cleanNode(child) ?? []);
  const withContent = (base: DocNode): DocNode => {
    const children = content();
    return children ? { ...base, content: children } : base;
  };
  switch (node.type) {
    case "paragraph":
    case "blockquote":
    case "bulletList":
    case "listItem":
    case "codeBlock":
      return withContent({ type: node.type });
    case "heading":
      return withContent({ type: "heading", attrs: { level: node.attrs?.level } });
    case "orderedList": {
      const start = node.attrs?.start;
      return withContent(
        Number.isSafeInteger(start) && start !== 1
          ? { type: "orderedList", attrs: { start } }
          : { type: "orderedList" },
      );
    }
    case "horizontalRule":
      return { type: "horizontalRule" };
    case "button": {
      const href = typeof node.attrs?.href === "string" ? node.attrs.href.trim() : "";
      return {
        type: "button",
        attrs: {
          href: isAllowedHref(href) ? href : "",
          label:
            typeof node.attrs?.label === "string"
              ? node.attrs.label.slice(0, BUTTON_LABEL_LIMIT)
              : "",
        },
      };
    }
    case "image":
      // One still uploading isn't part of what's saved yet. It is once it arrives.
      if (!isMediaId(node.attrs?.mediaId)) return null;
      return {
        type: "image",
        attrs: {
          mediaId: node.attrs.mediaId,
          alt: optionalText(node.attrs.alt),
          decorative: node.attrs.decorative === true,
          caption: optionalText(node.attrs.caption),
          size: oneOf(node.attrs.size, IMAGE_SIZES, "normal"),
        },
      };
    case "section":
      return withContent({
        type: "section",
        attrs: {
          kind: oneOf(node.attrs?.kind, SECTION_KINDS, "intro"),
          preset:
            typeof node.attrs?.preset === "string" && /^[a-z0-9-]{1,32}$/.test(node.attrs.preset)
              ? node.attrs.preset
              : "1",
          tone: oneOf(node.attrs?.tone, SECTION_TONES, "none"),
          align: oneOf(node.attrs?.align, SECTION_ALIGNS, "left"),
        },
      });
    case "text": {
      if (!node.text) return null;
      const marks = cleanMarks(node.marks);
      return { type: "text", text: node.text, ...(marks ? { marks } : {}) };
    }
    case "hardBreak": {
      const marks = cleanMarks(node.marks);
      return { type: "hardBreak", ...(marks ? { marks } : {}) };
    }
    default:
      return null;
  }
}

function isEmptyParagraph(node: DocNode | undefined): boolean {
  return node?.type === "paragraph" && (node.content ?? []).length === 0;
}

/** The tidy form. The empty lines the editor always keeps at the end aren't part of what's written. */
export function cleanDoc(doc: { content?: DocNode[] }): Doc {
  const content = (doc.content ?? []).flatMap((node) => cleanNode(node) ?? []);
  while (isEmptyParagraph(content.at(-1))) content.pop();
  return { type: "doc", content };
}

export function sameDoc(a: Doc, b: Doc): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function nodeText(node: DocNode): string {
  if (node.type === "hardBreak") return "\n";
  if (node.type === "button") return String(node.attrs?.label ?? "");
  if (node.type === "image") return String(node.attrs?.caption ?? "");
  return node.text ?? (node.content ?? []).map(nodeText).join("");
}

const CONTAINERS = new Set(["bulletList", "orderedList", "listItem", "blockquote", "section"]);

function blocksText(nodes: DocNode[]): string[] {
  return nodes.flatMap((node) =>
    CONTAINERS.has(node.type) ? blocksText(node.content ?? []) : [nodeText(node)],
  );
}

/** The first paragraph's words: the server's rule for an automatic summary. */
export function leadText(doc: Doc): string {
  const find = (nodes: DocNode[]): string => {
    for (const node of nodes) {
      if (node.type === "paragraph") {
        const words = nodeText(node).trim();
        if (words) return words;
      } else if (node.type === "section") {
        const words = find(node.content ?? []);
        if (words) return words;
      }
    }
    return "";
  };
  return find(doc.content);
}

/** Every picture a document shows, for looking them up together. */
export function imageIds(doc: { content?: DocNode[] }): string[] {
  const found = new Set<string>();
  const visit = (nodes: DocNode[] | undefined) => {
    for (const node of nodes ?? []) {
      if (node.type === "image" && isMediaId(node.attrs?.mediaId)) found.add(node.attrs.mediaId);
      visit(node.content);
    }
  };
  visit(doc.content);
  return [...found];
}

/** The words alone: what to show when comparing versions, or for a summary. */
export function docToText(doc: Doc): string {
  return blocksText(doc.content)
    .filter((block) => block !== "")
    .join("\n\n");
}
