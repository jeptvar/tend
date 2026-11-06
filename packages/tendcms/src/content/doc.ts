import { z } from "zod";

// The document format is the one the real editor will use (PLAN.md §8), so nothing
// has to be converted when it arrives. For now it only allows what a plain text box
// can produce: anything else is refused, which is the allowlist doing its job.
const textNode = z.strictObject({ type: z.literal("text"), text: z.string().min(1) });
const hardBreak = z.strictObject({ type: z.literal("hardBreak") });
const paragraph = z.strictObject({
  type: z.literal("paragraph"),
  content: z.array(z.union([textNode, hardBreak])).optional(),
});

export const docSchema = z.strictObject({
  type: z.literal("doc"),
  content: z.array(paragraph),
});

export type Doc = z.infer<typeof docSchema>;

export interface EntryData {
  doc: Doc;
  /** Null means "fill in automatically". The same goes for the seo fields. */
  summary: string | null;
  featuredImage: null;
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
    .map((block) => {
      const lines = block.split("\n").map((line) => line.trim());
      return {
        type: "paragraph" as const,
        content: lines.flatMap((line, index) => [
          ...(index > 0 ? [{ type: "hardBreak" as const }] : []),
          ...(line ? [{ type: "text" as const, text: line }] : []),
        ]),
      };
    });
  return { type: "doc", content };
}
