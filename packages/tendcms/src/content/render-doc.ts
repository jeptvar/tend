import {
  type BlockNode,
  type Doc,
  type InlineNode,
  isAllowedHref,
  isMediaId,
  type Mark,
} from "./doc.ts";

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => ESCAPES[character] ?? character);
}

export interface RenderedDoc {
  /** Safe to print as it is: everything people typed has been escaped. */
  html: string;
  /** Plain text, with a blank line between blocks. */
  text: string;
}

// In stored HTML, links to other entries are placeholders, resolved when a page is rendered,
// so moving or unpublishing a page updates everything that links to it (PLAN.md §8).
const ENTRY_PREFIX = "entry:";
const PLACEHOLDER_PREFIX = "tend:entry:";

function hrefAttribute(href: string): string {
  return href.startsWith(ENTRY_PREFIX)
    ? `${PLACEHOLDER_PREFIX}${href.slice(ENTRY_PREFIX.length)}`
    : escapeHtml(href);
}

const MARK_TAGS: Record<string, string> = {
  bold: "strong",
  italic: "em",
  underline: "u",
  strike: "s",
  code: "code",
};

function applyMarks(html: string, marks: Mark[] | undefined): string {
  // Links go on the outside, so the tags always nest properly.
  const ordered = [...(marks ?? [])].sort(
    (a, b) => Number(a.type === "link") - Number(b.type === "link"),
  );
  let result = html;
  for (const mark of ordered) {
    if (mark.type === "link") {
      if (isAllowedHref(mark.attrs.href)) {
        result = `<a href="${hrefAttribute(mark.attrs.href)}">${result}</a>`;
      }
    } else {
      const tag = MARK_TAGS[mark.type];
      if (tag) result = `<${tag}>${result}</${tag}>`;
    }
  }
  return result;
}

function renderInline(nodes: InlineNode[] | undefined): { html: string; text: string } {
  let html = "";
  let text = "";
  for (const node of nodes ?? []) {
    if (node.type === "text") {
      html += applyMarks(escapeHtml(node.text), node.marks);
      text += node.text;
    } else if (node.type === "hardBreak") {
      html += "<br>";
      text += "\n";
    }
  }
  return { html, text };
}

const SECTION_CLASSES: Record<string, string> = {
  intro: "t-intro",
  pictureText: "t-picture-text",
  contact: "t-contact",
};

const IMAGE_SIZES = new Set(["normal", "wide", "full"]);

/**
 * A picture is stored as a placeholder naming it, and becomes a real one when a page is
 * shown, so replacing it or changing its description in Media changes every page at once.
 * Inside a Picture and text section it takes half the width, whatever it was set to.
 */
function imagePlaceholder(
  attrs: Extract<BlockNode, { type: "image" }>["attrs"],
  section: string | undefined,
): string {
  const size =
    section === "pictureText" ? "half" : IMAGE_SIZES.has(attrs.size) ? attrs.size : "normal";
  const parts = [`data-id="${attrs.mediaId}"`, `data-size="${size}"`];
  if (attrs.alt) parts.push(`data-alt="${escapeHtml(attrs.alt)}"`);
  if (attrs.decorative === true) parts.push('data-decorative=""');
  if (attrs.caption) parts.push(`data-caption="${escapeHtml(attrs.caption)}"`);
  return `<tend-image ${parts.join(" ")}></tend-image>`;
}

/**
 * Turns a document into the HTML visitors get. Stored documents are validated when saved,
 * but this still only knows the node types it can make safe. Anything else is dropped, so
 * a bad row in the database can't put markup on the page.
 */
function renderBlocks(
  blocks: readonly BlockNode[] | undefined,
  out: RenderedDoc,
  section?: string,
): void {
  const html: string[] = [];
  const text: string[] = [];

  const child = (nodes: readonly BlockNode[] | undefined, inSection = section) => {
    const inner: RenderedDoc = { html: "", text: "" };
    renderBlocks(nodes, inner, inSection);
    if (inner.text) text.push(inner.text);
    return inner.html;
  };

  for (const block of blocks ?? []) {
    switch (block.type) {
      case "paragraph": {
        const inline = renderInline(block.content);
        if (inline.text.trim() === "") break;
        html.push(`<p>${inline.html}</p>`);
        text.push(inline.text);
        break;
      }
      case "heading": {
        const level = [2, 3, 4].includes(block.attrs?.level) ? block.attrs.level : 2;
        const inline = renderInline(block.content);
        if (inline.text.trim() === "") break;
        html.push(`<h${level}>${inline.html}</h${level}>`);
        text.push(inline.text);
        break;
      }
      case "bulletList":
      case "orderedList": {
        // An empty bullet is just a stray line left over from editing.
        const items = (block.content ?? [])
          .map((item) => child(item.content))
          .filter((inner) => inner !== "")
          .map((inner) => `<li>${inner}</li>`)
          .join("");
        if (items === "") break;
        if (block.type === "bulletList") {
          html.push(`<ul>${items}</ul>`);
        } else {
          const start = block.attrs?.start;
          html.push(
            Number.isSafeInteger(start) && start !== 1
              ? `<ol start="${start}">${items}</ol>`
              : `<ol>${items}</ol>`,
          );
        }
        break;
      }
      case "blockquote": {
        const inner = child(block.content);
        if (inner !== "") html.push(`<blockquote>${inner}</blockquote>`);
        break;
      }
      case "codeBlock": {
        const code = (block.content ?? []).map((node) => node.text ?? "").join("");
        if (code.trim() === "") break;
        html.push(`<pre><code>${escapeHtml(code)}</code></pre>`);
        text.push(code);
        break;
      }
      case "horizontalRule":
        html.push("<hr>");
        break;
      case "button": {
        const { href, label } = block.attrs ?? { href: "", label: "" };
        if (!label || !isAllowedHref(href)) break;
        html.push(
          `<p class="t-button-row"><a class="t-button" href="${hrefAttribute(href)}">${escapeHtml(label)}</a></p>`,
        );
        text.push(label);
        break;
      }
      case "image": {
        if (!isMediaId(block.attrs?.mediaId)) break;
        html.push(imagePlaceholder(block.attrs, section));
        if (block.attrs.caption) text.push(block.attrs.caption);
        break;
      }
      case "section": {
        const { kind, tone, align, preset } = block.attrs ?? {};
        const name = SECTION_CLASSES[kind];
        if (!name) break;
        const classes = [
          name,
          `t-tone-${escapeHtml(tone ?? "none")}`,
          `t-align-${escapeHtml(align ?? "left")}`,
        ];
        let inner = child(block.content, kind);
        // Contact & hours shows the business details from Settings, filled in when the page
        // is shown, so they're typed once and are the same everywhere.
        if (kind === "contact") inner += "<tend-business></tend-business>";
        if (inner === "") break;
        html.push(
          `<section class="${classes.join(" ")}" data-preset="${escapeHtml(preset ?? "1")}">${inner}</section>`,
        );
        break;
      }
    }
  }
  out.html = html.join("\n");
  out.text = text.join("\n\n");
}

/**
 * Which renderer a published version's stored HTML came from (PLAN.md §8). Raise it whenever
 * renderDoc's output changes for any document. Tend then renders every published version
 * again when it starts (content/rerender.ts), so the change, an escaping fix above all,
 * reaches pages that are already on the site. A test in content.test.ts fails until it's
 * raised.
 */
export const RENDER_VERSION = 1;

export function renderDoc(doc: Doc): RenderedDoc {
  const out: RenderedDoc = { html: "", text: "" };
  renderBlocks(doc.content, out);
  return out;
}

const SUMMARY_LENGTH = 160;

/**
 * The words of the first paragraph, which is what an automatic summary is made from: not a
 * heading, a button or a list that happens to come first. A Big intro's words count.
 */
export function leadText(doc: Doc): string {
  const find = (blocks: readonly BlockNode[] | undefined): string => {
    for (const block of blocks ?? []) {
      if (block.type === "paragraph") {
        const words = renderInline(block.content).text.trim();
        if (words) return words;
      } else if (block.type === "section") {
        const words = find(block.content);
        if (words) return words;
      }
    }
    return "";
  };
  return find(doc.content);
}

/** The start of the first paragraph, cut at a word. */
export function summarize(text: string): string {
  const first = (text.split("\n\n")[0] ?? "").replace(/\s+/g, " ").trim();
  if ([...first].length <= SUMMARY_LENGTH) return first;
  const cut = [...first].slice(0, SUMMARY_LENGTH).join("");
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

const PLACEHOLDER_LINK = /<a( class="t-button")? href="tend:entry:([0-9a-f-]{36})">(.*?)<\/a>/gs;

/** The entries a piece of stored HTML links to. */
export function placeholderIds(html: string): string[] {
  return [...new Set([...html.matchAll(PLACEHOLDER_LINK)].map((match) => match[2] as string))];
}

/**
 * Turns placeholders into real addresses. A link to something that isn't on the site right
 * now becomes plain text, so visitors never hit a dead end. Only markup this renderer wrote
 * can match, because everything typed has already been escaped.
 */
export function resolvePlaceholders(html: string, paths: ReadonlyMap<string, string>): string {
  return html.replace(
    PLACEHOLDER_LINK,
    (_, classAttribute: string | undefined, id: string, inner: string) => {
      const path = paths.get(id);
      return path ? `<a${classAttribute ?? ""} href="${escapeHtml(path)}">${inner}</a>` : inner;
    },
  );
}
