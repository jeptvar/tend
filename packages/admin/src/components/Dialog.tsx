import { type ReactNode, useLayoutEffect, useRef } from "react";
import { DialogToasts } from "./Toast.tsx";

/** The control last pressed with a mouse, finger or pen, and when. */
let pressed: { element: HTMLElement; at: number } | undefined;
// After the control's own handlers (not capture), so one that keeps focus where it is on
// purpose, like the editor's toolbar buttons, which cancel mousedown, isn't counted.
document.addEventListener("mousedown", (event) => {
  const control = (event.target as Element | null)?.closest?.(
    "button, a[href], summary, [role='button']",
  );
  pressed =
    control instanceof HTMLElement && !event.defaultPrevented
      ? { element: control, at: performance.now() }
      : undefined;
});

/** How recently something must have been pressed to count as what opened a dialog. */
const JUST_PRESSED_MS = 1000;

/**
 * What focus goes back to when a dialog closes: the control just pressed to open it, or
 * whatever had focus. Chromium focuses a button that's clicked, and puts focus back on it by
 * itself. Safari doesn't, so there focus went back to the writing, or to nothing at all.
 */
function opener(): HTMLElement | undefined {
  if (pressed && performance.now() - pressed.at < JUST_PRESSED_MS && pressed.element.isConnected) {
    return pressed.element;
  }
  const active = document.activeElement;
  return active instanceof HTMLElement && active !== document.body ? active : undefined;
}

/**
 * A native modal dialog: it keeps keyboard focus inside, closes on Escape, and puts focus
 * back where it was. `labelledBy` is the id of its heading. Toasts that arrive while it's
 * open show inside it, where they can be read and used.
 */
export function Dialog({
  labelledBy,
  onClose,
  size = "md",
  children,
}: {
  labelledBy: string;
  onClose: () => void;
  size?: "md" | "full";
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  // A layout effect, because closing has to happen while the dialog is still on the page.
  // That's what hands focus back to whatever had it.
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog || dialog.open) return;
    const returnTo = opener();
    dialog.showModal();
    return () => {
      dialog.close();
      // Where the browser put it back already, as Chromium does, this changes nothing.
      if (returnTo?.isConnected && document.activeElement !== returnTo) {
        returnTo.focus({ preventScroll: true });
      }
    };
  }, []);

  return (
    <dialog
      ref={ref}
      aria-labelledby={labelledBy}
      // The close event arrives a moment after close() is called. In development React
      // mounts everything twice, so by then the dialog has been opened again, and that
      // late event mustn't shut it.
      onClose={() => {
        if (!ref.current?.open) onClose();
      }}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      className={`m-auto w-full rounded-lg bg-paper p-4 text-ink shadow-xl backdrop:bg-black/50 sm:p-6 ${
        size === "full" ? "h-dvh max-h-none max-w-none rounded-none" : "max-h-[90dvh] max-w-lg"
      }`}
    >
      {children}
      <DialogToasts />
    </dialog>
  );
}
