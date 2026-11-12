import { type ReactNode, useLayoutEffect, useRef } from "react";

/**
 * A native modal dialog: it keeps keyboard focus inside, closes on Escape, and puts focus
 * back where it was. `labelledBy` is the id of its heading.
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
    dialog.showModal();
    return () => dialog.close();
  }, []);

  return (
    <dialog
      ref={ref}
      aria-labelledby={labelledBy}
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      className={`m-auto w-full rounded-lg bg-paper p-4 text-ink shadow-xl backdrop:bg-black/50 sm:p-6 ${
        size === "full" ? "h-dvh max-h-none max-w-none rounded-none" : "max-h-[90dvh] max-w-lg"
      }`}
    >
      {children}
    </dialog>
  );
}
