import type { Doc, DocNode } from "../lib/doc.ts";
import { docToText } from "../lib/doc.ts";
import type { LinkTarget } from "../lib/queries.ts";

/** A soft check: worth knowing before publishing, but never a reason to refuse (PLAN.md §6). */
export interface Check {
  id: string;
  values?: Record<string, string>;
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

export function findChecks(
  doc: Doc,
  targets: readonly LinkTarget[],
  move: { from: string; to: string } | null,
): Check[] {
  const checks: Check[] = [];
  if (docToText(doc).trim() === "") checks.push({ id: "check.empty" });
  if (move) checks.push({ id: "check.moved", values: move });

  const known = new Map(targets.map((target) => [target.id, target]));
  for (const id of linkedIds(doc)) {
    const target = known.get(id);
    if (!target) checks.push({ id: "check.linkDeleted" });
    else if (target.url === null) {
      checks.push({ id: "check.linkNotOnSite", values: { title: target.title } });
    }
  }

  let previousLevel = 1;
  let skippedLevel = false;
  const vagueLinks = new Set<string>();
  const addressless: string[] = [];
  walk(doc.content, (node) => {
    if (node.type === "heading") {
      const level = Number(node.attrs?.level);
      if (level > previousLevel + 1) skippedLevel = true;
      previousLevel = level;
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
  if (skippedLevel) checks.push({ id: "check.skippedHeading" });
  for (const words of vagueLinks) checks.push({ id: "check.vagueLink", values: { words } });
  for (const label of addressless) checks.push({ id: "check.buttonNoAddress", values: { label } });
  return checks;
}
