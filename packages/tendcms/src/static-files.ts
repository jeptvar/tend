import { extname, join, normalize, sep } from "node:path";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

export function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path)] ?? "application/octet-stream";
}

/** Resolves a URL path inside a folder, or returns null if it would escape the folder. */
export function resolveInside(root: string, encodedPath: string): string | null {
  let relative: string;
  try {
    relative = decodeURIComponent(encodedPath);
  } catch {
    return null;
  }
  const path = normalize(join(root, relative));
  return path.startsWith(root + sep) ? path : null;
}
