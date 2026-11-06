import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { FormattedDate, FormattedMessage, useIntl } from "react-intl";
import { Link, useLocation } from "wouter";
import { AdminLayout, SignedIn } from "../components/AdminLayout.tsx";
import {
  primaryButtonClass,
  secondaryButtonClass,
  textLinkClass,
} from "../components/AuthLayout.tsx";
import { api, errorText } from "../lib/api.ts";
import {
  type EntrySummary,
  type EntryType,
  entriesKey,
  entryKey,
  type Me,
} from "../lib/queries.ts";

/** What someone needs to know about an entry at a glance, in plain words (PLAN.md P15). */
function StatusLabel({ entry }: { entry: EntrySummary }) {
  if (entry.url === null) return <FormattedMessage id="status.draft" />;
  return <FormattedMessage id={entry.dirty ? "status.changes" : "status.onSite"} />;
}

function listPath(type: EntryType): string {
  return type === "post" ? "/posts" : "/pages";
}

function EntryListScreen({ me, type }: { me: Me; type: EntryType }) {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const [view, setView] = useState<"all" | "trash">("all");
  const trashed = view === "trash";
  const path = listPath(type);
  const statusRef = useRef<HTMLParagraphElement>(null);

  const [justTrashed, setJustTrashed] = useState<{ id: string; wasPublished: boolean } | null>(
    null,
  );
  const [restored, setRestored] = useState<{ wasPublished: boolean } | null>(null);

  // Set by the editor when it moves something to the Trash, so it can be undone from here.
  // Read after mounting, because screen readers can miss a live region that arrives with
  // its text.
  useEffect(() => {
    const trashedInEditor = window.history.state?.trashed;
    if (trashedInEditor) setJustTrashed(trashedInEditor);
  }, []);

  const list = useQuery({
    queryKey: entriesKey(type, trashed),
    queryFn: () =>
      api<{ entries: EntrySummary[]; nextCursor: string | null }>(
        `/admin/entries?type=${type}${trashed ? "&view=trash" : ""}`,
      ),
  });

  function refreshLists() {
    void queryClient.invalidateQueries({ queryKey: entriesKey(type, false) });
    void queryClient.invalidateQueries({ queryKey: entriesKey(type, true) });
  }

  const create = useMutation({
    mutationFn: () => api<EntrySummary>("/admin/entries", { method: "POST", body: { type } }),
  });

  function newEntry() {
    // Passed here, not to useMutation, so it only runs if this screen is still open.
    create.mutate(undefined, {
      onSuccess: (entry) => navigate(`${path}/${entry.id}`),
    });
  }

  const restore = useMutation({
    mutationFn: (target: { id: string; wasPublished: boolean }) =>
      api(`/admin/entries/${target.id}/restore`, { method: "POST" }),
    onSuccess: (_, target) => {
      queryClient.removeQueries({ queryKey: entryKey(target.id) });
      refreshLists();
      setJustTrashed(null);
      setRestored({ wasPublished: target.wasPublished });
      window.history.replaceState(null, "");
      // The button just pressed has gone, so focus goes to the message that replaced it.
      statusRef.current?.focus();
    },
  });

  const error = list.error ?? create.error ?? restore.error;

  return (
    <AdminLayout me={me} screen={type === "post" ? "posts" : "pages"}>
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <div className="-ml-2 flex">
          {(["all", "trash"] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={view === option}
              onClick={() => {
                setView(option);
                setRestored(null);
              }}
              className={`min-h-11 min-w-11 rounded px-2 text-center hover:underline focus-visible:outline-3 focus-visible:outline-brand ${view === option ? "font-semibold" : "text-muted"}`}
            >
              <FormattedMessage id={option === "all" ? "list.all" : "list.trash"} />
            </button>
          ))}
        </div>
        <button
          type="button"
          disabled={create.isPending}
          onClick={newEntry}
          className={primaryButtonClass}
        >
          <FormattedMessage id={type === "post" ? "list.newPost" : "list.newPage"} />
        </button>
      </div>

      {/* Always mounted: screen readers can miss a live region added along with its text. */}
      <p
        ref={statusRef}
        tabIndex={-1}
        role="status"
        className="mt-4 flex flex-wrap items-center gap-3 outline-none empty:sr-only"
      >
        {justTrashed && (
          <>
            <FormattedMessage
              id={justTrashed.wasPublished ? "list.movedToTrash" : "list.movedDraftToTrash"}
            />
            <button
              type="button"
              disabled={restore.isPending}
              onClick={() => restore.mutate(justTrashed)}
              className={secondaryButtonClass}
            >
              <FormattedMessage id="list.undo" />
            </button>
          </>
        )}
        {restored && (
          <FormattedMessage id={restored.wasPublished ? "list.restored" : "list.restoredDraft"} />
        )}
      </p>
      <p role="alert" className="mt-4 font-medium text-danger empty:sr-only">
        {error && errorText(error, intl.formatMessage({ id: "offline.body" }))}
      </p>

      {list.isPending && (
        <p className="mt-8 text-muted">
          <FormattedMessage id="common.loading" />
        </p>
      )}
      {list.isError && !list.data && (
        <div className="mt-6">
          <button
            type="button"
            disabled={list.isFetching}
            onClick={() => list.refetch()}
            className={secondaryButtonClass}
          >
            <FormattedMessage id={list.isFetching ? "common.trying" : "common.tryAgain"} />
          </button>
        </div>
      )}

      {list.data?.entries.length === 0 && (
        <p className="mt-8 text-muted">
          <FormattedMessage id={trashed ? "list.emptyTrash" : `list.empty.${type}`} />
        </p>
      )}

      <ul className="mt-6 divide-y divide-ink/10 border-y border-ink/10 empty:hidden">
        {list.data?.entries.map((entry) => (
          <li
            key={entry.id}
            className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-3"
          >
            <div className="min-w-0">
              {trashed ? (
                <span className="font-medium [overflow-wrap:anywhere]">
                  {entry.title || <FormattedMessage id="list.untitled" />}
                </span>
              ) : (
                <Link
                  href={`${path}/${entry.id}`}
                  className="inline-flex min-h-11 min-w-0 items-center font-medium [overflow-wrap:anywhere] underline-offset-4 hover:underline focus-visible:outline-3 focus-visible:outline-brand"
                >
                  {entry.title || <FormattedMessage id="list.untitled" />}
                </Link>
              )}
              <p className="text-sm text-muted">
                {entry.isHome && (
                  <>
                    <FormattedMessage id="list.homepage" />
                    {" · "}
                  </>
                )}
                <StatusLabel entry={entry} />
                {" · "}
                <FormattedDate value={entry.updatedAt} dateStyle="medium" />
              </p>
            </div>
            {trashed && (
              <button
                type="button"
                disabled={restore.isPending}
                onClick={() =>
                  restore.mutate({ id: entry.id, wasPublished: entry.firstPublishedAt !== null })
                }
                className={secondaryButtonClass}
              >
                <FormattedMessage id="list.restore" />
              </button>
            )}
            {!trashed && entry.url && (
              <a href={entry.url} target="_blank" rel="noopener" className={textLinkClass}>
                <FormattedMessage id="list.view" />
              </a>
            )}
          </li>
        ))}
      </ul>
      {list.data?.nextCursor && (
        <p className="mt-4 text-sm text-muted">
          <FormattedMessage id="list.more" />
        </p>
      )}
    </AdminLayout>
  );
}

export function PostList() {
  return <SignedIn>{(me) => <EntryListScreen me={me} type="post" />}</SignedIn>;
}

export function PageList() {
  return <SignedIn>{(me) => <EntryListScreen me={me} type="page" />}</SignedIn>;
}
