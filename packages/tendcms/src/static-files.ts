import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";
import type { Context } from "hono";

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

/** The encoding to send: only one the visitor listed and didn't refuse with q=0. */
export function preferredEncoding(acceptEncoding: string | undefined): "br" | "gzip" | undefined {
  const accepted = new Set<string>();
  for (const part of (acceptEncoding ?? "").split(",")) {
    const [name, ...parameters] = part.split(";").map((piece) => piece.trim().toLowerCase());
    const quality = parameters.find((parameter) => parameter.startsWith("q="));
    if (name && !(quality && Number(quality.slice(2)) === 0)) accepted.add(name);
  }
  if (accepted.has("br")) return "br";
  return accepted.has("gzip") ? "gzip" : undefined;
}

/**
 * A weak tag, because the same one stands for a page however it's encoded. Proxies that
 * encode it again make a strong one weak anyway, and it has to match then too.
 */
export function etagOf(raw: Buffer): string {
  return `W/"${createHash("sha256").update(raw).digest("base64url").slice(0, 22)}"`;
}

/** Whether a browser has this already, from its If-None-Match: one tag, several, or any. */
export function hasAlready(ifNoneMatch: string | undefined, etag: string): boolean {
  if (ifNoneMatch === undefined) return false;
  const plain = (tag: string) => tag.trim().replace(/^W\//, "");
  return (
    ifNoneMatch.trim() === "*" || ifNoneMatch.split(",").some((tag) => plain(tag) === plain(etag))
  );
}

const compressBr = promisify(brotliCompress);
const compressGzip = promisify(gzip);
const COMPRESSIBLE = /^(?:text\/|application\/json|image\/svg\+xml)/;
/** Smaller than this, what compressing saves is less than one packet. */
const WORTH_COMPRESSING = 1024;
/** Files that don't change, or hardly, so worth more work once than pages are each time. */
const BROTLI_QUALITY = 9;
/** Bigger files are read each time. Everything Tend comes with is far smaller. */
const MOST_KEPT = 4 * 1024 * 1024;

interface KeptFile {
  raw: Buffer;
  etag: string;
  br?: Buffer;
  gzip?: Buffer;
}

async function load(path: string): Promise<KeptFile> {
  const raw = await readFile(path);
  const file: KeptFile = { raw, etag: etagOf(raw) };
  if (raw.length < WORTH_COMPRESSING || !COMPRESSIBLE.test(contentTypeFor(path))) return file;
  // In the thread pool, so nothing waits for it.
  const [br, gz] = await Promise.all([
    compressBr(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY } }),
    compressGzip(raw),
  ]);
  return { ...file, br, gzip: gz };
}

/**
 * The admin's files and a theme's, compressed the first time each is asked for and kept, until
 * the file changes. Only for folders with few files in them: nothing is ever let go.
 */
export class StaticFiles {
  readonly #kept = new Map<string, { stamp: string; file: Promise<KeptFile> }>();

  /** A file, or undefined if there isn't one. */
  async #get(path: string): Promise<KeptFile | undefined> {
    const info = await stat(path).catch(() => undefined);
    if (!info?.isFile()) return undefined;
    if (info.size > MOST_KEPT) return load(path);
    const stamp = `${info.mtimeMs}-${info.size}`;
    const kept = this.#kept.get(path);
    if (kept?.stamp === stamp) return kept.file;
    const file = load(path);
    this.#kept.set(path, { stamp, file });
    // One that couldn't be read is tried again.
    file.catch(() => this.#kept.delete(path));
    return file;
  }

  /** Sends a file as the visitor can take it, or a 304 if they have it. */
  async send(c: Context, path: string, cacheControl: string): Promise<Response | undefined> {
    const file = await this.#get(path);
    if (!file) return undefined;
    const headers: Record<string, string> = {
      "Content-Type": contentTypeFor(path),
      "Cache-Control": cacheControl,
      ETag: file.etag,
      Vary: "Accept-Encoding",
    };
    if (hasAlready(c.req.header("if-none-match"), file.etag)) {
      return new Response(null, { status: 304, headers });
    }
    const encoding = file.br ? preferredEncoding(c.req.header("accept-encoding")) : undefined;
    const body = (encoding && file[encoding]) || file.raw;
    if (encoding) headers["Content-Encoding"] = encoding;
    headers["Content-Length"] = String(body.length);
    return new Response(c.req.method === "HEAD" ? null : new Uint8Array(body), { headers });
  }
}
