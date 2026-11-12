import { useSyncExternalStore } from "react";
import type { Doc } from "./doc.ts";
import type { EntryType } from "./queries.ts";

export interface EditorDraft {
  title: string;
  slug: string;
  summary: string;
  doc: Doc;
}

/** What hasn't reached the server yet, from one editor window. */
export interface HeldDraft {
  /** One per window, so two windows can never overwrite each other's copy. */
  key: string;
  id: string;
  type: EntryType;
  /** Whose it is, so someone else signing in on this computer doesn't get it. */
  userId: string;
  /** The version it was based on, so saving it raises a conflict if that's changed since. */
  rev: number;
  editSession: string;
  draft: EditorDraft;
  heldAt: number;
}

const DB_NAME = "tend";
const DB_VERSION = 2;
const STORE = "drafts";
const CHANNEL = "tend.drafts";

// A copy on this device, so a crash, a dead battery or a closed tab can't take what someone
// typed (PLAN.md P5). A copy goes as soon as the server has it, so only work that's still on
// its way is ever stored, for as long as that takes. Everything stays in memory too, for
// whenever this device refuses to store anything, as a full disk or some private windows can.
const drafts = new Map<string, HeldDraft>();
const savesUnderway = new Map<string, Promise<unknown>>();
const listeners = new Set<() => void>();
let snapshot: HeldDraft[] = [];
let storageWorks = true;
/** Editor windows still open somewhere: their copies are in use, not left behind. */
let liveWindows = new Set<string>();
/** Windows in this tab that have closed since that was last checked. */
const closedHere = new Set<string>();
/**
 * Changes this tab has made that the device hasn't confirmed: a copy (or null, for one being
 * removed). Reading the device again mustn't undo them, because they're newer than what it
 * holds, and if storing keeps failing, memory is the only place the words are.
 */
const unconfirmed = new Map<string, HeldDraft | null>();

function draftKey(id: string, editSession: string): string {
  return `${id}:${editSession}`;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE);
      db.createObjectStore(STORE, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("blocked"));
  });
}

let database: Promise<IDBDatabase> | undefined;
/** Once open, writes start right there and then, which matters while a tab is closing. */
let opened: IDBDatabase | undefined;

function getDatabase(): Promise<IDBDatabase> {
  if (!database) {
    try {
      database = openDatabase();
    } catch (error) {
      database = Promise.reject(error);
    }
    database.then(
      (db) => {
        opened = db;
      },
      () => {},
    );
  }
  return database;
}

function refreshSnapshot(): void {
  snapshot = [...drafts.values()]
    .filter(
      (held) =>
        !savesUnderway.has(held.id) &&
        (!liveWindows.has(held.editSession) || closedHere.has(held.editSession)),
    )
    .sort((a, b) => b.heldAt - a.heldAt);
}

function notify(): void {
  refreshSnapshot();
  for (const listener of listeners) listener();
}

const otherTabs =
  typeof BroadcastChannel === "undefined" ? undefined : new BroadcastChannel(CHANNEL);

function storageFailed(): void {
  storageWorks = false;
  notify();
}

function writeTo(
  db: IDBDatabase,
  changes: Map<string, HeldDraft | null>,
  change: (store: IDBObjectStore) => void,
): void {
  const transaction = db.transaction(STORE, "readwrite");
  transaction.oncomplete = () => {
    for (const [key, value] of changes) {
      // Only if nothing newer has happened to it since.
      if (unconfirmed.get(key) === value) unconfirmed.delete(key);
    }
    otherTabs?.postMessage("changed");
    if (!storageWorks) {
      storageWorks = true;
      notify();
    }
  };
  transaction.onabort = storageFailed;
  transaction.onerror = storageFailed;
  change(transaction.objectStore(STORE));
  // Straight away, because this can be the last thing that happens before the tab closes,
  // and a browser drops a transaction it hasn't been told is finished.
  transaction.commit();
}

function write(
  changes: Map<string, HeldDraft | null>,
  change: (store: IDBObjectStore) => void,
): void {
  for (const [key, value] of changes) unconfirmed.set(key, value);
  try {
    if (opened) {
      writeTo(opened, changes, change);
      return;
    }
    getDatabase()
      .then((db) => writeTo(db, changes, change))
      .catch(storageFailed);
  } catch {
    storageFailed();
  }
}

async function findLiveWindows(): Promise<Set<string>> {
  try {
    const { held = [] } = (await navigator.locks?.query()) ?? {};
    return new Set(
      held.flatMap((lock) =>
        lock.name?.startsWith(LOCK_PREFIX) ? [lock.name.slice(LOCK_PREFIX.length)] : [],
      ),
    );
  } catch {
    return new Set();
  }
}

/** Reads what's on this device, including anything other tabs have done since last time. */
async function load(): Promise<void> {
  const db = await getDatabase();
  const stored = await new Promise<HeldDraft[]>((resolve, reject) => {
    const request = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  liveWindows = await findLiveWindows();
  closedHere.clear();
  drafts.clear();
  for (const held of stored) drafts.set(held.key, held);
  for (const [key, value] of unconfirmed) {
    if (value) drafts.set(key, value);
    else drafts.delete(key);
  }
}

function refresh(): Promise<void> {
  return load()
    .catch(() => {
      // Nothing can be read, so what's in memory is all there is, and it stays.
      storageWorks = false;
    })
    .finally(notify);
}

void refresh();
otherTabs?.addEventListener("message", () => void refresh());

// Without a copy on this device, closing the tab really would lose the words, so the browser
// asks first. This is here rather than in the editor, because it can outlive the editor.
window.addEventListener("beforeunload", (event) => {
  if (!storageWorks && drafts.size > 0) event.preventDefault();
});

/** Finished once this device has been read afresh. Opening an entry waits for this. */
export function draftsLoaded(): Promise<void> {
  return refresh();
}

/** Whether "kept on this device" is true right now. If it isn't, nobody should be told it is. */
export function keptOnDevice(): boolean {
  return storageWorks;
}

export function useKeptOnDevice(): boolean {
  return useSyncExternalStore(subscribe, keptOnDevice);
}

export function holdDraft(fields: Omit<HeldDraft, "key">): void {
  const held = { ...fields, key: draftKey(fields.id, fields.editSession) };
  drafts.set(held.key, held);
  notify();
  write(new Map([[held.key, held]]), (store) => store.put(held));
}

/** Carries on from a copy left by a window that's gone, as this window's own. */
export function takeOverDraft(previousKey: string, fields: Omit<HeldDraft, "key">): void {
  const held = { ...fields, key: draftKey(fields.id, fields.editSession) };
  drafts.delete(previousKey);
  drafts.set(held.key, held);
  notify();
  write(
    new Map<string, HeldDraft | null>([
      [previousKey, null],
      [held.key, held],
    ]),
    (store) => {
      store.delete(previousKey);
      store.put(held);
    },
  );
}

export function releaseDraft(id: string, editSession: string): void {
  releaseHeld(draftKey(id, editSession));
}

export function releaseHeld(key: string): void {
  // Anything written but not yet confirmed is in memory too (see load), so this is never
  // missing a copy that's on its way to the device.
  if (!drafts.delete(key)) return;
  notify();
  write(new Map([[key, null]]), (store) => store.delete(key));
}

/** Someone deleting an entry for good has decided about their own copies of it too. */
export function releaseAllDrafts(id: string, userId: string): void {
  for (const held of [...drafts.values()]) {
    if (held.id === id && held.userId === userId) releaseHeld(held.key);
  }
}

/** What's been left behind for this entry, newest first. Not what an open window's using. */
export function getHeldDrafts(id: string, userId: string): HeldDraft[] {
  return snapshot.filter((held) => held.id === id && held.userId === userId);
}

/** Lets anything that reopens this entry wait, so it can't overtake the save and show old text. */
export function trackSave(id: string, save: Promise<unknown>): void {
  const tracked = save.finally(() => {
    if (savesUnderway.get(id) === tracked) savesUnderway.delete(id);
    notify();
  });
  tracked.catch(() => {});
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

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * What couldn't be saved, for the notice that says so: one per entry, the newest. A save
 * still running doesn't count, and neither does a window that's still working on it.
 */
export function useHeldDrafts(userId: string, exceptId?: string): HeldDraft[] {
  const all = useSyncExternalStore(subscribe, () => snapshot);
  const seen = new Set<string>();
  return all.filter((held) => {
    if (held.userId !== userId || held.id === exceptId || seen.has(held.id)) return false;
    seen.add(held.id);
    return true;
  });
}

const LOCK_PREFIX = "tend.editor.";

/**
 * Marks an editor window as open for as long as it is. The browser lets go by itself when a
 * tab closes or crashes, which is exactly how a copy left behind can be told from one still
 * in use. Only on https and localhost: elsewhere every copy counts as left behind, which is
 * safe, because saving one still raises a conflict if the entry has moved on.
 */
export function holdWindowOpen(editSession: string): () => void {
  if (!navigator.locks) return () => {};
  let letGo: () => void = () => {};
  const open = new Promise<void>((resolve) => {
    letGo = resolve;
  });
  navigator.locks
    .request(`${LOCK_PREFIX}${editSession}`, () => open)
    // Other tabs hear about it too, so a copy this window left behind gets mentioned there.
    .then(() => otherTabs?.postMessage("changed"))
    .catch(() => {});
  return () => {
    // Straight away for this tab's own notice, which can't wait for the device to say so.
    closedHere.add(editSession);
    notify();
    letGo();
  };
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
