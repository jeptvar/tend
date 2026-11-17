import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import type { IntlShape } from "react-intl";
import { ApiError, api, errorText, OFFLINE } from "./api.ts";

export interface MediaItem {
  id: string;
  kind: "image" | "file";
  name: string;
  mime: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  alt: string | null;
  decorative: boolean;
  caption: string | null;
  credit: string | null;
  dominantColor: string | null;
  /** The file as uploaded. */
  url: string;
  thumbUrl: string | null;
  previewUrl: string | null;
  srcset: string;
  uploadedBy: { id: string; name: string | null } | null;
  createdAt: number;
  updatedAt: number;
  trashedAt: number | null;
}

export interface MediaPage {
  media: MediaItem[];
  nextCursor: string | null;
}

export interface MediaUse {
  id: string;
  /**
   * A post or page, or a part of the site itself: its logo, icon or picture for sharing, or a
   * link in the site menu.
   */
  type: "post" | "page" | "logo" | "icon" | "share" | "menu";
  title: string;
  url: string | null;
  inDraft: boolean;
  /** Only when moving it to the Trash: this page links to it, rather than showing it. */
  linkOnly?: boolean;
}

/** Where a use is changed: its post or page, or the screen that chose it for the whole site. */
export function linkForUse(use: MediaUse): string {
  if (use.type === "logo" || use.type === "icon") return "/design";
  if (use.type === "share") return "/settings/search";
  if (use.type === "menu") return "/menu";
  return `/${use.type === "post" ? "posts" : "pages"}/${use.id}`;
}

export function isSiteUse(
  use: MediaUse,
): use is MediaUse & { type: "logo" | "icon" | "share" | "menu" } {
  return use.type === "logo" || use.type === "icon" || use.type === "share" || use.type === "menu";
}

export const MEDIA_KEY = ["media"];

export function mediaListKey(trashed: boolean, query: string, kind?: "image" | "file") {
  return [...MEDIA_KEY, "list", trashed ? "trash" : "all", query, kind ?? "any"];
}

export function mediaItemKey(id: string) {
  return [...MEDIA_KEY, "item", id];
}

/**
 * What Tend can take, for the file picker; the server checks the files themselves. HEIC
 * isn't listed on purpose: then an iPhone turns its photos into JPEGs as they're picked.
 */
export const ACCEPTED_FILES =
  "image/jpeg,image/png,image/webp,image/gif,image/avif,application/pdf";
export const ACCEPTED_PICTURES = "image/jpeg,image/png,image/webp,image/gif,image/avif";
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
/**
 * Files sent at once from this window. Tend makes them ready two at a time, and only takes a
 * few at once from everyone together, so sending more at once would only make them wait.
 */
const SENDING_AT_ONCE = 2;
/** How long to keep trying while Tend is busy with other uploads: about a minute. */
const BUSY_TRIES = 30;
const BUSY_WAIT_MS = 2000;
const BUSY_WAIT_MAX_MS = 30_000;
/** Pictures asked about in one lookup, so its address never gets too long to send. */
const LOOKUP_BATCH = 200;

type UploadOptions = {
  replace?: string;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
};

/** Tend said it's busy with other uploads (503), and how long to wait before trying again. */
class BusyError extends ApiError {
  readonly waitMs: number;

  constructor(
    status: number,
    code: string,
    message: string,
    fix: string | undefined,
    waitMs: number,
  ) {
    super(status, code, message, undefined, fix);
    this.waitMs = waitMs;
  }
}

/**
 * Offline, a file that stopped arriving partway (408), or the server having a moment, which
 * includes being busy with other uploads (503): the kinds of failure that trying again can
 * fix. Not a file that's too big or the wrong kind.
 */
export function worthRetrying(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  return (
    error.code === OFFLINE || error.status === 408 || error.status === 429 || error.status >= 500
  );
}

/** What a screen says when a file wasn't uploaded and Tend's own words can't be shown. */
export interface UploadWords {
  /** Tend didn't answer. */
  offline: string;
  /** The file stopped arriving partway, and Tend gave up waiting for the rest. */
  stalled: string;
}

export function uploadWords(intl: IntlShape): UploadWords {
  return {
    offline: intl.formatMessage({ id: "media.uploadOffline" }),
    stalled: intl.formatMessage({ id: "media.uploadStalled" }),
  };
}

/**
 * What happened to a file that wasn't uploaded, and what to do. A stalled one is told in the
 * admin's own words, since a proxy in front of Tend may have given up on it first and sent a
 * page of its own.
 */
export function uploadErrorText(error: unknown, words: UploadWords): string {
  if (error instanceof ApiError && error.status === 408) return words.stalled;
  return errorText(error, words.offline);
}

function stopped(): DOMException {
  return new DOMException("Stopped", "AbortError");
}

/** Waits, unless the upload is stopped meanwhile. */
function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(stopped());
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(stopped());
    };
    signal?.addEventListener("abort", stop, { once: true });
  });
}

let sending = 0;
const waitingToSend: (() => void)[] = [];

/** Waits for a turn to send, and gives back what hands the turn on afterwards. */
function turnToSend(signal: AbortSignal | undefined): Promise<() => void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(stopped());
    const start = () => {
      sending++;
      let handedOn = false;
      resolve(() => {
        if (handedOn) return;
        handedOn = true;
        sending--;
        waitingToSend.shift()?.();
      });
    };
    if (sending < SENDING_AT_ONCE) return start();
    const go = () => {
      signal?.removeEventListener("abort", stop);
      start();
    };
    const stop = () => {
      const at = waitingToSend.indexOf(go);
      if (at >= 0) waitingToSend.splice(at, 1);
      reject(stopped());
    };
    waitingToSend.push(go);
    signal?.addEventListener("abort", stop, { once: true });
  });
}

/**
 * Sends one file as it is, reporting how much has gone. If Tend is busy with other uploads,
 * it waits as long as Tend asks and sends it again, so a pile of files dropped at once all
 * arrive without anyone having to press Try again.
 */
export async function uploadFile(file: File, options: UploadOptions = {}): Promise<MediaItem> {
  const handOn = await turnToSend(options.signal);
  try {
    for (let tries = 1; ; tries++) {
      try {
        return await sendFile(file, options);
      } catch (error) {
        if (!(error instanceof BusyError) || tries >= BUSY_TRIES) throw error;
        options.onProgress?.(0);
        await pause(error.waitMs, options.signal);
      }
    }
  } finally {
    handOn();
  }
}

/** How long Tend asked to wait, in its Retry-After, kept within reason. */
function retryAfterMs(request: XMLHttpRequest): number {
  const seconds = Number(request.getResponseHeader("Retry-After"));
  if (!Number.isFinite(seconds) || seconds <= 0) return BUSY_WAIT_MS;
  return Math.min(seconds * 1000, BUSY_WAIT_MAX_MS);
}

/**
 * One try at sending a file. XMLHttpRequest rather than fetch, because only it can say how an
 * upload is going.
 */
function sendFile(file: File, options: UploadOptions): Promise<MediaItem> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    const path = options.replace
      ? `/api/admin/media/${options.replace}/replace`
      : "/api/admin/media";
    request.open("POST", path);
    request.setRequestHeader("Content-Type", "application/octet-stream");
    request.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
    request.responseType = "json";
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) options.onProgress?.(event.loaded / event.total);
    };
    request.onload = () => {
      const body = request.response as
        | (MediaItem & { error?: { code: string; message: string; fix?: string } })
        | null;
      if (request.status >= 200 && request.status < 300 && body) {
        resolve(body);
      } else if (body?.error && request.status === 503) {
        const { code, message, fix } = body.error;
        reject(new BusyError(request.status, code, message, fix, retryAfterMs(request)));
      } else if (body?.error) {
        const { code, message, fix } = body.error;
        reject(new ApiError(request.status, code, message, undefined, fix));
      } else if (request.status === 408) {
        // Given up on by something in front of Tend, which sent a page of its own.
        reject(new ApiError(408, "upload_stalled", "That file stopped arriving partway through."));
      } else {
        reject(new ApiError(0, OFFLINE, "Can't reach Tend."));
      }
    };
    request.onerror = () => reject(new ApiError(0, OFFLINE, "Can't reach Tend."));
    request.onabort = () => reject(stopped());
    if (options.signal?.aborted) return reject(stopped());
    options.signal?.addEventListener("abort", () => request.abort(), { once: true });
    request.send(file);
  });
}

/**
 * Pictures by their IDs, in the Trash or not, asked about a batch at a time: a document can
 * have hundreds, and one address listing them all could be too long to send.
 */
export async function lookUpMedia(ids: readonly string[]): Promise<MediaItem[]> {
  const found: MediaItem[] = [];
  for (let start = 0; start < ids.length; start += LOOKUP_BATCH) {
    const batch = ids.slice(start, start + LOOKUP_BATCH);
    const { media } = await api<MediaPage>(`/admin/media?ids=${batch.join(",")}`);
    found.push(...media);
  }
  return found;
}

/** Refused before it's sent, so nobody waits for 30 MB to upload only to hear it's too big. */
export function tooBigToUpload(file: File): boolean {
  return file.size > MAX_FILE_BYTES;
}

/**
 * Pictures a document uses, looked up together. Something just uploaded is known straight
 * away, before the lookup that includes it comes back.
 */
export function useMediaItems(ids: string[]) {
  const queryClient = useQueryClient();
  const wanted = [...new Set(ids)].sort();
  const query = useQuery({
    queryKey: [...MEDIA_KEY, "lookup", wanted.join(",")],
    enabled: wanted.length > 0,
    staleTime: 60_000,
    // Adding a picture shouldn't make the others blink while the new list is fetched.
    placeholderData: keepPreviousData,
    queryFn: async (): Promise<MediaPage> => ({
      media: await lookUpMedia(wanted),
      nextCursor: null,
    }),
  });
  const found = new Map<string, MediaItem>();
  for (const id of wanted) {
    const known = queryClient.getQueryData<MediaItem>(mediaItemKey(id));
    if (known) found.set(id, known);
  }
  for (const item of query.data?.media ?? []) {
    const known = found.get(item.id);
    if (!known || known.updatedAt <= item.updatedAt) found.set(item.id, item);
  }
  return {
    found,
    /** Still finding out about these, so a missing one may just not have arrived yet. */
    isPending: wanted.length > 0 && (query.isPending || query.isPlaceholderData),
    isError: query.isError,
  };
}

/** Puts a changed item everywhere it's cached, so every view agrees at once. */
export function rememberMedia(
  queryClient: ReturnType<typeof useQueryClient>,
  item: MediaItem,
): void {
  queryClient.setQueryData(mediaItemKey(item.id), item);
  void queryClient.invalidateQueries({ queryKey: [...MEDIA_KEY, "lookup"] });
}

export function formatBytes(bytes: number, locale: string): string {
  const units = ["byte", "kilobyte", "megabyte"] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: units[unit],
    unitDisplay: "short",
    maximumFractionDigits: unit === 0 ? 0 : 1,
  }).format(value);
}
