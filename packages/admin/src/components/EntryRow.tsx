import { FormattedMessage } from "react-intl";
import type { EntrySummary } from "../lib/queries.ts";
import { Icon } from "./icons.tsx";

// What a post or a page looks like in a list: its picture, and where it is.

/** Its picture, or a drawing of what it is. The words beside it say the same either way. */
export function EntryPicture({
  entry,
  className = "h-12 w-16 rounded-lg",
}: {
  entry: Pick<EntrySummary, "type" | "thumbUrl">;
  className?: string;
}) {
  return entry.thumbUrl ? (
    <img
      src={entry.thumbUrl}
      alt=""
      loading="lazy"
      className={`shrink-0 bg-sunken object-cover ${className}`}
    />
  ) : (
    <span
      className={`grid shrink-0 place-items-center bg-mint text-brand ${className}`}
      aria-hidden="true"
    >
      <Icon name={entry.type === "post" ? "posts" : "pages"} />
    </span>
  );
}

/** What someone needs to know about it at a glance, in plain words (PLAN.md P15). */
export function EntryStatus({ entry }: { entry: Pick<EntrySummary, "url" | "dirty"> }) {
  const [id, look, dot] =
    entry.url === null
      ? ["status.draft", "bg-sunken text-ink", "bg-edge"]
      : entry.dirty
        ? ["status.changes", "bg-wait-soft text-wait", "bg-[#d9962b]"]
        : ["status.onSite", "bg-mint text-brand-strong", "bg-[#3fae74]"];
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-semibold ${look}`}
    >
      <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${dot}`} />
      <FormattedMessage id={id} />
    </span>
  );
}
