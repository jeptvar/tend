import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

// Undo over confirm (PLAN.md §4, P9): what can be taken back is done straight away, with an
// Undo or the Trash. Only these ask first, because they can't be taken back.
const MAY_ASK_FIRST = [
  "Delete forever",
  "Restore backup",
  "Reset site",
  "Transfer ownership",
  "Remove person",
];

/** Every dialog in the admin, in the order it's written, and the question, if it's one. */
const DIALOGS: Record<string, { is: string; asks?: string }[]> = {
  "components/AdminLayout.tsx": [{ is: "the menu on phones" }],
  "components/MediaPicker.tsx": [{ is: "choosing a picture or file" }],
  "editor/AltDialog.tsx": [{ is: "describing a picture" }],
  "editor/HistoryDialog.tsx": [{ is: "earlier versions" }],
  "editor/LinkDialog.tsx": [{ is: "a link or a button" }],
  "editor/PreviewDialog.tsx": [{ is: "the preview" }],
  "editor/PublishDialog.tsx": [{ is: "it's published" }, { is: "the review before publishing" }],
  "routes/Editor.tsx": [{ is: "a post's or page's settings, where there's no room beside it" }],
  "routes/Entries.tsx": [{ is: "a post or page, forever", asks: "Delete forever" }],
  "routes/Media.tsx": [
    { is: "a picture's or file's details" },
    { is: "a picture or file, forever", asks: "Delete forever" },
  ],
  "routes/People.tsx": [
    { is: "removing someone", asks: "Remove person" },
    { is: "handing the site over", asks: "Transfer ownership" },
  ],
  "routes/SiteMenu.tsx": [{ is: "adding a link to the menu" }],
};

const SRC = join(import.meta.dirname, "..", "src");
const FILES = readdirSync(SRC, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
  .map((entry) => join(entry.parentPath, entry.name))
  .map((path) => ({
    name: relative(SRC, path).replaceAll("\\", "/"),
    text: readFileSync(path, "utf8"),
  }));

describe("the admin's dialogs", () => {
  test("are all in the list: a new one fails this until it says what it's for", () => {
    const found = Object.fromEntries(
      FILES.flatMap(({ name, text }) => {
        const count = [...text.matchAll(/<Dialog\b/g)].length;
        return count > 0 ? [[name, count]] : [];
      }),
    );
    const listed = Object.fromEntries(
      Object.entries(DIALOGS).map(([name, dialogs]) => [name, dialogs.length]),
    );
    expect(found).toEqual(listed);
  });

  test("ask first only for what can't be taken back, and that's at most 5 things", () => {
    const asked = new Set(
      Object.values(DIALOGS).flatMap((dialogs) => dialogs.flatMap(({ asks }) => asks ?? [])),
    );
    expect([...asked].sort()).toEqual(["Delete forever", "Remove person", "Transfer ownership"]);
    for (const question of asked) expect(MAY_ASK_FIRST).toContain(question);
    expect(MAY_ASK_FIRST.length).toBeLessThanOrEqual(5);
  });

  test("are the only ones: nothing uses the browser's own, or a <dialog> of its own", () => {
    for (const { name, text } of FILES) {
      expect(text, name).not.toMatch(/\b(?:window\.)?(?:confirm|alert|prompt)\(/);
      if (name !== "components/Dialog.tsx") expect(text, name).not.toMatch(/<dialog\b/);
    }
  });
});
