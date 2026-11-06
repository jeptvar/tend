import type { Doc } from "./doc.ts";

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => ESCAPES[character] ?? character);
}

export interface RenderedDoc {
  /** Safe to print as it is: everything people typed has been escaped. */
  html: string;
  /** Plain text, with a blank line between paragraphs. */
  text: string;
}

/**
 * Turns a document into the HTML visitors get. Stored documents are validated when
 * saved, but this still only knows the node types it can make safe. Anything else is
 * dropped, so a bad row in the database can't put markup on the page.
 */
export function renderDoc(doc: Doc): RenderedDoc {
  const html: string[] = [];
  const text: string[] = [];
  for (const block of doc.content) {
    if (block.type !== "paragraph") continue;
    let blockHtml = "";
    let blockText = "";
    for (const node of block.content ?? []) {
      if (node.type === "text") {
        blockHtml += escapeHtml(node.text);
        blockText += node.text;
      } else if (node.type === "hardBreak") {
        blockHtml += "<br>";
        blockText += "\n";
      }
    }
    if (blockText.trim() === "") continue;
    html.push(`<p>${blockHtml}</p>`);
    text.push(blockText);
  }
  return { html: html.join("\n"), text: text.join("\n\n") };
}

const SUMMARY_LENGTH = 160;

/** The start of the first paragraph, cut at a word. */
export function summarize(text: string): string {
  const first = (text.split("\n\n")[0] ?? "").replace(/\s+/g, " ").trim();
  if ([...first].length <= SUMMARY_LENGTH) return first;
  const cut = [...first].slice(0, SUMMARY_LENGTH).join("");
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
