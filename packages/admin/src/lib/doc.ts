// The plain text box stands in for the real editor until it arrives, so this converts
// between what's typed and the document format the server stores.

export type DocNode = { type: "text"; text: string } | { type: "hardBreak" };
export interface Doc {
  type: "doc";
  content: { type: "paragraph"; content?: DocNode[] }[];
}

/** Blank lines separate paragraphs, and a single line break stays a line break. */
export function textToDoc(text: string): Doc {
  const content = text
    .replace(/\r\n?/g, "\n")
    .split(/\n[^\S\n]*\n\s*/)
    .map((block) => block.trim())
    .filter((block) => block !== "")
    .map((block) => {
      const lines = block.split("\n").map((line) => line.trim());
      return {
        type: "paragraph" as const,
        content: lines.flatMap((line, index): DocNode[] => [
          ...(index > 0 ? [{ type: "hardBreak" as const }] : []),
          ...(line ? [{ type: "text" as const, text: line }] : []),
        ]),
      };
    });
  return { type: "doc", content };
}

export function docToText(doc: Doc): string {
  return doc.content
    .map((block) =>
      (block.content ?? []).map((node) => (node.type === "text" ? node.text : "\n")).join(""),
    )
    .join("\n\n");
}
