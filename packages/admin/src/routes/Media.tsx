import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { FormattedDate, FormattedMessage, type IntlShape, useIntl } from "react-intl";
import { Link } from "wouter";
import { AdminLayout, SignedIn } from "../components/AdminLayout.tsx";
import {
  primaryButtonClass,
  secondaryButtonClass,
  textLinkClass,
} from "../components/AuthLayout.tsx";
import { Dialog } from "../components/Dialog.tsx";
import { showToast } from "../components/Toast.tsx";
import { api, errorText } from "../lib/api.ts";
import {
  ACCEPTED_FILES,
  formatBytes,
  isSiteUse,
  linkForUse,
  MEDIA_KEY,
  type MediaItem,
  type MediaPage,
  type MediaUse,
  mediaItemKey,
  mediaListKey,
  rememberMedia,
  tooBigToUpload,
  uploadErrorText,
  uploadFile,
  uploadWords,
  worthRetrying,
} from "../lib/media.ts";
import type { Me } from "../lib/queries.ts";

/** What the site itself uses a picture as, named the way Design, Settings and Site menu do. */
const SITE_USE_LABELS = {
  logo: "design.logo",
  icon: "design.icon",
  share: "seo.image",
  menu: "menu.title",
} as const;

const TRASH_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const SEARCH_DELAY_MS = 250;

interface Upload {
  key: number;
  name: string;
  progress: number;
  error: string | null;
  /** Whether trying again could help: not for a file that's too big or of the wrong kind. */
  retryable: boolean;
}

let nextUploadKey = 1;

/** Files dropped or pasted, as a list, or nothing if what arrived wasn't files. */
function filesFrom(data: DataTransfer | null): File[] {
  return data ? [...data.files] : [];
}

/** Uploads one file after another, so each gets the whole connection and a clear progress bar. */
export function useUploads(onUploaded: (item: MediaItem) => void) {
  const intl = useIntl();
  const [uploads, setUploads] = useState<Upload[]>([]);
  const queue = useRef<{ key: number; file: File }[]>([]);
  /** Each file, kept until it's uploaded, so a failed one can be tried again. */
  const waiting = useRef(new Map<number, File>());
  const running = useRef(false);
  const uploaded = useRef(onUploaded);
  uploaded.current = onUploaded;

  function update(key: number, change: Partial<Upload>) {
    setUploads((all) =>
      all.map((upload) => (upload.key === key ? { ...upload, ...change } : upload)),
    );
  }

  async function drain() {
    if (running.current) return;
    running.current = true;
    while (queue.current.length > 0) {
      const next = queue.current.shift() as { key: number; file: File };
      try {
        const item = await uploadFile(next.file, {
          onProgress: (progress) => update(next.key, { progress }),
        });
        waiting.current.delete(next.key);
        setUploads((all) => all.filter((upload) => upload.key !== next.key));
        uploaded.current(item);
      } catch (error) {
        update(next.key, {
          error: uploadErrorText(error, uploadWords(intl)),
          retryable: worthRetrying(error),
        });
      }
    }
    running.current = false;
  }

  function add(files: File[]) {
    const added: Upload[] = [];
    for (const file of files) {
      const key = nextUploadKey++;
      if (tooBigToUpload(file)) {
        added.push({
          key,
          name: file.name,
          progress: 0,
          error: intl.formatMessage({ id: "media.tooBig" }),
          retryable: false,
        });
        continue;
      }
      added.push({ key, name: file.name, progress: 0, error: null, retryable: false });
      queue.current.push({ key, file });
      waiting.current.set(key, file);
    }
    setUploads((all) => [...all, ...added]);
    void drain();
  }

  function dismiss(key: number) {
    waiting.current.delete(key);
    setUploads((all) => all.filter((upload) => upload.key !== key));
  }

  function retry(key: number) {
    const file = waiting.current.get(key);
    if (!file) return;
    update(key, { error: null, progress: 0, retryable: false });
    queue.current.push({ key, file });
    void drain();
  }

  return { uploads, add, dismiss, retry };
}

export function UploadList({
  uploads,
  onDismiss,
  onRetry,
}: {
  uploads: Upload[];
  onDismiss: (key: number) => void;
  onRetry: (key: number) => void;
}) {
  const intl = useIntl();
  if (uploads.length === 0) return null;
  return (
    <ul className="mt-4 grid gap-2" aria-label={intl.formatMessage({ id: "media.uploading" })}>
      {uploads.map((upload) => (
        <li
          key={upload.key}
          className={`grid gap-1 rounded-lg border px-3 py-2 ${upload.error ? "border-danger" : "border-ink/15"}`}
        >
          <div className="flex flex-wrap items-center justify-between gap-x-3">
            <span className="min-w-0 font-medium [overflow-wrap:anywhere]">{upload.name}</span>
            {upload.error && (
              <span className="flex flex-wrap gap-x-3">
                {upload.retryable && (
                  <button
                    type="button"
                    onClick={() => onRetry(upload.key)}
                    className={textLinkClass}
                  >
                    <FormattedMessage id="common.tryAgain" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onDismiss(upload.key)}
                  className={textLinkClass}
                >
                  <FormattedMessage id="common.dismiss" />
                </button>
              </span>
            )}
          </div>
          {upload.error ? (
            <p role="alert" className="text-sm font-medium text-danger">
              {upload.error}
            </p>
          ) : (
            <progress
              className="h-2 w-full accent-brand"
              max={1}
              value={upload.progress}
              aria-label={intl.formatMessage({ id: "media.uploadingName" }, { name: upload.name })}
            />
          )}
        </li>
      ))}
    </ul>
  );
}

/** A file being dragged over the page, which is the only time the drop hint shows. */
function useDropTarget(onFiles: (files: File[]) => void) {
  const [dragging, setDragging] = useState(false);
  const files = useRef(onFiles);
  files.current = onFiles;

  useEffect(() => {
    let depth = 0;
    const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes("Files") ?? false;
    const enter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      depth++;
      setDragging(true);
    };
    const leave = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const over = (event: DragEvent) => {
      if (hasFiles(event)) event.preventDefault();
    };
    const drop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth = 0;
      setDragging(false);
      files.current(filesFrom(event.dataTransfer));
    };
    const paste = (event: ClipboardEvent) => {
      const pasted = filesFrom(event.clipboardData);
      // Pasting into a field is typing, not adding a file.
      const target = event.target as HTMLElement | null;
      if (pasted.length === 0 || target?.closest("input, textarea, [contenteditable]")) return;
      event.preventDefault();
      files.current(pasted);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    window.addEventListener("paste", paste);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
      window.removeEventListener("paste", paste);
    };
  }, []);

  return dragging;
}

export function Thumbnail({ item, className = "" }: { item: MediaItem; className?: string }) {
  if (item.kind === "file" || !item.thumbUrl) {
    return (
      <span
        aria-hidden="true"
        className={`flex items-center justify-center bg-ink/5 text-sm font-semibold text-muted ${className}`}
      >
        PDF
      </span>
    );
  }
  return (
    <img
      src={item.thumbUrl}
      alt=""
      loading="lazy"
      decoding="async"
      width={item.width ?? undefined}
      height={item.height ?? undefined}
      style={{ backgroundColor: item.dominantColor ?? undefined }}
      className={`object-cover ${className}`}
    />
  );
}

/**
 * After something leaves the list, focus goes to the heading rather than to a tile that's
 * about to disappear. After the dialog has handed focus back, which it does first.
 */
function focusAfterRemoving(): void {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => document.querySelector<HTMLElement>("main h1")?.focus()),
  );
}

function needsDescription(item: MediaItem): boolean {
  return item.kind === "image" && !item.decorative && !item.alt;
}

/**
 * What moving something to the Trash did to the site. A picture comes off the pages and the
 * parts of the site that showed it. A link to it stays where it is, on a page or in the menu,
 * and leads nowhere until it's restored, so that's what's said about links.
 */
function trashedMessage(intl: IntlShape, uses: MediaUse[]): string {
  const live = uses.filter((use) => !isSiteUse(use) && use.url !== null);
  const takenOff = live.filter((use) => !use.linkOnly).length;
  const linkedFrom = live.filter((use) => use.linkOnly).length;
  const inMenu = uses.some((use) => use.type === "menu");
  const parts = uses.filter((use) => isSiteUse(use) && use.type !== "menu");
  const said = [
    intl.formatMessage(
      { id: takenOff > 0 ? "media.trashedLive" : "media.trashed" },
      { count: takenOff },
    ),
  ];
  if (parts.length > 0) {
    const names = parts.map((use) => intl.formatMessage({ id: `media.siteUse.${use.type}` }));
    said.push(
      intl.formatMessage(
        { id: "media.trashedSite" },
        { uses: intl.formatList(names, { type: "conjunction" }) },
      ),
    );
  }
  if (linkedFrom > 0 || inMenu) {
    const places = [
      ...(linkedFrom > 0
        ? [intl.formatMessage({ id: "media.linkedPages" }, { count: linkedFrom })]
        : []),
      ...(inMenu ? [intl.formatMessage({ id: "media.linkedMenu" })] : []),
    ];
    said.push(
      intl.formatMessage(
        { id: "media.trashedLinks" },
        {
          places: intl.formatList(places, { type: "conjunction" }),
          links: linkedFrom + (inMenu ? 1 : 0),
        },
      ),
    );
  }
  return said.join(" ");
}

function MediaScreen({ me }: { me: Me }) {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const [view, setView] = useState<"all" | "trash">("all");
  const [typed, setTyped] = useState("");
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<MediaItem | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const trashed = view === "trash";
  const searchId = useId();

  useEffect(() => {
    const timer = setTimeout(() => setSearch(typed.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [typed]);

  const list = useInfiniteQuery({
    queryKey: mediaListKey(trashed, search),
    initialPageParam: "0",
    getNextPageParam: (page: MediaPage) => page.nextCursor,
    queryFn: ({ pageParam }) =>
      api<MediaPage>(
        `/admin/media?cursor=${pageParam}${trashed ? "&view=trash" : ""}${search ? `&q=${encodeURIComponent(search)}` : ""}`,
      ),
  });
  const items = list.data?.pages.flatMap((page) => page.media);

  const { uploads, add, dismiss, retry } = useUploads((item) => {
    rememberMedia(queryClient, item);
    void queryClient.invalidateQueries({ queryKey: [...MEDIA_KEY, "list"] });
    showToast({ message: intl.formatMessage({ id: "media.uploaded" }, { name: item.name }) });
  });
  const dragging = useDropTarget((files) => {
    if (files.length > 0) add(files);
  });

  function refreshLists() {
    void queryClient.invalidateQueries({ queryKey: [...MEDIA_KEY, "list"] });
  }

  return (
    <AdminLayout me={me} screen="media">
      <p className="mt-2 text-muted">
        <FormattedMessage id="media.hint" />
      </p>
      <div className="mt-6 flex flex-wrap items-end justify-between gap-3">
        <div className="-ml-2 flex">
          {(["all", "trash"] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={view === option}
              onClick={() => setView(option)}
              className={`min-h-11 min-w-11 rounded px-2 text-center hover:underline focus-visible:outline-3 focus-visible:outline-brand ${view === option ? "font-semibold" : "text-muted"}`}
            >
              <FormattedMessage id={option === "all" ? "list.all" : "list.trash"} />
            </button>
          ))}
        </div>
        <input
          ref={picker}
          type="file"
          multiple
          accept={ACCEPTED_FILES}
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            add([...(event.target.files ?? [])]);
            event.target.value = "";
          }}
        />
        <button
          type="button"
          onClick={() => picker.current?.click()}
          className={primaryButtonClass}
        >
          <FormattedMessage id="media.add" />
        </button>
      </div>

      <div className="mt-4 grid gap-2">
        <label htmlFor={searchId} className="font-medium">
          <FormattedMessage id="media.search" />
        </label>
        <input
          id={searchId}
          type="search"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          className="min-h-11 w-full rounded-lg border border-muted bg-white px-3 text-lg text-[#1d2420] focus-visible:outline-3 focus-visible:outline-brand"
        />
      </div>

      <UploadList uploads={uploads} onDismiss={dismiss} onRetry={retry} />

      {/* Always mounted: screen readers can miss a live region added along with its text. */}
      <p role="alert" className="mt-4 font-medium text-danger empty:sr-only">
        {list.error && errorText(list.error, intl.formatMessage({ id: "offline.body" }))}
      </p>

      {list.isPending && (
        <p className="mt-8 text-muted">
          <FormattedMessage id="common.loading" />
        </p>
      )}
      {items?.length === 0 && (
        <p className="mt-8 text-muted">
          <FormattedMessage
            id={trashed ? "list.emptyTrash" : search ? "media.noMatches" : "media.empty"}
          />
        </p>
      )}

      <ul className="mt-6 grid grid-cols-2 gap-3 empty:hidden sm:grid-cols-3">
        {items?.map((item) => (
          <li key={item.id} className="min-w-0">
            <button
              type="button"
              onClick={() => setOpen(item)}
              className="group grid w-full min-w-0 gap-1 rounded-lg text-left focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-brand"
            >
              <Thumbnail item={item} className="aspect-[4/3] w-full rounded-lg" />
              <span className="truncate text-sm font-medium group-hover:underline">
                {item.name}
              </span>
              {needsDescription(item) && (
                <span className="text-sm text-muted">
                  <FormattedMessage id="media.noDescription" />
                </span>
              )}
            </button>
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

      {dragging && (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed inset-3 z-40 flex items-center justify-center rounded-2xl border-4 border-dashed border-brand bg-paper/90 text-2xl font-semibold text-brand"
        >
          <FormattedMessage id="media.dropHere" />
        </div>
      )}

      {open && (
        <MediaDetails
          me={me}
          item={open}
          onChange={(item) => {
            // Only while it's still open: an answer arriving after Close mustn't reopen it.
            setOpen((current) => (current?.id === item.id ? item : current));
            refreshLists();
          }}
          onClose={() => setOpen(null)}
        />
      )}
    </AdminLayout>
  );
}

/** Everything about one file: its description, where it's used, and what can be done with it. */
function MediaDetails({
  me,
  item,
  onChange,
  onClose,
}: {
  me: Me;
  item: MediaItem;
  onChange: (item: MediaItem) => void;
  onClose: () => void;
}) {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const headingId = useId();
  const altId = useId();
  const altHintId = useId();
  const creditId = useId();
  const [alt, setAlt] = useState(item.alt ?? "");
  const [decorative, setDecorative] = useState(item.decorative);
  const [credit, setCredit] = useState(item.credit ?? "");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const replacePicker = useRef<HTMLInputElement>(null);
  const [replacing, setReplacing] = useState<number | null>(null);
  const [replaceError, setReplaceError] = useState<string | null>(null);
  // Said here rather than in a toast: a toast sits behind this dialog, where screen readers
  // can't reach it.
  const [status, setStatus] = useState("");
  const trashed = item.trashedAt !== null;
  const isImage = item.kind === "image";
  // Replacing and the Trash change every page at once, so they're for those who can publish.
  const canChangeEverywhere = me.user.role !== "writer";
  const changed =
    alt.trim() !== (item.alt ?? "") ||
    decorative !== item.decorative ||
    credit.trim() !== (item.credit ?? "");

  const usage = useQuery({
    queryKey: [...mediaItemKey(item.id), "usage"],
    queryFn: () => api<{ uses: MediaUse[] }>(`/admin/media/${item.id}/usage`),
  });

  function done(updated: MediaItem) {
    rememberMedia(queryClient, updated);
    onChange(updated);
  }

  const save = useMutation({
    mutationFn: () =>
      api<MediaItem>(`/admin/media/${item.id}`, {
        method: "PATCH",
        body: { alt: alt.trim() || null, decorative, credit: credit.trim() || null },
      }),
    onSuccess: (updated) => {
      done(updated);
      setStatus(intl.formatMessage({ id: "media.saved" }));
    },
  });

  const trash = useMutation({
    mutationFn: () =>
      api<MediaItem & { uses: MediaUse[] }>(`/admin/media/${item.id}/trash`, { method: "POST" }),
    onSuccess: (updated) => {
      done(updated);
      onClose();
      focusAfterRemoving();
      showToast({
        message: trashedMessage(intl, updated.uses),
        action: {
          label: intl.formatMessage({ id: "list.undo" }),
          run: () => {
            void api<MediaItem>(`/admin/media/${item.id}/restore`, { method: "POST" })
              .then((restored) => {
                rememberMedia(queryClient, restored);
                void queryClient.invalidateQueries({ queryKey: [...MEDIA_KEY, "list"] });
                showToast({ message: intl.formatMessage({ id: "media.restored" }) });
              })
              .catch((error: unknown) =>
                showToast({
                  message: errorText(error, intl.formatMessage({ id: "offline.body" })),
                  sticky: true,
                }),
              );
          },
        },
      });
    },
  });

  const restore = useMutation({
    mutationFn: () => api<MediaItem>(`/admin/media/${item.id}/restore`, { method: "POST" }),
    onSuccess: (updated) => {
      done(updated);
      onClose();
      focusAfterRemoving();
      showToast({ message: intl.formatMessage({ id: "media.restored" }) });
    },
  });

  const deleteForever = useMutation({
    mutationFn: () => api(`/admin/media/${item.id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: mediaItemKey(item.id) });
      void queryClient.invalidateQueries({ queryKey: [...MEDIA_KEY, "list"] });
      setConfirmDelete(false);
      onClose();
      focusAfterRemoving();
      showToast({ message: intl.formatMessage({ id: "list.deletedForever" }) });
    },
  });

  async function replaceWith(file: File) {
    setReplaceError(null);
    if (tooBigToUpload(file)) {
      setReplaceError(intl.formatMessage({ id: "media.tooBig" }));
      return;
    }
    setReplacing(0);
    try {
      const updated = await uploadFile(file, { replace: item.id, onProgress: setReplacing });
      done(updated);
      setStatus(intl.formatMessage({ id: "media.replaced" }));
    } catch (error) {
      setReplaceError(uploadErrorText(error, uploadWords(intl)));
    } finally {
      setReplacing(null);
    }
  }

  async function copyAddress() {
    const address = new URL(item.url, window.location.origin).toString();
    try {
      await navigator.clipboard.writeText(address);
      setStatus(intl.formatMessage({ id: "media.copied" }));
    } catch {
      setStatus(intl.formatMessage({ id: "media.copyByHand" }, { address }));
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setStatus("");
    if (changed) save.mutate();
  }

  const error = save.error ?? trash.error ?? restore.error;
  const uses = usage.data?.uses ?? [];

  return (
    <Dialog labelledBy={headingId} onClose={onClose}>
      <div className="grid gap-4">
        <div className="flex items-start justify-between gap-3">
          <h2 id={headingId} className="min-w-0 text-xl font-semibold [overflow-wrap:anywhere]">
            {item.name}
          </h2>
          <button type="button" onClick={onClose} className={`${textLinkClass} shrink-0`}>
            <FormattedMessage id="common.close" />
          </button>
        </div>
        {isImage && item.previewUrl ? (
          <img
            src={item.previewUrl}
            srcSet={item.srcset}
            sizes="(min-width: 32rem) 30rem, 100vw"
            alt={item.alt ?? ""}
            width={item.width ?? undefined}
            height={item.height ?? undefined}
            style={{ backgroundColor: item.dominantColor ?? undefined }}
            className="max-h-72 w-full rounded-lg object-contain"
          />
        ) : (
          <Thumbnail item={item} className="h-24 w-24 rounded-lg" />
        )}
        <p className="text-sm text-muted">
          {isImage && item.width && item.height && (
            <>
              <FormattedMessage
                id="media.dimensions"
                values={{ width: item.width, height: item.height }}
              />
              {" · "}
            </>
          )}
          {formatBytes(item.sizeBytes, intl.locale)}
          {" · "}
          <FormattedMessage
            id="media.addedOn"
            values={{
              date: <FormattedDate value={item.createdAt} dateStyle="medium" />,
              name: item.uploadedBy?.name ?? intl.formatMessage({ id: "media.someone" }),
            }}
          />
        </p>

        {!trashed && (
          <form onSubmit={onSubmit} className="grid gap-4">
            {isImage && (
              <>
                <div className="grid gap-2">
                  <label htmlFor={altId} className="font-medium">
                    <FormattedMessage id="media.description" />
                  </label>
                  <textarea
                    id={altId}
                    rows={3}
                    value={decorative ? "" : alt}
                    disabled={decorative}
                    aria-describedby={altHintId}
                    onChange={(event) => setAlt(event.target.value)}
                    className="w-full rounded-lg border border-muted bg-white px-3 py-2 text-lg text-[#1d2420] focus-visible:outline-3 focus-visible:outline-brand disabled:opacity-60"
                  />
                  <p id={altHintId} className="text-sm text-muted">
                    <FormattedMessage id="media.descriptionHint" />
                  </p>
                </div>
                <label className="flex min-h-11 items-center gap-3">
                  <input
                    type="checkbox"
                    checked={decorative}
                    onChange={(event) => setDecorative(event.target.checked)}
                    className="h-5 w-5 accent-brand"
                  />
                  <FormattedMessage id="media.decorative" />
                </label>
              </>
            )}
            <div className="grid gap-2">
              <label htmlFor={creditId} className="font-medium">
                <FormattedMessage id="media.credit" />
              </label>
              <input
                id={creditId}
                value={credit}
                onChange={(event) => setCredit(event.target.value)}
                placeholder={intl.formatMessage({ id: "media.creditExample" })}
                className="min-h-11 w-full rounded-lg border border-muted bg-white px-3 text-lg text-[#1d2420] placeholder:text-[#5b655f] focus-visible:outline-3 focus-visible:outline-brand"
              />
            </div>
            <div>
              <button
                type="submit"
                aria-disabled={!changed || save.isPending}
                className={`${primaryButtonClass} aria-disabled:opacity-60`}
              >
                <FormattedMessage id={save.isPending ? "media.saving" : "media.save"} />
              </button>
            </div>
          </form>
        )}

        <p role="alert" className="font-medium text-danger empty:sr-only">
          {error && errorText(error, intl.formatMessage({ id: "offline.body" }))}
        </p>

        <section aria-labelledby={`${headingId}-uses`} className="grid gap-1">
          <h3 id={`${headingId}-uses`} className="font-semibold">
            <FormattedMessage id="media.usedIn" />
          </h3>
          {usage.isPending ? (
            <p className="text-muted">
              <FormattedMessage id="common.loading" />
            </p>
          ) : uses.length === 0 ? (
            <p className="text-muted">
              <FormattedMessage id="media.notUsed" />
            </p>
          ) : (
            <ul>
              {uses.map((use) => (
                <li key={use.id} className="flex flex-wrap items-center gap-x-2">
                  <Link href={linkForUse(use)} className={textLinkClass}>
                    {isSiteUse(use)
                      ? intl.formatMessage({ id: SITE_USE_LABELS[use.type] })
                      : use.title || intl.formatMessage({ id: "list.untitled" })}
                  </Link>
                  <span className="text-sm text-muted">
                    <FormattedMessage id={use.url ? "media.useLive" : "media.useDraft"} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {trashed ? (
          <>
            <p className="text-sm text-muted">
              <FormattedMessage
                id="list.deletesOn"
                values={{
                  date: intl.formatDate((item.trashedAt ?? 0) + TRASH_KEEP_MS, {
                    dateStyle: "medium",
                  }),
                }}
              />
            </p>
            <div className="flex flex-wrap gap-3">
              {canChangeEverywhere && (
                <button
                  type="button"
                  disabled={restore.isPending}
                  onClick={() => restore.mutate()}
                  className={primaryButtonClass}
                >
                  <FormattedMessage id="list.restore" />
                </button>
              )}
              {me.user.role === "admin" && (
                <button
                  type="button"
                  onClick={() => {
                    deleteForever.reset();
                    setConfirmDelete(true);
                  }}
                  className={secondaryButtonClass}
                >
                  <FormattedMessage id="list.deleteForever" />
                </button>
              )}
            </div>
          </>
        ) : (
          <div className="flex flex-wrap gap-3">
            <input
              ref={replacePicker}
              type="file"
              accept={
                isImage ? "image/jpeg,image/png,image/webp,image/gif,image/avif" : "application/pdf"
              }
              className="sr-only"
              tabIndex={-1}
              aria-hidden="true"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void replaceWith(file);
              }}
            />
            {canChangeEverywhere && (
              <button
                type="button"
                aria-disabled={replacing !== null}
                onClick={() => {
                  if (replacing === null) replacePicker.current?.click();
                }}
                className={`${secondaryButtonClass} aria-disabled:opacity-60`}
              >
                <FormattedMessage id={replacing === null ? "media.replace" : "media.replacing"} />
              </button>
            )}
            <button
              type="button"
              onClick={() => void copyAddress()}
              className={secondaryButtonClass}
            >
              <FormattedMessage id="media.copyAddress" />
            </button>
            <a
              href={item.url}
              download={item.name}
              className={`${secondaryButtonClass} inline-flex items-center`}
            >
              <FormattedMessage id="media.download" />
            </a>
            {canChangeEverywhere && (
              <button
                type="button"
                disabled={trash.isPending}
                onClick={() => trash.mutate()}
                className={secondaryButtonClass}
              >
                <FormattedMessage id="media.moveToTrash" />
              </button>
            )}
          </div>
        )}
        {replacing !== null && (
          <progress
            className="h-2 w-full accent-brand"
            max={1}
            value={replacing}
            aria-label={intl.formatMessage({ id: "media.replacing" })}
          />
        )}
        <p role="alert" className="font-medium text-danger empty:sr-only">
          {replaceError}
        </p>
        <p role="status" className="font-medium [overflow-wrap:anywhere] empty:sr-only">
          {status}
        </p>
      </div>

      {confirmDelete && (
        <Dialog labelledBy={`${headingId}-delete`} onClose={() => setConfirmDelete(false)}>
          <div className="grid gap-4">
            <h2 id={`${headingId}-delete`} className="text-xl font-semibold">
              <FormattedMessage id="media.confirmDelete" values={{ name: item.name }} />
            </h2>
            <p>
              <FormattedMessage id="media.confirmDeleteBody" />
            </p>
            <p role="alert" className="font-medium text-danger empty:sr-only">
              {deleteForever.error &&
                errorText(deleteForever.error, intl.formatMessage({ id: "offline.body" }))}
            </p>
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                className={primaryButtonClass}
                onClick={() => setConfirmDelete(false)}
              >
                <FormattedMessage id="list.keepIt" />
              </button>
              <button
                type="button"
                disabled={deleteForever.isPending}
                onClick={() => deleteForever.mutate()}
                className={secondaryButtonClass}
              >
                <FormattedMessage id="list.deleteForever" />
              </button>
            </div>
          </div>
        </Dialog>
      )}
    </Dialog>
  );
}

export function MediaLibrary() {
  return <SignedIn>{(me) => <MediaScreen me={me} />}</SignedIn>;
}
