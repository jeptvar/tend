import type { ReactNode } from "react";

/** A window with the site's name on its tab, for a picture of the site to be in. */
export function BrowserFrame({
  name,
  className = "",
  children,
}: {
  name: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`flex-col overflow-hidden rounded-xl border border-line bg-white ${className}`}>
      <div
        aria-hidden="true"
        className="flex h-8 shrink-0 items-center gap-1.5 border-b border-line bg-sunken px-3"
      >
        <span className="size-2.5 rounded-full bg-edge/40" />
        <span className="size-2.5 rounded-full bg-edge/40" />
        <span className="size-2.5 rounded-full bg-edge/40" />
        <span className="ml-2 truncate rounded-md bg-surface px-3 text-xs leading-5 text-muted">
          {name}
        </span>
      </div>
      {children}
    </div>
  );
}
