import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import os from "node:os";
import sharp, { type Metadata, type Sharp } from "sharp";
import { ApiError } from "../api/errors.ts";
import { HEIC_ENDINGS, OTHER_ENDINGS, SVG_ENDINGS } from "./endings.ts";

/** PLAN.md §5: what can be uploaded, and how big. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_PIXELS = 50_000_000;
/**
 * More frames than this take minutes to prepare however small each one is, and hold up
 * every other upload while they do.
 */
const MAX_FRAMES = 1000;
/** WebP can't be wider or taller than this, so no size visitors get is made bigger. */
const WEBP_MAX_SIDE = 16_383;
/** The widths visitors get. */
export const VARIANT_WIDTHS = [480, 960, 1600, 2400] as const;
const ICON_SIZES = new Set([32, 180, 512]);

export type ImageFormat = "jpeg" | "png" | "webp" | "gif" | "avif";

export type Sniffed =
  | { kind: "image"; format: ImageFormat }
  | { kind: "file"; format: "pdf" }
  | { kind: "heic" }
  | { kind: "svg" };

/** The endings a name can have: every name JPEGs go by, then the other kinds Tend takes. */
const ALLOWED_ENDINGS = new Set([
  "jpg",
  "jpeg",
  "jpe",
  "jfif",
  "jif",
  "pjpeg",
  "pjp",
  "png",
  "webp",
  "gif",
  "avif",
  "pdf",
]);
const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs"]);
const MIME: Record<ImageFormat | "pdf", string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  pdf: "application/pdf",
};
const EXTENSION: Record<ImageFormat | "pdf", string> = {
  jpeg: "jpg",
  png: "png",
  webp: "webp",
  gif: "gif",
  avif: "avif",
  pdf: "pdf",
};
/** How each kind is named in a sentence. */
const A_KIND: Record<ImageFormat | "pdf", string> = {
  jpeg: "a JPEG",
  png: "a PNG",
  webp: "a WebP",
  gif: "a GIF",
  avif: "an AVIF",
  pdf: "a PDF",
};

function startsWith(buffer: Buffer, bytes: number[], offset = 0): boolean {
  return bytes.every((byte, index) => buffer[offset + index] === byte);
}

function ascii(buffer: Buffer, start: number, end: number): string {
  return buffer.subarray(start, end).toString("latin1");
}

/** The most an "ftyp" box needs: its size, a brand, a version and a few more brands. */
const FTYP_MOST = 4096;

/**
 * The brands an ISO media file says it is, which is how AVIF and HEIC tell themselves apart.
 * The file has to start with a real "ftyp" box: its size as a number, then "ftyp". Text that
 * only looks like one, such as an SVG starting "<!--ftypavif", has a size of about a billion.
 */
function isoBrands(buffer: Buffer): string[] {
  if (buffer.length < 16 || ascii(buffer, 4, 8) !== "ftyp") return [];
  const declared = buffer.readUInt32BE(0);
  if (declared < 16 || declared > FTYP_MOST) return [];
  const boxSize = Math.min(declared, buffer.length, 256);
  const brands = [ascii(buffer, 8, 12)];
  for (let offset = 16; offset + 4 <= boxSize; offset += 4)
    brands.push(ascii(buffer, offset, offset + 4));
  return brands;
}

/** Space, an XML declaration and comments: what can come before an SVG's own start. */
const BEFORE_SVG = /^(?:\s|<\?[\s\S]*?\?>|<!--[\s\S]*?-->)*/;

/** Whether a file is an SVG drawing, from the start of its text. */
function isSvg(buffer: Buffer): boolean {
  // The mark some editors put first, read as single bytes, goes too.
  const text = ascii(buffer, 0, 4096)
    .replace(/^\xef\xbb\xbf/, "")
    .toLowerCase();
  const start = text.slice(BEFORE_SVG.exec(text)?.[0].length ?? 0);
  return start.startsWith("<svg") || start.startsWith("<!doctype svg");
}

/**
 * What a file really is, from its first bytes rather than its name or the type the browser
 * claims. Anything not recognised here is refused.
 */
export function sniff(buffer: Buffer): Sniffed | undefined {
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return { kind: "image", format: "jpeg" };
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { kind: "image", format: "png" };
  }
  const head = ascii(buffer, 0, 6);
  if (head === "GIF87a" || head === "GIF89a") return { kind: "image", format: "gif" };
  if (ascii(buffer, 0, 4) === "RIFF" && ascii(buffer, 8, 12) === "WEBP") {
    return { kind: "image", format: "webp" };
  }
  if (ascii(buffer, 0, 5) === "%PDF-") return { kind: "file", format: "pdf" };
  const brands = isoBrands(buffer);
  if (brands.includes("avif") || brands.includes("avis")) return { kind: "image", format: "avif" };
  if (brands.some((brand) => HEIC_BRANDS.has(brand)) || brands[0] === "mif1")
    return { kind: "heic" };
  if (isSvg(buffer)) return { kind: "svg" };
  return undefined;
}

const KINDS_TEXT = "Tend can use JPG, PNG, WebP, GIF and AVIF pictures, and PDF files.";

/**
 * The ending of a file's name, if it has one: what follows the last dot, when it's the ending
 * of a kind Tend takes or of another kind of file. Anything else after a dot is part of the
 * name, as in "Mt.Fuji", "Menu v2.final" or "Screenshot at 10.30.45", and the file's contents
 * decide what it is.
 */
export function fileEnding(name: string): string {
  const ending = /\.([a-z0-9]+)$/i.exec(name.trim())?.[1]?.toLowerCase() ?? "";
  return ALLOWED_ENDINGS.has(ending) || OTHER_ENDINGS.has(ending) ? ending : "";
}

function heicPhoto(): ApiError {
  return new ApiError(
    415,
    "heic_photo",
    "That's a HEIC photo, the kind iPhones take, and Tend can't use those yet.",
    {
      fix: "On the iPhone, open Settings, then Camera, then Formats, and choose Most Compatible before taking it again. On a Mac, open it in Preview, choose File, then Export, and pick JPEG.",
    },
  );
}

function svgFile(): ApiError {
  return new ApiError(
    415,
    "svg_file",
    "SVG pictures can't be used yet, because they can carry code.",
    {
      fix: `Export it as a PNG instead. ${KINDS_TEXT}`,
    },
  );
}

/**
 * A file Tend could use, with a name that says it's another kind of file: a mistake, or a
 * file trying to be two things at once. Renaming it is all it takes.
 */
function namedAsOtherKind(name: string, ending: string, format: ImageFormat | "pdf"): ApiError {
  const asTyped = name.trim().slice(-ending.length);
  return new ApiError(
    415,
    "unsupported_file",
    `That file is ${A_KIND[format]}, but its name ends in .${asTyped}.`,
    { fix: `Rename it to end in .${EXTENSION[format]}, then add it again.` },
  );
}

/** Checks an upload, by name and by contents, before any real work happens. */
export function checkUpload(
  name: string,
  buffer: Buffer,
): Exclude<Sniffed, { kind: "heic" | "svg" }> {
  const ending = fileEnding(name);
  const found = sniff(buffer);
  if (found?.kind === "heic") throw heicPhoto();
  if (found?.kind === "svg") throw svgFile();
  if (!found) {
    // Contents Tend doesn't know: the name is all there is to say what it is.
    if (HEIC_ENDINGS.has(ending)) throw heicPhoto();
    if (SVG_ENDINGS.has(ending)) throw svgFile();
    throw new ApiError(415, "unsupported_file", "Tend can't use that kind of file.", {
      fix: KINDS_TEXT,
    });
  }
  // The contents decide what it is, but a name that says it's another kind of file, such as
  // "photo.tiff" or "report.docx", is refused, saying how to rename it.
  if (OTHER_ENDINGS.has(ending)) throw namedAsOtherKind(name, ending, found.format);
  return found;
}

export interface ProcessedImage {
  original: Buffer;
  mime: string;
  ext: string;
  width: number;
  height: number;
  /** Shown while it loads. None for a picture with see-through parts: it would show through. */
  dominantColor: string | null;
  /** Widths and their WebP files, smallest first. */
  variants: { width: number; data: Buffer }[];
  sha256: string;
}

export interface ProcessedFile {
  original: Buffer;
  mime: string;
  ext: string;
  sha256: string;
}

function hashOf(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function hex(value: number): string {
  return Math.max(0, Math.min(255, Math.round(value)))
    .toString(16)
    .padStart(2, "0");
}

function cannotRead(): ApiError {
  return new ApiError(
    400,
    "unreadable_picture",
    "Tend couldn't read that picture. It may be damaged.",
    {
      fix: "Try exporting it again as a JPEG or PNG.",
    },
  );
}

function tooManyPixels(animated: boolean): ApiError {
  return animated
    ? new ApiError(
        413,
        "too_many_pixels",
        "That animation is too big to use: it has too many frames for its size.",
        {
          fix: "Make it smaller or shorter first.",
        },
      )
    : new ApiError(
        413,
        "too_many_pixels",
        "That picture is too big to use: it's over 50 megapixels.",
        {
          fix: "Make it smaller first, for example by exporting it 6000 pixels wide or less.",
        },
      );
}

function tooManyFrames(): ApiError {
  return new ApiError(
    413,
    "too_many_frames",
    `That animation has too many frames to use: Tend can take up to ${MAX_FRAMES.toLocaleString("en")}.`,
    { fix: "Make it shorter, or drop every other frame, then upload it again." },
  );
}

function tooLong(): ApiError {
  return new ApiError(
    413,
    "too_long",
    `That picture is too long and thin to use: the sizes visitors get can be at most ${WEBP_MAX_SIDE.toLocaleString("en")} pixels long.`,
    { fix: "Crop it, or split it into a few shorter pictures, then upload those." },
  );
}

// Memory (PLAN.md §11): at most 256 MB under load on a 512 MB host, and a friendly error
// rather than a crash. libvips can't read most kinds of picture a strip at a time, so a
// small file can need a lot of memory; what each kind needs was measured, and a picture
// that wouldn't fit is refused before it's decoded.

const MiB = 1024 * 1024;
/** What Tend itself uses while it serves pages: PLAN.md §11 allows 120 MB when idle. */
const TEND_ITSELF = 120 * MiB;
/** However little memory there is, ordinary photos still fit. */
const LEAST_BUDGET = 64 * MiB;
/** Below this, pictures are prepared one at a time, on one thread. */
const SMALL_HOST = 2048 * MiB;

export interface MemoryPlan {
  /** Bytes all picture work may use at once. */
  budget: number;
  /** How many pictures may be prepared at the same time. */
  atOnce: number;
  /** Whether libvips gets one thread: each thread holds its own share of a picture. */
  oneThread: boolean;
}

/** Half of the memory there is, less what Tend itself needs, goes to preparing pictures. */
export function memoryPlan(limit: number): MemoryPlan {
  const small = limit < SMALL_HOST;
  return {
    budget: Math.max(LEAST_BUDGET, Math.floor(limit / 2) - TEND_ITSELF),
    atOnce: small ? 1 : 2,
    oneThread: small,
  };
}

function readSystemFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** The cgroups this process is in, as Linux lists them: v2's own, then v1's memory one. */
function ownGroups(list: string): { v2?: string; v1?: string } {
  const groups: { v2?: string; v1?: string } = {};
  for (const line of list.split("\n")) {
    const [, controllers = "", path = ""] = /^\d+:([^:]*):(\/.*)$/.exec(line.trim()) ?? [];
    if (path === "" || path === "/") continue;
    if (controllers === "") groups.v2 = path;
    else if (controllers.split(",").includes("memory")) groups.v1 = path;
  }
  return groups;
}

/**
 * The memory this process can have: the computer's, or less when a container or a service
 * manager limits it, through cgroup v2 or, on older systems, v1.
 */
export function memoryLimit(
  read: (path: string) => string | undefined = readSystemFile,
  total = os.totalmem(),
): number {
  const { v2, v1 } = ownGroups(read("/proc/self/cgroup") ?? "");
  const files = [
    "/sys/fs/cgroup/memory.max",
    v2 ? `/sys/fs/cgroup${v2}/memory.max` : "",
    "/sys/fs/cgroup/memory/memory.limit_in_bytes",
    v1 ? `/sys/fs/cgroup/memory${v1}/memory.limit_in_bytes` : "",
  ];
  // "max", or v1's huge number, means no limit of its own.
  const limits = files
    .filter(Boolean)
    .map((path) => Number(read(path)?.trim() || Number.NaN))
    .filter((value) => Number.isFinite(value) && value > 0);
  return Math.min(total, ...limits);
}

/** [as it is, with see-through parts] */
type Pair = readonly [number, number];

// What preparing a picture needs, in bytes per pixel. Measured with sharp 0.35.5 on one
// thread, from 1 to 50 megapixels and with photos, flat colour and noise, as the peak
// memory above an idle process (PLAN.md §11 has the numbers), with a little room to spare.
// The original is saved again first, then the sizes are made. For JPEG and PNG only the
// larger of the two counts, because what turning a picture takes is given back first. The
// encoders of the other kinds don't give back what they used before the sizes are made, so
// for those the two add up.

/**
 * Saving the original again, per pixel. JPEG and PNG go a strip at a time; the others are
 * decoded whole, and their encoders keep copies of their own.
 */
const SAVE_AGAIN: Record<ImageFormat, Pair> = {
  jpeg: [0.5, 0.5],
  png: [0.5, 0.5],
  webp: [27, 40],
  gif: [32, 28],
  avif: [26, 54],
};
/** An AVIF of more than 8 bits a colour is decoded at 16 bits a colour: this much more. */
const DEEP_AVIF = 12;
/** Making the sizes: per pixel of the original, read again for them... */
const READ_AGAIN: Record<ImageFormat, Pair> = {
  jpeg: [0.5, 0.5],
  png: [0.5, 3.2],
  webp: [12, 16],
  gif: [8, 8],
  avif: [24, 24],
};
/** ...and per pixel of the largest size, which WebP encodes whole. */
const LARGEST_SIZE: Pair = [7, 50];
/**
 * Per pixel and colour: turning a photo the right way up needs all of it at once, whether
 * it's on its side or upside down (only a mirror image is put right a strip at a time)...
 */
const TURNED = 1.3;
/** ...and so does reading an interlaced PNG or a progressive JPEG, stored in passes. */
const IN_PASSES = 2.2;
/** An animation, per pixel of one frame... */
const ANIMATION_FRAME: Record<"gif" | "webp", Pair> = { gif: [66, 66], webp: [65, 80] };
/** ...and per pixel of every frame. */
const ANIMATION_ALL: Record<"gif" | "webp", Pair> = { gif: [3.2, 3.2], webp: [4.8, 7.5] };
/** Each frame counts as at least this many pixels: a frame has work of its own. */
const LEAST_FRAME_PIXELS = 64 * 64;
/** libvips' own buffers and everything else that doesn't grow with the picture. */
const OVERHEAD = 24 * MiB;
/** Each libvips thread's share of the picture as it goes. */
const PER_THREAD = 16 * MiB;

const PLAN = memoryPlan(memoryLimit());
/** The threads libvips would give each picture if left alone: often one for every core. */
const CORES = sharp.concurrency();

/**
 * How many threads libvips gets for a picture: one on a small server, and elsewhere no more
 * than an eighth of the budget can hold. On a server with many cores and little memory, the
 * threads' own shares would otherwise leave no room for the picture itself.
 */
function threadsFor(plan: MemoryPlan): number {
  if (plan.oneThread) return 1;
  return Math.max(1, Math.min(CORES, Math.floor(plan.budget / 8 / PER_THREAD)));
}

// libvips keeps no cache of its own, and gets only the threads the plan has room for.
sharp.cache(false);
sharp.concurrency(threadsFor(PLAN));

// libvips can read many more kinds of file than Tend takes, among them SVG, PDF and TIFF, and
// it picks its reader by looking at the bytes itself. So every reader is turned off except
// the ones for the kinds Tend takes, read from memory as Tend gives them: whatever a file
// pretends to be, it can't be read as anything else. An UltraHDR photo is read as the plain
// JPEG it also is, which is all Tend ever kept of it.
sharp.block({ operation: ["VipsForeignLoad"] });
sharp.unblock({
  operation: [
    "VipsForeignLoadJpegBuffer",
    "VipsForeignLoadPngBuffer",
    "VipsForeignLoadWebpBuffer",
    "VipsForeignLoadNsgifBuffer",
    "VipsForeignLoadHeifBuffer",
  ],
});

/** Width and height of one frame the right way up, which is how the sizes are made. */
function uprightSize(meta: Metadata): { width: number; height: number } {
  const height = meta.pageHeight ?? meta.height;
  const sideways = (meta.orientation ?? 1) >= 5;
  return sideways ? { width: height, height: meta.width } : { width: meta.width, height };
}

function isAnimated(meta: Metadata, format: ImageFormat): boolean {
  return (format === "gif" || format === "webp") && (meta.pages ?? 1) > 1;
}

interface Load {
  /** The upload itself, held while it's prepared. */
  inputBytes: number;
  /** libvips threads at work on it. */
  threads: number;
}

/** About how many bytes preparing this picture needs at its busiest. */
function workingSet(meta: Metadata, format: ImageFormat, load: Load): number {
  const fixed = OVERHEAD + load.threads * PER_THREAD + load.inputBytes;
  const frame = meta.width * (meta.pageHeight ?? meta.height);
  const seeThrough = meta.hasAlpha ? 1 : 0;
  if (isAnimated(meta, format)) {
    const kind = format as "gif" | "webp";
    const every = Math.max(frame, LEAST_FRAME_PIXELS) * (meta.pages ?? 1);
    return (
      fixed + ANIMATION_FRAME[kind][seeThrough] * frame + ANIMATION_ALL[kind][seeThrough] * every
    );
  }
  const colours = (meta.channels ?? 3) * (meta.depth === "ushort" ? 2 : 1);
  let save = SAVE_AGAIN[format][seeThrough] * frame;
  if (format === "avif" && meta.depth === "ushort") save += DEEP_AVIF * frame;
  if ((meta.orientation ?? 1) >= 3) save += TURNED * colours * frame;
  if (meta.isProgressive && (format === "jpeg" || format === "png")) {
    save += IN_PASSES * colours * frame;
  }
  const upright = uprightSize(meta);
  const top = widthsFor(upright.width, upright.height).at(-1) ?? 0;
  const topPixels = top * Math.ceil((upright.height * top) / upright.width);
  const sizes = LARGEST_SIZE[seeThrough] * topPixels + READ_AGAIN[format][seeThrough] * frame;
  const stripByStrip = format === "jpeg" || format === "png";
  return fixed + (stripByStrip ? Math.max(save, sizes) : save + sizes);
}

/**
 * Why a picture that needs more memory than this server has for it is refused: the most
 * megapixels a picture like it can have here, and what to do instead.
 */
function tooBigForServer(
  meta: Metadata,
  format: ImageFormat,
  budget: number,
  load: Load,
): ApiError {
  const animated = isAnimated(meta, format);
  // The largest copy of it that fits, found by halving the difference.
  const fits = (scale: number) => {
    const width = Math.max(1, Math.floor(meta.width * scale));
    const height = Math.max(1, Math.floor((meta.pageHeight ?? meta.height) * scale));
    return workingSet({ ...meta, width, height, pageHeight: height }, format, load) <= budget;
  };
  let low = 0;
  let high = 1;
  for (let step = 0; step < 20; step++) {
    const middle = (low + high) / 2;
    if (fits(middle)) low = middle;
    else high = middle;
  }
  const upright = uprightSize(meta);
  const frames = animated ? (meta.pages ?? 1) : 1;
  const megapixels = (upright.width * upright.height * low * low * frames) / 1e6;
  const shown =
    megapixels >= 10 ? Math.floor(megapixels) : Math.max(0.1, Math.floor(megapixels * 10) / 10);
  if (animated) {
    return new ApiError(
      413,
      "too_big_for_server",
      `That animation is too big for this server to prepare. Here, ${A_KIND[format]} animation like this one can be up to ${shown} megapixels, counting every frame.`,
      { fix: "Make it smaller or shorter first, then upload it again." },
    );
  }
  const wide = Math.max(100, Math.floor((upright.width * low) / 100) * 100);
  const jpeg =
    format === "jpeg" || meta.hasAlpha
      ? ""
      : " Or save it as a JPEG, which needs much less memory.";
  return new ApiError(
    413,
    "too_big_for_server",
    `That picture is too big for this server to prepare. Here, ${A_KIND[format]} like this one can be up to ${shown} megapixels.`,
    {
      fix: `Make it smaller first, for example by exporting it ${wide.toLocaleString("en")} pixels wide or less.${jpeg}`,
    },
  );
}

interface Turn {
  cost: number;
  start: () => void;
}
let running = 0;
let reserved = 0;
const waiting: Turn[] = [];

/** Starts whoever is first in line, while there's room for them. */
function startWaiting(): void {
  while (waiting.length > 0) {
    const next = waiting[0] as Turn;
    const room = running === 0 || (running < PLAN.atOnce && reserved + next.cost <= PLAN.budget);
    if (!room) return;
    waiting.shift();
    running++;
    reserved += next.cost;
    next.start();
  }
}

/**
 * Picture work takes turns, in the order it came, so whatever runs together fits in the
 * memory set aside for it: a big picture is prepared alone. libvips then uses the threads
 * its cost was worked out for, whatever it was set to before.
 */
async function inTurn<T>(cost: number, threads: number, work: () => Promise<T>): Promise<T> {
  const share = Math.min(cost, PLAN.budget);
  await new Promise<void>((start) => {
    waiting.push({ cost: share, start });
    startWaiting();
  });
  try {
    sharp.concurrency(threads);
    return await work();
  } finally {
    running--;
    reserved -= share;
    startWaiting();
  }
}

/** The sizes made for a picture this wide: the standard ones below it, then its own. */
export function widthsFor(width: number, height?: number): number[] {
  const largest = VARIANT_WIDTHS[VARIANT_WIDTHS.length - 1] as number;
  // A tall picture's sizes are narrower, so that none is taller than WebP allows.
  const fitsWebp = height === undefined ? width : Math.floor((WEBP_MAX_SIDE * width) / height);
  const top = Math.min(width, largest, fitsWebp);
  if (top < 1) return [];
  return [...VARIANT_WIDTHS.filter((size) => size < top), top];
}

/** How many bytes a GIF's colour table takes, from the flags before it. */
function colourTableBytes(flags = 0): number {
  return flags & 0x80 ? 3 * 2 ** ((flags & 0x07) + 1) : 0;
}

/** Where a run of GIF data blocks ends: each starts with its length, and an empty one ends them. */
function afterBlocks(gif: Buffer, start: number): number {
  let at = start;
  while (at < gif.length && gif[at] !== 0) at += (gif[at] as number) + 1;
  return at + 1;
}

/** How many frames a GIF has: one for each image in it, found by stepping over the rest. */
function gifFrames(gif: Buffer): number {
  let frames = 0;
  let at = 13 + colourTableBytes(gif[10]);
  while (at < gif.length) {
    if (gif[at] === 0x2c) {
      // An image: where it goes and how big, its own colours, then its pixels.
      frames++;
      at = afterBlocks(gif, at + 11 + colourTableBytes(gif[at + 9]));
    } else if (gif[at] === 0x21) {
      at = afterBlocks(gif, at + 2);
    } else {
      // The end, or bytes no reader could follow.
      break;
    }
  }
  return frames;
}

/** How many chunks of a kind a WebP file has: an animation has an "ANMF" for every frame. */
function webpChunks(webp: Buffer, kind: string): number {
  let count = 0;
  let at = 12;
  while (at + 8 <= webp.length) {
    if (ascii(webp, at, at + 4) === kind) count++;
    const size = webp.readUInt32LE(at + 4);
    at += 8 + size + (size % 2);
  }
  return count;
}

/**
 * How many frames a picture has, counted from its bytes. sharp counts them by reading every
 * frame first, which for a file of 400,000 tiny frames takes minutes, and every upload
 * after it waits.
 */
function framesIn(input: Buffer, format: ImageFormat): number {
  if (format === "gif") return gifFrames(input);
  if (format === "webp") return Math.max(1, webpChunks(input, "ANMF"));
  return 1;
}

/**
 * What a WebP's first bytes say about it: its size, whether it has see-through parts, and,
 * with the frames counted, whether it's an animation. Just to say how big one is, sharp sets
 * aside 4 bytes for every pixel, so a small file claiming a huge picture would take gigabytes
 * before it could be refused.
 */
function webpHeader(webp: Buffer, frames: number): Metadata | undefined {
  if (webp.length < 30) return undefined;
  const chunk = ascii(webp, 12, 16);
  let size: { width: number; height: number; hasAlpha: boolean } | undefined;
  if (chunk === "VP8X") {
    // Its flags say whether any frame has see-through parts.
    const hasAlpha = ((webp[20] as number) & 0x10) !== 0;
    size = { width: webp.readUIntLE(24, 3) + 1, height: webp.readUIntLE(27, 3) + 1, hasAlpha };
  } else if (chunk === "VP8L") {
    const bits = webp.readUInt32LE(21);
    const hasAlpha = ((bits >>> 28) & 1) === 1;
    size = { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, hasAlpha };
  } else if (chunk === "VP8 ") {
    const width = webp.readUInt16LE(26) & 0x3fff;
    size = { width, height: webp.readUInt16LE(28) & 0x3fff, hasAlpha: false };
  }
  if (!size) return undefined;
  const channels = size.hasAlpha ? 4 : 3;
  return { ...size, channels, pageHeight: size.height, pages: frames } as Metadata;
}

/**
 * What sharp will really read a file as must be what its first bytes said. Only the readers
 * for the kinds Tend takes are left on, but an AVIF's reader also reads HEIC photos.
 */
function checkReader(meta: Metadata, format: ImageFormat): void {
  const same =
    format === "avif"
      ? meta.format === "heif" && meta.compression === "av1"
      : meta.format === format;
  if (same) return;
  if (meta.format === "svg") throw svgFile();
  if (meta.format === "heif") throw heicPhoto();
  throw cannotRead();
}

/** The 50 MP limit, which counts every frame of an animation. */
function checkPixels(meta: Metadata, format: ImageFormat): void {
  const animated = isAnimated(meta, format);
  // Without asking for every frame, sharp describes only the first one.
  const frames = animated ? (meta.pages ?? 1) : 1;
  if (meta.width * (meta.pageHeight ?? meta.height) * frames > MAX_PIXELS) {
    throw tooManyPixels(animated);
  }
}

/** Everything that can be known from a picture's header, checked before it's decoded. */
async function readHeader(
  input: Buffer,
  format: ImageFormat,
  budget: number,
  load: Load,
): Promise<Metadata> {
  // The first bytes must say it's the kind it was taken for, before sharp sees any of it.
  const said = sniff(input);
  if (said?.kind === "svg") throw svgFile();
  if (said?.kind === "heic") throw heicPhoto();
  if (said?.kind !== "image" || said.format !== format) throw cannotRead();
  const frames = framesIn(input, format);
  if (frames > MAX_FRAMES) throw tooManyFrames();
  let cost = OVERHEAD;
  if (format === "webp") {
    // The least a WebP like this can need, before sharp sets 4 bytes a pixel aside for it.
    const least = webpHeader(input, frames);
    if (!least) throw cannotRead();
    checkPixels(least, format);
    if (workingSet(least, format, load) > budget) {
      throw tooBigForServer(least, format, budget, load);
    }
    cost += least.width * least.height * 4;
  }
  const meta = await inTurn(cost, load.threads, () =>
    sharp(input)
      .metadata()
      .catch(() => undefined),
  );
  if (!meta?.width || !meta.height) throw cannotRead();
  checkReader(meta, format);
  if (isAnimated(meta, format) && (meta.pages ?? 1) > MAX_FRAMES) throw tooManyFrames();
  checkPixels(meta, format);
  const upright = uprightSize(meta);
  if (widthsFor(upright.width, upright.height).length === 0) throw tooLong();
  if (workingSet(meta, format, load) > budget) throw tooBigForServer(meta, format, budget, load);
  return meta;
}

/** The original saved again in its own format, which drops everything but the pixels. */
function encodeOriginal(image: Sharp, format: ImageFormat): Sharp {
  if (format === "jpeg") {
    // Optimised Huffman tables make libjpeg keep every coefficient of the picture at once,
    // about 6 bytes a pixel, for a file about a tenth smaller. Without them it's written
    // a strip at a time.
    return image.jpeg({ quality: 90, optimiseCoding: false });
  }
  if (format === "png") return image.png();
  if (format === "webp") return image.webp({ quality: 90 });
  if (format === "gif") return image.gif();
  // Colour at half the resolution of brightness, as photos are usually stored: the encoder
  // then needs about a third less memory.
  return image.avif({ quality: 60, chromaSubsampling: "4:2:0" });
}

/**
 * The colour shown while a picture loads, from its smallest size. A picture with see-through
 * parts gets none, because the colour would show through them for good, and an animation
 * that can have them in any frame is treated as having them.
 */
async function colourBehind(smallest: Buffer, animated: boolean): Promise<string | null> {
  const { isOpaque, channels, dominant } = await sharp(smallest).stats();
  if (!isOpaque || (animated && channels.length === 4)) return null;
  return `#${hex(dominant.r)}${hex(dominant.g)}${hex(dominant.b)}`;
}

/** Saves the original again, then makes the sizes visitors get from it. */
async function prepare(
  input: Buffer,
  format: ImageFormat,
  meta: Metadata,
): Promise<ProcessedImage> {
  const animated = isAnimated(meta, format);
  try {
    const options = { limitInputPixels: MAX_PIXELS, failOn: "error" as const, animated };
    const open = (data: Buffer) => sharp(data, options);
    // An animation has no camera orientation to fix, and libvips can't turn one anyway.
    const oriented = animated ? open(input) : open(input).rotate();
    const { data: original, info } = await encodeOriginal(oriented, format).toBuffer({
      resolveWithObject: true,
    });
    const width = info.width;
    const height = animated ? (meta.pageHeight ?? meta.height) : info.height;

    // JPEG and PNG are read again a strip at a time, and a JPEG shrinks while it loads, so
    // each of their sizes comes from the original: decoding the largest WebP size whole, to
    // make the next, took more memory than all the rest. The other kinds are decoded whole
    // every time, so each of their sizes comes from the next-largest.
    const fromOriginal = !animated && (format === "jpeg" || format === "png");
    const variants: { width: number; data: Buffer }[] = [];
    let source = original;
    for (const size of widthsFor(width, height).reverse()) {
      const data = await open(source)
        .resize({ width: size, withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer();
      variants.unshift({ width: size, data });
      if (!fromOriginal) source = data;
    }
    return {
      original,
      mime: MIME[format],
      ext: EXTENSION[format],
      width,
      height,
      dominantColor: await colourBehind((variants[0] as { data: Buffer }).data, animated),
      variants,
      sha256: hashOf(original),
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const message = (error as Error).message;
    if (/pixel limit/i.test(message)) throw tooManyPixels(animated);
    if (/too large for the/i.test(message)) throw tooLong();
    throw cannotRead();
  }
}

/**
 * Re-encodes a picture, which turns it the right way up, drops EXIF and GPS details and
 * defeats files pretending to be two things at once, then makes the sizes visitors get.
 * Everything that can be checked from its header is, first, so a picture too big for this
 * server is refused rather than decoded. `memoryLimit` plans for a server with that much.
 */
export async function processImage(
  input: Buffer,
  format: ImageFormat,
  options: { memoryLimit?: number } = {},
): Promise<ProcessedImage> {
  const plan = options.memoryLimit === undefined ? PLAN : memoryPlan(options.memoryLimit);
  const load = { inputBytes: input.length, threads: threadsFor(plan) };
  const meta = await readHeader(input, format, plan.budget, load);
  return inTurn(workingSet(meta, format, load), load.threads, () => prepare(input, format, meta));
}

export function processFile(input: Buffer): ProcessedFile {
  return { original: input, mime: MIME.pdf, ext: EXTENSION.pdf, sha256: hashOf(input) };
}

/** How many pixels a picture's first frame has, without sharp setting memory aside for a WebP's. */
async function pixelsOf(input: Buffer, format: ImageFormat): Promise<number> {
  const size =
    format === "webp"
      ? webpHeader(input, 1)
      : await sharp(input)
          .metadata()
          .catch(() => undefined);
  return size?.width && size.height ? size.width * size.height : 0;
}

/** A square site icon, made from the logo, for browsers and phone home screens. */
export async function makeIcon(source: Buffer, size: number): Promise<Buffer> {
  if (!ICON_SIZES.has(size)) throw new Error("not an icon size");
  // The logo fitted this server's memory when it was uploaded, so this only waits for room
  // while a big picture is being prepared.
  const found = sniff(source);
  const format = found?.kind === "image" ? found.format : "png";
  const threads = threadsFor(PLAN);
  const cost =
    OVERHEAD +
    threads * PER_THREAD +
    Math.max(...READ_AGAIN[format]) * (await pixelsOf(source, format));
  return inTurn(cost, threads, () =>
    sharp(source, { limitInputPixels: MAX_PIXELS })
      .resize({
        width: size,
        height: size,
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toBuffer(),
  );
}

export function isIconSize(size: number): boolean {
  return ICON_SIZES.has(size);
}
