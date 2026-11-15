import { useEffect, useState } from "react";

/**
 * Changes on the Site menu, Design and Settings screens that haven't been saved yet. They're
 * kept here, outside the screens, so going to another screen and back doesn't lose them,
 * and closing the tab with any of them asks first (PLAN.md P5: never lose work).
 */
const kept = new Map<string, unknown>();
/** Kept changes, whether or not their screen is open: closing the tab would lose them. */
const changedNow = new Set<string>();

window.addEventListener("beforeunload", (event) => {
  if (changedNow.size > 0) event.preventDefault();
});

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export interface ScreenDraft<T> {
  /** What the form shows: the person's changes, or else what's saved. */
  value: T | undefined;
  /** Something differs from what's saved. */
  changed: boolean;
  /** These changes were kept from an earlier visit to this screen. */
  restored: boolean;
  set(next: T | ((current: T) => T)): void;
  /**
   * After a save: shows the saved answer, unless more was typed while it was on its way,
   * which stays, still unsaved.
   */
  saved(sent: T): void;
  /** Goes back to what's saved, as after Undo or Discard. */
  discard(): void;
}

export function useScreenDraft<T>(key: string, stored: T | undefined): ScreenDraft<T> {
  const [local, setLocal] = useState<T | undefined>(() => kept.get(key) as T | undefined);
  const [restored] = useState(() => kept.has(key));
  const changed = local !== undefined && stored !== undefined && !same(local, stored);

  useEffect(() => {
    if (changed) {
      kept.set(key, local);
      changedNow.add(key);
    } else {
      kept.delete(key);
      changedNow.delete(key);
    }
  }, [key, local, changed]);

  return {
    value: changed ? local : stored,
    changed,
    restored: restored && changed,
    // A function gets the newest value, for answers that arrive after other changes.
    set: (next) =>
      setLocal((current) =>
        typeof next === "function" ? (next as (current: T) => T)((current ?? stored) as T) : next,
      ),
    saved: (sent) =>
      setLocal((current) => (current === undefined || same(current, sent) ? undefined : current)),
    discard: () => setLocal(undefined),
  };
}

/** After a save that finished with its screen closed: what was kept has been saved now. */
export function settleScreenDraft(key: string, sent: unknown): void {
  if (kept.has(key) && same(kept.get(key), sent)) {
    kept.delete(key);
    changedNow.delete(key);
  }
}
