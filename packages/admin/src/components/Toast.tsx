import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useIntl } from "react-intl";
import { secondaryButtonClass } from "./AuthLayout.tsx";

export interface ToastInput {
  message: string;
  action?: { label: string; run: () => void };
  /** Errors stay until dismissed, because nobody should have to catch them in time. */
  sticky?: boolean;
}

interface Toast extends ToastInput {
  id: number;
}

const TOAST_MS = 8000;

let current: Toast | null = null;
let nextId = 1;
const listeners = new Set<() => void>();

function publish(toast: Toast | null): void {
  current = toast;
  for (const listener of listeners) listener();
}

/** Only one at a time: the newest thing that happened is what matters. Returns its id. */
export function showToast(input: ToastInput): number {
  const id = nextId++;
  publish({ ...input, id });
  return id;
}

/** Takes away that toast, if it's still the one showing. */
export function dismissToast(id: number): void {
  if (current?.id === id) publish(null);
}

/**
 * Open dialogs, newest last. A modal dialog makes everything outside it unreachable, and
 * covers it, so while one is open its toasts show inside the newest one instead.
 */
let dialogs: number[] = [];
let nextDialog = 1;
const dialogListeners = new Set<() => void>();

function setDialogs(next: number[]): void {
  dialogs = next;
  for (const listener of dialogListeners) listener();
}

function subscribeDialogs(listener: () => void): () => void {
  dialogListeners.add(listener);
  return () => dialogListeners.delete(listener);
}

/** Inside every dialog: shows toasts there while it's the newest one open. */
export function DialogToasts() {
  const [id] = useState(() => nextDialog++);
  useLayoutEffect(() => {
    setDialogs([...dialogs, id]);
    return () => setDialogs(dialogs.filter((other) => other !== id));
  }, [id]);
  const newest = useSyncExternalStore(subscribeDialogs, () => dialogs.at(-1));
  return <ToastRegion hidden={newest !== id} />;
}

/**
 * Lasts 8 seconds, and pauses while the pointer or keyboard focus is on it (PLAN.md §6).
 * It's mounted once, for good, because screen readers can miss a live region that arrives
 * along with its text.
 */
export function Toaster() {
  const dialogOpen = useSyncExternalStore(subscribeDialogs, () => dialogs.length > 0);
  return <ToastRegion hidden={dialogOpen} />;
}

function ToastRegion({ hidden }: { hidden: boolean }) {
  const shown = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
  const toast = hidden ? null : shown;
  const intl = useIntl();
  const [hovered, setHovered] = useState(false);
  /** Where focus was before it came into the toast, such as the middle of someone's writing. */
  const cameFrom = useRef<HTMLElement | null>(null);

  /** The button pressed is about to go, so focus goes back to where it came from. */
  function returnFocus(): void {
    const from = cameFrom.current;
    cameFrom.current = null;
    if (from?.isConnected) from.focus({ preventScroll: true });
    else document.querySelector<HTMLElement>("main h1")?.focus();
  }
  const [focused, setFocused] = useState(false);
  const paused = hovered || focused;
  const remaining = useRef(TOAST_MS);

  const toastId = toast?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new toast starts its own time
  useEffect(() => {
    remaining.current = TOAST_MS;
    setHovered(false);
    setFocused(false);
  }, [toastId]);

  const sticky = toast?.sticky;
  useEffect(() => {
    if (toastId === undefined || sticky || paused) return;
    const startedAt = Date.now();
    const timer = setTimeout(() => dismissToast(toastId), remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current -= Date.now() - startedAt;
    };
  }, [toastId, sticky, paused]);

  return (
    <div
      role="status"
      className="pointer-events-none fixed inset-x-0 bottom-[calc(1rem+var(--tend-bar))] z-50 flex justify-center px-4"
    >
      {toast && (
        // biome-ignore lint/a11y/noStaticElementInteractions: only pauses the timer
        <div
          // Over, not enter: a toast can appear under a pointer that's already there, and
          // moving around inside it never counts as entering.
          onMouseOver={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          onFocus={(event) => {
            setFocused(true);
            const from = event.relatedTarget as HTMLElement | null;
            if (from && !event.currentTarget.contains(from)) cameFrom.current = from;
          }}
          // Safari doesn't focus a button that's clicked, so the focus above never comes. Where
          // focus is as the press starts, before it can move, is where it goes back to: without
          // this, it went to the page's heading, which on a long post scrolled to the top.
          onPointerDown={(event) => {
            const active = document.activeElement as HTMLElement | null;
            if (active && active !== document.body && !event.currentTarget.contains(active)) {
              cameFrom.current = active;
            }
          }}
          onBlur={() => setFocused(false)}
          className="pointer-events-auto flex max-w-xl flex-wrap items-center gap-3 rounded-2xl border border-line bg-surface py-2 pr-2 pl-5 font-medium shadow-raised"
        >
          <span>{toast.message}</span>
          {toast.action && (
            <button
              type="button"
              onClick={() => {
                const action = toast.action;
                dismissToast(toast.id);
                returnFocus();
                action?.run();
              }}
              className={secondaryButtonClass}
            >
              {toast.action.label}
            </button>
          )}
          {toast.sticky && (
            <button
              type="button"
              onClick={() => {
                dismissToast(toast.id);
                returnFocus();
              }}
              className={secondaryButtonClass}
            >
              {intl.formatMessage({ id: "common.ok" })}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
