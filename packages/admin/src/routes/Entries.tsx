import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useId, useLayoutEffect, useState } from "react";
import { FormattedDate, FormattedMessage, FormattedNumber, useIntl } from "react-intl";
import { Link, useLocation, useSearchParams } from "wouter";
import { AdminLayout, SignedIn } from "../components/AdminLayout.tsx";
import {
  primaryButtonClass,
  secondaryButtonClass,
  textLinkClass,
} from "../components/AuthLayout.tsx";
import { Dialog } from "../components/Dialog.tsx";
import { EntryPicture, EntryStatus } from "../components/EntryRow.tsx";
import { Icon } from "../components/icons.tsx";
import { Problem } from "../components/Problem.tsx";
import { Tabs } from "../components/Tabs.tsx";
import { showToast } from "../components/Toast.tsx";
import { api } from "../lib/api.ts";
import { releaseAllDrafts } from "../lib/held-drafts.ts";
import {
  ENTRY_VIEWS,
  type EntryPage,
  type EntrySummary,
  type EntryType,
  type EntryView,
  entriesKey,
  entryKey,
  entryListKey,
  type Me,
  withoutEntry,
} from "../lib/queries.ts";

const TRASH_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
/** How long after the last key before the list is searched. */
const SEARCH_AFTER_MS = 250;
/** Fewer than this many, and a search would only be in the way. */
const WORTH_SEARCHING = 10;

const VIEW_QUERY: Record<EntryView, string> = {
  all: "",
  drafts: "&status=draft",
  published: "&status=published",
  trash: "&view=trash",
};

function focusHeading(): void {
  document.querySelector<HTMLElement>("main h1")?.focus();
}

/**
 * After a row goes, focus goes to the one that took its place, so someone working down a long
 * list doesn't keep landing back at the top.
 */
function focusRowAt(index: number): void {
  const rows = [...document.querySelectorAll<HTMLElement>("[data-entry-row]")];
  const row = rows[Math.min(index, rows.length - 1)];
  const target = row?.querySelector<HTMLElement>("button, a");
  if (target) target.focus();
  else focusHeading();
}

function listPath(type: EntryType): string {
  return type === "post" ? "/posts" : "/pages";
}

function EntryListScreen({ me, type }: { me: Me; type: EntryType }) {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  // In the address, so a link can lead to the drafts, and coming back from one finds them.
  const [params, setParams] = useSearchParams();
  const view: EntryView = ENTRY_VIEWS.find((each) => each === params.get("show")) ?? "all";
  const trashed = view === "trash";
  const [typed, setTyped] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setSearch(typed.trim()), SEARCH_AFTER_MS);
    return () => clearTimeout(timer);
  }, [typed]);
  const searchId = useId();
  const path = listPath(type);
  const canDeleteForever = me.user.role === "admin";
  const [confirmDelete, setConfirmDelete] = useState<{
    entry: EntrySummary;
    index: number;
  } | null>(null);
  const confirmHeadingId = useId();

  const list = useInfiniteQuery({
    queryKey: entryListKey(type, view, search),
    initialPageParam: "0",
    getNextPageParam: (page: EntryPage) => page.nextCursor,
    queryFn: ({ pageParam }) =>
      api<EntryPage>(
        `/admin/entries?type=${type}${VIEW_QUERY[view]}${search ? `&q=${encodeURIComponent(search)}` : ""}&cursor=${pageParam}`,
      ),
  });
  const rows = list.data?.pages.flatMap((page) => page.entries);
  // Kept while another part loads, so the tabs don't jump about.
  const [counts, setCounts] = useState<EntryPage["counts"]>();
  const newest = list.data?.pages.at(-1)?.counts;
  if (newest && newest !== counts) setCounts(newest);

  // The row that Restore or Delete forever is taking away, and where it was.
  const [leaving, setLeaving] = useState<{ id: string; index: number } | null>(null);

  function removeRow(id: string): void {
    queryClient.setQueryData<InfiniteData<EntryPage>>(entryListKey(type, view, search), (data) =>
      withoutEntry(data, id),
    );
  }

  function refreshLists() {
    void queryClient.invalidateQueries({ queryKey: entriesKey(type) });
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
    mutationFn: (target: { id: string; wasPublished: boolean; index: number }) =>
      api(`/admin/entries/${target.id}/restore`, { method: "POST" }),
    onSuccess: (_, target) => {
      queryClient.removeQueries({ queryKey: entryKey(target.id) });
      removeRow(target.id);
      refreshLists();
      showToast({
        message: intl.formatMessage({
          id: target.wasPublished ? "list.restored" : "list.restoredDraft",
        }),
      });
      // The row and its button are going, and focus shouldn't go with them.
      setLeaving({ id: target.id, index: target.index });
    },
  });

  const deleteForever = useMutation({
    mutationFn: (target: { entry: EntrySummary; index: number }) =>
      api(`/admin/entries/${target.entry.id}`, { method: "DELETE" }),
    onSuccess: (_, { entry: target, index }) => {
      queryClient.removeQueries({ queryKey: entryKey(target.id) });
      removeRow(target.id);
      // Whoever deleted this has decided about any copies of their own, too.
      releaseAllDrafts(target.id, me.user.id);
      refreshLists();
      setConfirmDelete(null);
      showToast({ message: intl.formatMessage({ id: "list.deletedForever" }) });
      // The dialog hands focus back to its button only while that's still on the page.
      setLeaving({ id: target.id, index });
    },
  });

  // Focus moves to the row that took the leaving one's place in the first render that shows
  // it gone with Restore or Delete forever finished. Their buttons are disabled until then,
  // and a disabled button can't take focus. Checking each animation frame for the row alone
  // could land in between, after the row went but while the buttons were still disabled.
  const busy = restore.isPending || deleteForever.isPending;
  useLayoutEffect(() => {
    if (!leaving || busy || !rows || rows.some((row) => row.id === leaving.id)) return;
    setLeaving(null);
    focusRowAt(leaving.index);
  }, [rows, leaving, busy]);

  const error = list.error ?? create.error ?? restore.error;

  return (
    <AdminLayout
      me={me}
      screen={type === "post" ? "posts" : "pages"}
      width="wide"
      actions={
        <button
          type="button"
          disabled={create.isPending}
          onClick={newEntry}
          className={primaryButtonClass}
        >
          <Icon name="add" className="size-4.5" />
          <FormattedMessage id={type === "post" ? "list.newPost" : "list.newPage"} />
        </button>
      }
    >
      <div className="mt-6 flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <Tabs>
          {ENTRY_VIEWS.map((option) => (
            <Tabs.Tab
              key={option}
              chosen={view === option}
              onChoose={() =>
                setParams(option === "all" ? {} : { show: option }, { replace: true })
              }
            >
              <FormattedMessage id={`list.${option}`} />
              {counts && (
                <>
                  {" "}
                  <span className="ml-0.5 font-normal">
                    <FormattedNumber value={counts[option]} />
                  </span>
                </>
              )}
            </Tabs.Tab>
          ))}
        </Tabs>
        {((counts && counts.all + counts.trash >= WORTH_SEARCHING) || typed !== "") && (
          <div className="relative w-full sm:w-80">
            <label htmlFor={searchId} className="sr-only">
              <FormattedMessage id={`list.search.${type}`} />
            </label>
            <span className="pointer-events-none absolute inset-y-0 left-3.5 flex items-center text-muted">
              <Icon name="search" />
            </span>
            <input
              id={searchId}
              type="search"
              value={typed}
              maxLength={200}
              placeholder={intl.formatMessage({ id: `list.search.${type}` })}
              onChange={(event) => setTyped(event.target.value)}
              className="min-h-11 w-full rounded-xl border border-edge bg-field pr-3 pl-11 placeholder:text-muted focus-visible:outline-3 focus-visible:outline-brand"
            />
          </div>
        )}
      </div>
      <p role="status" className="sr-only">
        {search && list.data && !list.isFetching && (
          <FormattedMessage
            id="list.found"
            values={{ count: rows?.length ?? 0, more: list.hasNextPage ? "yes" : "no" }}
          />
        )}
      </p>

      {/* Always mounted: screen readers can miss a live region added along with its text. */}
      <p role="alert" className="mt-4 font-medium text-danger empty:sr-only">
        {error && <Problem error={error} />}
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

      {rows?.length === 0 && (
        <p className="dashed mt-5 px-6 py-12 text-center text-muted">
          {search ? (
            <FormattedMessage id="list.nothingFound" values={{ search }} />
          ) : (
            <FormattedMessage
              id={
                view === "trash"
                  ? "list.emptyTrash"
                  : view === "all"
                    ? `list.empty.${type}`
                    : `list.empty.${view}`
              }
            />
          )}
        </p>
      )}

      <ul className="card mt-5 divide-y divide-line px-4 empty:hidden sm:px-5">
        {rows?.map((entry, index) => (
          <li
            key={entry.id}
            data-entry-row={entry.id}
            className="relative flex flex-wrap items-center gap-x-4 gap-y-2 py-3.5 [contain-intrinsic-size:auto_6rem] [content-visibility:auto]"
          >
            <EntryPicture
              entry={entry}
              className={`h-14 w-18 rounded-xl sm:h-16 sm:w-21 ${trashed ? "opacity-60" : ""}`}
            />
            <div className="min-w-0 flex-1 basis-48">
              {trashed ? (
                <span className="text-lg leading-snug font-semibold [overflow-wrap:anywhere]">
                  {entry.title || <FormattedMessage id="list.untitled" />}
                </span>
              ) : (
                // The whole row leads to it, but for what's on top of it.
                <Link
                  href={`${path}/${entry.id}`}
                  className="text-lg leading-snug font-semibold [overflow-wrap:anywhere] underline-offset-4 after:absolute after:inset-0 after:rounded-xl hover:underline focus-visible:outline-none focus-visible:after:outline-3 focus-visible:after:outline-brand"
                >
                  {entry.title || <FormattedMessage id="list.untitled" />}
                </Link>
              )}
              {entry.words && (
                <p className="line-clamp-1 text-muted [overflow-wrap:anywhere]">{entry.words}</p>
              )}
              {trashed && entry.trashedAt !== null && (
                <p className="text-sm text-muted">
                  <FormattedMessage
                    id="list.deletesOn"
                    values={{
                      date: intl.formatDate(entry.trashedAt + TRASH_KEEP_MS, {
                        dateStyle: "medium",
                      }),
                    }}
                  />
                </p>
              )}
            </div>
            {!trashed && (
              <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
                {entry.isHome && (
                  <span className="text-sm font-medium text-muted">
                    <FormattedMessage id="list.homepage" />
                  </span>
                )}
                <EntryStatus entry={entry} />
                <span className="text-sm text-muted sm:min-w-24 sm:text-right">
                  <FormattedDate value={entry.updatedAt} dateStyle="medium" />
                </span>
                {/* As wide whether or not it's on the site, so the rest of the rows line up. */}
                <span className="flex sm:min-w-16 sm:justify-end">
                  {entry.url && (
                    <a
                      href={entry.url}
                      target="_blank"
                      rel="noopener"
                      className={`relative z-1 ${textLinkClass}`}
                    >
                      <FormattedMessage id="list.view" />
                    </a>
                  )}
                </span>
              </div>
            )}
            {trashed && (
              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  disabled={restore.isPending}
                  onClick={() =>
                    restore.mutate({
                      id: entry.id,
                      wasPublished: entry.firstPublishedAt !== null,
                      index,
                    })
                  }
                  className={secondaryButtonClass}
                >
                  <FormattedMessage id="list.restore" />
                </button>
                {canDeleteForever && (
                  <button
                    type="button"
                    onClick={() => {
                      deleteForever.reset();
                      setConfirmDelete({ entry, index });
                    }}
                    className={secondaryButtonClass}
                  >
                    <FormattedMessage id="list.deleteForever" />
                  </button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
      {list.hasNextPage && (
        <div className="mt-4">
          <button
            type="button"
            aria-disabled={list.isFetchingNextPage}
            onClick={() => {
              if (!list.isFetchingNextPage) void list.fetchNextPage();
            }}
            className={`${secondaryButtonClass} aria-disabled:opacity-60`}
          >
            <FormattedMessage id={list.isFetchingNextPage ? "common.loading" : "list.showMore"} />
          </button>
        </div>
      )}
      {confirmDelete && (
        <Dialog labelledBy={confirmHeadingId} onClose={() => setConfirmDelete(null)}>
          <div className="grid gap-4">
            <h2 id={confirmHeadingId} className="text-xl font-bold">
              <FormattedMessage
                id="list.confirmDelete"
                values={{
                  title: confirmDelete.entry.title || intl.formatMessage({ id: "list.untitled" }),
                }}
              />
            </h2>
            <p>
              <FormattedMessage id="list.confirmDeleteBody" />
            </p>
            <p role="alert" className="font-medium text-danger empty:sr-only">
              {deleteForever.error && <Problem error={deleteForever.error} />}
            </p>
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                className={primaryButtonClass}
                onClick={() => setConfirmDelete(null)}
              >
                <FormattedMessage id="list.keepIt" />
              </button>
              <button
                type="button"
                disabled={deleteForever.isPending}
                onClick={() => deleteForever.mutate(confirmDelete)}
                className={secondaryButtonClass}
              >
                <FormattedMessage id="list.deleteForever" />
              </button>
            </div>
          </div>
        </Dialog>
      )}
    </AdminLayout>
  );
}

export function PostList() {
  return <SignedIn>{(me) => <EntryListScreen me={me} type="post" />}</SignedIn>;
}

export function PageList() {
  return (
    <SignedIn roles={["admin", "editor"]}>
      {(me) => <EntryListScreen me={me} type="page" />}
    </SignedIn>
  );
}
