import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { etagOf } from "../static-files.ts";

export interface RenderedPage {
  status: number;
  html: string;
  /** HTML unless it says otherwise: feeds and the sitemap are XML. */
  type?: string;
}

export interface CachedPage {
  status: number;
  type?: string;
  etag: string;
  raw: Buffer;
  br: Buffer;
  gzip: Buffer;
  bytes: number;
}

/**
 * Node hands out small buffers as slices of a shared 64 KB block, and compression output
 * as slices of 16 KB chunks, and one small slice keeps its whole block alive. Stored as
 * they are, a cache that counts 20 MB can hold 600 MB. A copy of the exact size holds
 * only what it says.
 */
function exactCopy(buffer: Buffer): Buffer {
  const copy = Buffer.allocUnsafeSlow(buffer.length);
  buffer.copy(copy);
  return copy;
}

/** Whole pages, compressed ahead of time, so a hit is only a memory lookup (PLAN.md §10). */
export class PageCache {
  readonly #maxBytes: number;
  readonly #pages = new Map<string, CachedPage>();
  #bytes = 0;

  constructor(maxBytes: number) {
    this.#maxBytes = maxBytes;
  }

  get(key: string): CachedPage | undefined {
    const page = this.#pages.get(key);
    if (page) {
      // Moves it to the end, which is what makes the first one the oldest.
      this.#pages.delete(key);
      this.#pages.set(key, page);
    }
    return page;
  }

  set(key: string, rendered: RenderedPage): CachedPage {
    const raw = Buffer.from(rendered.html);
    const page: CachedPage = {
      status: rendered.status,
      ...(rendered.type ? { type: rendered.type } : {}),
      etag: etagOf(raw),
      raw: exactCopy(raw),
      br: exactCopy(brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } })),
      gzip: exactCopy(gzipSync(raw)),
      bytes: 0,
    };
    page.bytes = page.raw.length + page.br.length + page.gzip.length;

    const previous = this.#pages.get(key);
    if (previous) {
      this.#bytes -= previous.bytes;
      this.#pages.delete(key);
    }
    if (page.bytes > this.#maxBytes) return page;

    this.#pages.set(key, page);
    this.#bytes += page.bytes;
    while (this.#bytes > this.#maxBytes) {
      const oldest = this.#pages.entries().next();
      if (oldest.done) break;
      this.#bytes -= oldest.value[1].bytes;
      this.#pages.delete(oldest.value[0]);
    }
    return page;
  }

  /** Any change purges everything, which is simple. The router won't store a render that began before it. */
  clear(): void {
    this.#pages.clear();
    this.#bytes = 0;
  }

  get size(): number {
    return this.#pages.size;
  }

  get bytes(): number {
    return this.#bytes;
  }
}
