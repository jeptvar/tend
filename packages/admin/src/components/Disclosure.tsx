import type { ReactNode, ToggleEvent } from "react";
import { Icon } from "./icons.tsx";

/** Something that waits behind its name until it's wanted. */
export function Disclosure({
  summary,
  onToggle,
  className = "card",
  children,
}: {
  summary: ReactNode;
  onToggle?: (open: boolean) => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <details
      className={`group ${className}`}
      onToggle={(event: ToggleEvent<HTMLDetailsElement>) => onToggle?.(event.currentTarget.open)}
    >
      <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-3 rounded-2xl px-5 py-2 font-semibold [overflow-wrap:anywhere] focus-visible:outline-3 focus-visible:outline-brand [&::-webkit-details-marker]:hidden">
        <span className="min-w-0">{summary}</span>
        <Icon name="down" className="size-5 text-muted group-open:rotate-180" />
      </summary>
      <div className="px-5 pb-5">{children}</div>
    </details>
  );
}
