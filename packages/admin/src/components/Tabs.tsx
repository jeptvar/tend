import type { ReactNode } from "react";

/** Parts of one screen to choose between, side by side: a pressed button says which is shown. */
export function Tabs({ children }: { children: ReactNode }) {
  return (
    <div className="flex max-w-full flex-wrap gap-1 rounded-2xl bg-sunken p-1">{children}</div>
  );
}

function Tab({
  chosen,
  onChoose,
  children,
}: {
  chosen: boolean;
  onChoose: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={chosen}
      onClick={onChoose}
      className={`min-h-11 min-w-11 rounded-xl px-4 text-center focus-visible:outline-3 focus-visible:outline-brand ${
        chosen
          ? "bg-surface font-semibold text-ink shadow-xs ring-1 ring-line"
          : "font-medium text-muted hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

Tabs.Tab = Tab;
