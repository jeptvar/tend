import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { primaryButtonClass, secondaryButtonClass } from "../components/AuthLayout.tsx";
import { Dialog } from "../components/Dialog.tsx";
import { api, errorText } from "../lib/api.ts";
import type { RevisionDetail, RevisionSummary } from "../lib/queries.ts";
import { DeviceChoice, PreviewFrame } from "./PreviewDialog.tsx";

function isNarrow(): boolean {
  return !window.matchMedia("(min-width: 768px)").matches;
}

/** Every version kept, with a look at any of them and a way to bring it back (PLAN.md J6). */
export function HistoryDialog({
  entryId,
  busy,
  problem,
  onRestore,
  onClose,
}: {
  entryId: string;
  busy: boolean;
  problem: string | null;
  onRestore: (revisionId: string) => void;
  onClose: () => void;
}) {
  const intl = useIntl();
  const headingId = useId();
  const [selected, setSelected] = useState<string | null>(null);
  const [device, setDevice] = useState<"desktop" | "phone">("desktop");
  const offlineText = intl.formatMessage({ id: "offline.body" });
  const restoreRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const returnTo = useRef<string | null>(null);

  // On a phone the list and the version take turns on the screen, so whichever button was just
  // pressed has gone. Focus goes to the matching place on the other side.
  useEffect(() => {
    if (!isNarrow()) return;
    if (selected) {
      restoreRef.current?.focus();
    } else if (returnTo.current) {
      listRef.current?.querySelector<HTMLElement>(`[data-revision="${returnTo.current}"]`)?.focus();
      returnTo.current = null;
    }
  }, [selected]);

  const list = useInfiniteQuery({
    queryKey: ["revisions", entryId],
    gcTime: 0,
    initialPageParam: "0",
    getNextPageParam: (page: { nextCursor: string | null }) => page.nextCursor,
    queryFn: ({ pageParam }) =>
      api<{ revisions: RevisionSummary[]; nextCursor: string | null }>(
        `/admin/entries/${entryId}/revisions?cursor=${pageParam}`,
      ),
  });
  const versions = list.data?.pages.flatMap((page) => page.revisions);
  // One Tab stop for the whole list, with the arrow keys moving within it, so Restore is
  // never a hundred presses away.
  const [focusable, setFocusable] = useState<string | null>(null);
  const tabStop = focusable ?? selected ?? versions?.[0]?.id ?? null;

  function moveWithin(event: React.KeyboardEvent<HTMLUListElement>): void {
    if (!versions?.length) return;
    const index = versions.findIndex((version) => version.id === tabStop);
    const go = (next: number) => {
      event.preventDefault();
      const target = versions[Math.max(0, Math.min(versions.length - 1, next))];
      if (!target) return;
      setFocusable(target.id);
      listRef.current?.querySelector<HTMLElement>(`[data-revision="${target.id}"]`)?.focus();
    };
    if (event.key === "ArrowDown") go(index + 1);
    else if (event.key === "ArrowUp") go(index - 1);
    else if (event.key === "Home") go(0);
    else if (event.key === "End") go(versions.length - 1);
  }
  const detail = useQuery({
    queryKey: ["revision", selected],
    enabled: selected !== null,
    queryFn: () => api<RevisionDetail>(`/admin/revisions/${selected}`),
  });

  const when = (time: number) => intl.formatDate(time, { dateStyle: "medium", timeStyle: "short" });

  return (
    <Dialog labelledBy={headingId} onClose={onClose} size="full">
      <div className="flex h-full flex-col gap-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <h2 id={headingId} className="me-auto text-xl font-semibold">
            <FormattedMessage id="history.heading" />
          </h2>
          <button type="button" className={secondaryButtonClass} onClick={onClose}>
            <FormattedMessage id="common.close" />
          </button>
        </div>
        {/* What's showing on the right, which a screen reader can't otherwise tell has changed. */}
        <p role="status" className="sr-only">
          {detail.data
            ? intl.formatMessage({ id: "history.showing" }, { when: when(detail.data.createdAt) })
            : ""}
        </p>
        <p role="alert" className="font-medium text-danger empty:sr-only">
          {problem ??
            (list.error
              ? errorText(list.error, offlineText)
              : detail.error
                ? errorText(detail.error, offlineText)
                : null)}
        </p>
        <div className="flex min-h-0 flex-1 flex-col gap-4 md:flex-row">
          <div
            ref={listRef}
            className={`min-h-0 overflow-y-auto md:w-80 md:shrink-0 ${selected ? "hidden md:block" : ""}`}
          >
            {list.isPending && (
              <p className="text-muted">
                <FormattedMessage id="common.loading" />
              </p>
            )}
            {versions?.length === 0 && (
              <p className="text-muted">
                <FormattedMessage id="history.empty" />
              </p>
            )}
            <ul className="grid gap-1" onKeyDown={moveWithin}>
              {versions?.map((revision) => (
                <li key={revision.id}>
                  <button
                    type="button"
                    data-revision={revision.id}
                    tabIndex={revision.id === tabStop ? 0 : -1}
                    aria-pressed={selected === revision.id}
                    onClick={() => {
                      setFocusable(revision.id);
                      setSelected(revision.id);
                    }}
                    className="min-h-11 w-full rounded-lg px-3 py-2 text-start hover:bg-ink/5 focus-visible:outline-3 focus-visible:outline-brand aria-pressed:bg-ink aria-pressed:text-paper"
                  >
                    <span className="block font-medium">{when(revision.createdAt)}</span>
                    {/* The selected row is dark, and its words have to be light to match. */}
                    <span
                      className={`block text-sm ${selected === revision.id ? "" : "text-muted"}`}
                    >
                      <FormattedMessage id={`history.kind.${revision.kind}`} />
                      {revision.isLive && (
                        <>
                          {" · "}
                          <FormattedMessage id="status.onSite" />
                        </>
                      )}
                      {revision.authorName && ` · ${revision.authorName}`}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {list.hasNextPage && (
              <button
                type="button"
                aria-disabled={list.isFetchingNextPage}
                onClick={() => {
                  if (!list.isFetchingNextPage) void list.fetchNextPage();
                }}
                className={`${secondaryButtonClass} mt-2 aria-disabled:opacity-60`}
              >
                <FormattedMessage
                  id={list.isFetchingNextPage ? "common.loading" : "history.more"}
                />
              </button>
            )}
          </div>
          {selected && (
            <div className="flex min-h-0 flex-1 flex-col gap-3">
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  className={`${secondaryButtonClass} md:hidden`}
                  onClick={() => {
                    returnTo.current = selected;
                    setSelected(null);
                  }}
                >
                  <FormattedMessage id="history.back" />
                </button>
                <button
                  ref={restoreRef}
                  type="button"
                  aria-disabled={busy}
                  onClick={() => {
                    if (!busy) onRestore(selected);
                  }}
                  className={`${primaryButtonClass} aria-disabled:opacity-60`}
                >
                  <FormattedMessage id={busy ? "editor.reverting" : "history.restore"} />
                </button>
                <DeviceChoice device={device} onChange={setDevice} />
              </div>
              <p className="text-sm text-muted">
                <FormattedMessage id="history.restoreHint" />
              </p>
              <div className="flex min-h-64 flex-1 justify-center">
                {detail.data && (
                  <PreviewFrame
                    html={detail.data.previewHtml}
                    title={intl.formatMessage(
                      { id: "history.frame" },
                      { when: when(detail.data.createdAt) },
                    )}
                    device={device}
                  />
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}
