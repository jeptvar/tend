import type { Doc, DocNode } from "../lib/doc.ts";
import { docToText } from "../lib/doc.ts";
import type { LinkTarget } from "../lib/queries.ts";

/** The place a check is about, for its Fix button to lead to. */
export type CheckTarget =
  | { kind: "start" }
  | { kind: "slug" }
  /** A picture with no description, wherever it is: the description is the picture's own. */
  | { kind: "describe"; mediaId: string }
  | { kind: "picture"; mediaId: string }
  | { kind: "upload" }
  | { kind: "link"; href: string }
  | { kind: "words"; words: string }
  /** By where it comes among the headings. */
  | { kind: "heading"; index: number }
  | { kind: "button"; label: string };

/** A soft check: worth knowing before publishing, but never a reason to refuse (PLAN.md §6). */
export interface Check {
  id: string;
  values?: Record<string, string>;
  /** Absent when there's nothing to do but wait. */
  target?: CheckTarget;
}

const ENTRY_PREFIX = "entry:";
const VAGUE_LINK = /^(click here|here|this link|link)$/i;

function walk(nodes: DocNode[], visit: (node: DocNode) => void): void {
  for (const node of nodes) {
    visit(node);
    if (node.content) walk(node.content, visit);
  }
}

/** Every other page or post this links to. */
export function linkedIds(doc: Doc): string[] {
  const ids = new Set<string>();
  const add = (href: unknown) => {
    if (typeof href === "string" && href.startsWith(ENTRY_PREFIX)) {
      ids.add(href.slice(ENTRY_PREFIX.length));
    }
  };
  walk(doc.content, (node) => {
    if (node.type === "button") add(node.attrs?.href);
    for (const mark of node.marks ?? []) {
      if (mark.type === "link") add(mark.attrs?.href);
    }
  });
  return [...ids];
}

/** What the checks need to know about the pictures a document shows. */
export interface PictureFacts {
  id: string;
  described: boolean;
  gone: boolean;
}

export function findChecks(
  doc: Doc,
  targets: readonly LinkTarget[],
  move: { from: string; to: string } | null,
  pictures: readonly PictureFacts[] = [],
): Check[] {
  const checks: Check[] = [];
  const hasPictures = pictures.length > 0;
  if (docToText(doc).trim() === "" && !hasPictures) {
    checks.push({ id: "check.empty", target: { kind: "start" } });
  }
  if (move) checks.push({ id: "check.moved", values: move, target: { kind: "slug" } });

  // Each picture counts once, wherever it appears, since its description is shared.
  const undescribed = pictures.filter((picture) => !picture.gone && !picture.described);
  if (undescribed[0]) {
    checks.push({
      id: "check.noDescription",
      values: { count: String(undescribed.length) },
      target: { kind: "describe", mediaId: undescribed[0].id },
    });
  }
  const gone = pictures.filter((picture) => picture.gone);
  if (gone[0]) {
    checks.push({
      id: "check.pictureGone",
      values: { count: String(gone.length) },
      target: { kind: "picture", mediaId: gone[0].id },
    });
  }

  const known = new Map(targets.map((target) => [target.id, target]));
  for (const id of linkedIds(doc)) {
    const target = known.get(id);
    const there: CheckTarget = { kind: "link", href: `${ENTRY_PREFIX}${id}` };
    if (!target) checks.push({ id: "check.linkDeleted", target: there });
    else if (target.url === null) {
      checks.push({ id: "check.linkNotOnSite", values: { title: target.title }, target: there });
    }
  }

  let previousLevel = 1;
  let headings = 0;
  let skippedAt: number | null = null;
  const vagueLinks = new Set<string>();
  const addressless: string[] = [];
  walk(doc.content, (node) => {
    if (node.type === "heading") {
      const level = Number(node.attrs?.level);
      if (level > previousLevel + 1) skippedAt ??= headings;
      previousLevel = level;
      headings++;
    }
    if (node.type === "button" && !node.attrs?.href) {
      addressless.push(String(node.attrs?.label ?? ""));
    }
    if (
      node.marks?.some((mark) => mark.type === "link") &&
      VAGUE_LINK.test(node.text?.trim() ?? "")
    ) {
      vagueLinks.add(node.text?.trim() ?? "");
    }
  });
  if (skippedAt !== null) {
    checks.push({ id: "check.skippedHeading", target: { kind: "heading", index: skippedAt } });
  }
  for (const words of vagueLinks) {
    checks.push({ id: "check.vagueLink", values: { words }, target: { kind: "words", words } });
  }
  for (const label of addressless) {
    checks.push({
      id: "check.buttonNoAddress",
      values: { label },
      target: { kind: "button", label },
    });
  }
  return checks;
}
