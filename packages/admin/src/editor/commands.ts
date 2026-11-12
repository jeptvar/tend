import type { Editor } from "@tiptap/core";

export interface InsertItem {
  id: string;
  /** More words people might type for this, in the "/" menu. */
  keywords: string;
  pagesOnly?: boolean;
  /** Whether it worked. Some things can't go where the cursor is, like a quote in a bullet. */
  run: (editor: Editor, helpers: { askForButton: () => void }) => boolean;
}

/** Steps out of any lists and quotes, so a big block doesn't leave an empty line behind. */
function liftOutOfContainers(editor: Editor): void {
  for (let guard = 0; guard < 32; guard++) {
    const { $from } = editor.state.selection;
    if ($from.depth <= 1 || $from.parent.content.size > 0) return;
    if (!editor.commands.liftListItem("listItem") && !editor.commands.lift("blockquote")) return;
  }
}

/** Puts a big block after the top-level one the cursor's in, replacing it if that's empty. */
function insertAtTopLevel(editor: Editor, content: Record<string, unknown>): boolean {
  liftOutOfContainers(editor);
  const { $from } = editor.state.selection;
  const block = $from.node(1);
  const isEmptyParagraph = block?.type.name === "paragraph" && block.content.size === 0;
  const position = block
    ? isEmptyParagraph
      ? $from.before(1)
      : $from.after(1)
    : editor.state.doc.content.size;
  const range = isEmptyParagraph ? { from: position, to: $from.after(1) } : position;
  return (
    editor
      .chain()
      .focus()
      .insertContentAt(range, content)
      // Into the first thing inside it, ready to type.
      .setTextSelection(position + 2)
      .run()
  );
}

/** Everything that can be added, in the "/" menu and behind the Insert button. */
export const INSERT_ITEMS: InsertItem[] = [
  {
    id: "heading2",
    keywords: "heading title header big h2",
    run: (editor) => editor.chain().focus().setHeading({ level: 2 }).run(),
  },
  {
    id: "heading3",
    keywords: "subheading heading title header medium h3",
    run: (editor) => editor.chain().focus().setHeading({ level: 3 }).run(),
  },
  {
    id: "heading4",
    keywords: "small heading title header h4",
    run: (editor) => editor.chain().focus().setHeading({ level: 4 }).run(),
  },
  {
    id: "bulletList",
    keywords: "bullet bulleted list unordered dots points ul",
    run: (editor) => editor.chain().focus().toggleBulletList().run(),
  },
  {
    id: "orderedList",
    keywords: "numbered list ordered steps ol",
    run: (editor) => editor.chain().focus().toggleOrderedList().run(),
  },
  {
    id: "quote",
    keywords: "quote blockquote citation said",
    run: (editor) => editor.chain().focus().toggleBlockquote().run(),
  },
  {
    id: "code",
    keywords: "code snippet monospace programming pre",
    run: (editor) => editor.chain().focus().toggleCodeBlock().run(),
  },
  {
    id: "divider",
    keywords: "divider line rule separator horizontal hr break",
    run: (editor) => editor.chain().focus().setHorizontalRule().run(),
  },
  {
    id: "button",
    keywords: "button link call action click",
    run: (_editor, { askForButton }) => {
      askForButton();
      return true;
    },
  },
  {
    id: "intro",
    keywords: "big intro section hero welcome banner top",
    pagesOnly: true,
    run: (editor) =>
      insertAtTopLevel(editor, {
        type: "section",
        attrs: { kind: "intro", preset: "1", tone: "none", align: "left" },
        content: [{ type: "heading", attrs: { level: 2 } }, { type: "paragraph" }],
      }),
  },
];

/**
 * What matches, best first: a name that starts with what was typed, then a word in the name,
 * then another word for it, then anything containing it. So "/di" is Divider, not Heading.
 */
export function matchingItems(items: InsertItem[], query: string, nameOf: (id: string) => string) {
  const words = query.trim().toLowerCase();
  if (!words) return items;
  const rank = (item: InsertItem): number => {
    const name = nameOf(item.id).toLowerCase();
    if (name.startsWith(words)) return 0;
    if (name.split(/\s+/).some((word) => word.startsWith(words))) return 1;
    if (item.keywords.split(/\s+/).some((word) => word.startsWith(words))) return 2;
    return 3;
  };
  return items
    .filter((item) => `${nameOf(item.id)} ${item.keywords}`.toLowerCase().includes(words))
    .map((item, index) => ({ item, index, score: rank(item) }))
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map(({ item }) => item);
}
