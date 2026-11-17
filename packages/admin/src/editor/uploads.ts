import { useSyncExternalStore } from "react";
import {
  type MediaItem,
  tooBigToUpload,
  type UploadWords,
  uploadErrorText,
  uploadFile,
  worthRetrying,
} from "../lib/media.ts";

/**
 * Pictures on their way up from the editor. The document holds a placeholder that names
 * one of these, and the picture's own view swaps it for the real one whenever the upload
 * is done, even if that's after an Undo and a Redo. They're kept here rather than in the
 * editor, so a slow upload survives the editor being rebuilt.
 */
export interface EditorUpload {
  id: string;
  name: string;
  /** When it started, so a description is only asked for if nothing's been typed since. */
  startedAt: number;
  /** Kept for trying again until it's uploaded, then let go of. */
  file: File | null;
  /** A local copy to show straight away, before anything's arrived. */
  previewUrl: string | null;
  progress: number;
  error: string | null;
  /** Whether trying again could help: not for a file that's too big or of the wrong kind. */
  retryable: boolean;
  done: MediaItem | null;
}

const uploads = new Map<string, EditorUpload>();
const requests = new Map<string, AbortController>();
const listeners = new Set<() => void>();
let nextId = 1;

function publish(upload: EditorUpload): void {
  uploads.set(upload.id, upload);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Still on the way: neither finished nor failed. */
export function isUploading(upload: EditorUpload | undefined): boolean {
  return upload !== undefined && upload.done === null && upload.error === null;
}

// Leaving mid-upload would lose the picture, so the browser asks first.
window.addEventListener("beforeunload", (event) => {
  if ([...uploads.values()].some(isUploading)) event.preventDefault();
});

async function run(id: string, words: UploadWords): Promise<void> {
  const upload = uploads.get(id);
  if (!upload?.file) return;
  const controller = new AbortController();
  requests.set(id, controller);
  try {
    const item = await uploadFile(upload.file, {
      signal: controller.signal,
      onProgress: (progress) => {
        const current = uploads.get(id);
        if (current) publish({ ...current, progress });
      },
    });
    const current = uploads.get(id);
    if (!current) return;
    // The local copy and the file itself aren't needed any more: the real picture is here.
    if (current.previewUrl) URL.revokeObjectURL(current.previewUrl);
    publish({ ...current, progress: 1, done: item, file: null, previewUrl: null });
  } catch (error) {
    const current = uploads.get(id);
    if (!current || controller.signal.aborted) return;
    publish({
      ...current,
      error: uploadErrorText(error, words),
      retryable: worthRetrying(error),
    });
  } finally {
    if (requests.get(id) === controller) requests.delete(id);
  }
}

/** Starts sending a file and returns the name its placeholder goes by. */
export function startUpload(file: File, words: UploadWords & { tooBig: string }): string {
  const id = `upload-${nextId++}`;
  const tooBig = tooBigToUpload(file);
  publish({
    id,
    name: file.name,
    startedAt: Date.now(),
    file,
    previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
    progress: 0,
    error: tooBig ? words.tooBig : null,
    retryable: false,
    done: null,
  });
  if (!tooBig) void run(id, words);
  return id;
}

export function retryUpload(id: string, words: UploadWords): void {
  const upload = uploads.get(id);
  if (!upload?.file || !upload.retryable) return;
  publish({ ...upload, error: null, progress: 0 });
  void run(id, words);
}

/** Done with, one way or another: stops it if it's still going, and lets its file go. */
export function forgetUpload(id: string): void {
  const upload = uploads.get(id);
  requests.get(id)?.abort();
  requests.delete(id);
  if (!upload) return;
  if (upload.previewUrl) URL.revokeObjectURL(upload.previewUrl);
  uploads.delete(id);
  for (const listener of listeners) listener();
}

export function getUpload(id: string): EditorUpload | undefined {
  return uploads.get(id);
}

export function useUpload(id: string | null): EditorUpload | undefined {
  return useSyncExternalStore(subscribe, () => (id ? uploads.get(id) : undefined));
}

/** Follows every upload, for anything that has to say how they're going. */
export function useUploadsChanged(): number {
  return useSyncExternalStore(subscribe, () => uploadsVersion);
}

let uploadsVersion = 0;
listeners.add(() => {
  uploadsVersion++;
});
