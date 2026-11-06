import { useSyncExternalStore } from "react";
import type { EntryType } from "./queries.ts";

export interface EditorDraft {
  title: string;
  slug: string;
  body: string;
}

/** Text that hasn't reached the server yet, and which version it was based on. */
export interface HeldDraft {
  id: string;
  type: EntryType;
  /** Whose it is, so someone else signing in on this tab doesn't get it. */
  userId: string;
  rev: number;
  draft: EditorDraft;
}

const STORAGE_KEY = "tend.heldDrafts";

// Kept for this tab only, so a shared computer doesn't keep private drafts after the tab
// closes. It survives a reload, a sign-in and a failed save, which is what this is for.
// IndexedDB takes over with the real editor (M2).
function load(): Map<string, HeldDraft> {
  try {
    const stored = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "[]") as HeldDraft[];
    return new Map(stored.map((held) => [held.id, held]));
  } catch {
    return new Map();
  }
}

const drafts = load();
const savesUnderway = new Map<string, Promise<unknown>>();
const listeners = new Set<() => void>();
let snapshot: HeldDraft[] = [];

function refreshSnapshot(): void {
  snapshot = [...drafts.values()].filter((held) => !savesUnderway.has(held.id));
}
refreshSnapshot();

function changed(): void {
  refreshSnapshot();
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...drafts.values()]));
  } catch {
    // Storage can be full or refused. It's still held in memory for as long as the tab lives.
  }
  for (const listener of listeners) listener();
}

export function holdDraft(held: HeldDraft): void {
  drafts.set(held.id, held);
  changed();
}

export function releaseDraft(id: string): void {
  if (drafts.delete(id)) changed();
}

export function getHeldDraft(id: string, userId: string): HeldDraft | undefined {
  const held = drafts.get(id);
  return held?.userId === userId ? held : undefined;
}

/** Lets anything that reopens this entry wait, so it can't overtake the save and show old text. */
export function trackSave(id: string, save: Promise<unknown>): void {
  const tracked = save.finally(() => {
    if (savesUnderway.get(id) === tracked) savesUnderway.delete(id);
    refreshSnapshot();
    for (const listener of listeners) listener();
  });
  savesUnderway.set(id, tracked);
  refreshSnapshot();
}

export async function waitForSave(id: string): Promise<void> {
  try {
    await savesUnderway.get(id);
  } catch {
    // The draft stays held, and the editor offers it again.
  }
}

/** What couldn't be saved, for the notice that says so. A save still running doesn't count. */
export function useHeldDrafts(userId: string, exceptId?: string): HeldDraft[] {
  const all = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
  );
  return all.filter((held) => held.userId === userId && held.id !== exceptId);
}

// What has to happen before signing out, so an open editor isn't cut off mid-sentence.
const beforeSignOut = new Set<() => Promise<void>>();

export function registerBeforeSignOut(task: () => Promise<void>): () => void {
  beforeSignOut.add(task);
  return () => beforeSignOut.delete(task);
}

export async function runBeforeSignOut(): Promise<void> {
  await Promise.all([...beforeSignOut].map((task) => task()));
}
