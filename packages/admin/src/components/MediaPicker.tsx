import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { api } from "../lib/api.ts";
import {
  ACCEPTED_PICTURES,
  MEDIA_KEY,
  type MediaItem,
  type MediaPage,
  mediaListKey,
  rememberMedia,
  tooBigToUpload,
  uploadErrorText,
  uploadFile,
  uploadWords,
} from "../lib/media.ts";
import { primaryButtonClass, secondaryButtonClass } from "./AuthLayout.tsx";
import { Dialog, DialogHeading } from "./Dialog.tsx";
import { Icon } from "./icons.tsx";
import { Problem } from "./Problem.tsx";

const SEARCH_DELAY_MS = 250;

/**
 * Picks a picture from Media, or a new one from this device. With `onFiles`, new files go
 * back to whoever asked, as the editor shows them uploading in place; otherwise they're
 * uploaded here and the result is picked.
 */
export function MediaPicker({
  heading,
  onPick,
  onFiles,
  onClose,
}: {
  heading: string;
  onPick: (item: MediaItem) => void;
  onFiles?: (files: File[]) => void;
  onClose: () => void;
}) {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const headingId = useId();
  const searchId = useId();
  const picker = useRef<HTMLInputElement>(null);
  const [typed, setTyped] = useState("");
  const [search, setSearch] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setSearch(typed.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [typed]);

  const list = useInfiniteQuery({
    queryKey: mediaListKey(false, search, "image"),
    initialPageParam: "0",
    getNextPageParam: (page: MediaPage) => page.nextCursor,
    queryFn: ({ pageParam }) =>
      api<MediaPage>(
        `/admin/media?kind=image&cursor=${pageParam}${search ? `&q=${encodeURIComponent(search)}` : ""}`,
      ),
  });
  const items = list.data?.pages.flatMap((page) => page.media);

  // Closing the picker stops its upload: nothing should be chosen after it's gone.
  const stopping = useRef<AbortController | null>(null);
  useEffect(() => () => stopping.current?.abort(), []);

  async function upload(file: File) {
    setError(null);
    if (tooBigToUpload(file)) {
      setError(intl.formatMessage({ id: "media.tooBig" }));
      return;
    }
    setProgress(0);
    const controller = new AbortController();
    stopping.current = controller;
    try {
      const item = await uploadFile(file, { onProgress: setProgress, signal: controller.signal });
      rememberMedia(queryClient, item);
      void queryClient.invalidateQueries({ queryKey: [...MEDIA_KEY, "list"] });
      if (!controller.signal.aborted) onPick(item);
    } catch (failure) {
      if (controller.signal.aborted) return;
      setError(uploadErrorText(failure, uploadWords(intl)));
    } finally {
      if (!controller.signal.aborted) setProgress(null);
    }
  }

  return (
    <Dialog labelledBy={headingId} onClose={onClose} size="lg">
      <div className="grid grid-cols-1 gap-4">
        <DialogHeading id={headingId} onClose={onClose}>
          {heading}
        </DialogHeading>
        <input
          ref={picker}
          type="file"
          accept={ACCEPTED_PICTURES}
          multiple={Boolean(onFiles)}
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            event.target.value = "";
            if (files.length === 0) return;
            if (onFiles) onFiles(files);
            else void upload(files[0] as File);
          }}
        />
        <div className="dashed grid justify-items-center px-5 py-6">
          <button
            type="button"
            aria-disabled={progress !== null}
            onClick={() => {
              if (progress === null) picker.current?.click();
            }}
            className={`${primaryButtonClass} aria-disabled:opacity-60`}
          >
            <Icon name="upload" className="size-4.5" />
            <FormattedMessage id={progress === null ? "picker.upload" : "picker.uploading"} />
          </button>
        </div>
        {progress !== null && (
          <progress
            className="h-2 w-full accent-brand"
            max={1}
            value={progress}
            aria-label={intl.formatMessage({ id: "picker.uploading" })}
          />
        )}
        <p role="alert" className="font-medium text-danger empty:sr-only">
          {error ?? (list.error && <Problem error={list.error} />)}
        </p>

        <div className="grid gap-2">
          <label htmlFor={searchId} className="font-medium">
            <FormattedMessage id="picker.search" />
          </label>
          <div className="relative">
            <span className="pointer-events-none absolute inset-y-0 left-3.5 flex items-center text-muted">
              <Icon name="search" />
            </span>
            <input
              id={searchId}
              type="search"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              className="min-h-11 w-full rounded-xl border border-edge bg-field pr-3 pl-11 focus-visible:outline-3 focus-visible:outline-brand"
            />
          </div>
        </div>
        {list.isPending && (
          <p className="text-muted">
            <FormattedMessage id="common.loading" />
          </p>
        )}
        {items?.length === 0 && (
          <p className="text-muted">
            <FormattedMessage id={search ? "media.noMatches" : "picker.empty"} />
          </p>
        )}
        <ul className="grid grid-cols-2 gap-x-4 gap-y-5 empty:hidden sm:grid-cols-3 md:grid-cols-4">
          {items?.map((item) => (
            <li key={item.id} className="min-w-0">
              <button
                type="button"
                onClick={() => onPick(item)}
                className="group grid w-full min-w-0 gap-1.5 rounded-xl text-left focus-visible:outline-3 focus-visible:outline-offset-4 focus-visible:outline-brand"
              >
                <img
                  src={item.thumbUrl ?? undefined}
                  alt=""
                  loading="lazy"
                  style={{ backgroundColor: item.dominantColor ?? undefined }}
                  className="aspect-[4/3] w-full rounded-xl object-cover ring-brand group-hover:ring-3"
                />
                <span className="truncate text-sm font-medium">{item.alt || item.name}</span>
              </button>
            </li>
          ))}
        </ul>
        {list.hasNextPage && (
          <div>
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
      </div>
    </Dialog>
  );
}
