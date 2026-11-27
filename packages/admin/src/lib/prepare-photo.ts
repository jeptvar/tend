// Gets a photo ready to send (PLAN.md v0.2). A HEIC photo becomes a JPEG where the browser can
// read one, which is Safari, and a photo too big for Tend, over 20 MB or 50 megapixels, is made
// smaller instead of refused. Anything else is sent as it is, and so is anything this browser
// can't draw: then Tend says what to do instead.

/** What Tend takes, as the server checks it. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_PIXELS = 50_000_000;
/**
 * The most a photo made here has: four times what the site's largest size needs, and less than
 * Safari on a phone will draw in one go (16.7 megapixels).
 */
const MADE_PIXELS = 16_000_000;
const JPEG_QUALITY = 0.88;
/** Enough of a file to find a JPEG's size after a camera's details and their thumbnail. */
const HEAD_BYTES = 512 * 1024;

export type PhotoKind = "jpeg" | "png" | "webp" | "gif" | "avif" | "heic";

export interface Size {
  width: number;
  height: number;
}

/** HEIC and HEIF say so in their brands, as AVIF does; the server tells them apart the same way. */
const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs"]);

function ascii(bytes: Uint8Array, at: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(at, at + length));
}

function uint32(bytes: Uint8Array, at: number): number {
  return (
    (((bytes[at] ?? 0) << 24) |
      ((bytes[at + 1] ?? 0) << 16) |
      ((bytes[at + 2] ?? 0) << 8) |
      (bytes[at + 3] ?? 0)) >>>
    0
  );
}

/** What kind of picture a file is, from its first bytes, or its name for a HEIC. */
export function kindOf(start: Uint8Array, name: string, type: string): PhotoKind | null {
  if (start[0] === 0xff && start[1] === 0xd8 && start[2] === 0xff) return "jpeg";
  if (start[0] === 0x89 && ascii(start, 1, 3) === "PNG") return "png";
  if (ascii(start, 0, 4) === "GIF8") return "gif";
  if (ascii(start, 0, 4) === "RIFF" && ascii(start, 8, 4) === "WEBP") return "webp";
  if (ascii(start, 4, 4) === "ftyp") {
    const end = Math.min(uint32(start, 0), start.length);
    const brands = [ascii(start, 8, 4)];
    for (let at = 16; at + 4 <= end; at += 4) brands.push(ascii(start, at, 4));
    if (brands.some((brand) => brand === "avif" || brand === "avis")) return "avif";
    if (brands.some((brand) => HEIC_BRANDS.has(brand)) || brands[0] === "mif1") return "heic";
  }
  if (/\.(heic|heics|heif|hif)$/i.test(name.trim()) || /^image\/hei[cf]/i.test(type)) {
    return "heic";
  }
  return null;
}

/** A JPEG's size, from the first frame header, which follows the camera's details. */
function jpegSize(bytes: Uint8Array): Size | null {
  let at = 2;
  while (at + 9 <= bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1] ?? 0;
    // Padding, and markers that stand alone, without a length.
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      at += 2;
      continue;
    }
    // The pictures start, or the file ends, with no frame header first.
    if (marker === 0xda || marker === 0xd9) return null;
    const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isFrame) {
      const height = ((bytes[at + 5] ?? 0) << 8) | (bytes[at + 6] ?? 0);
      const width = ((bytes[at + 7] ?? 0) << 8) | (bytes[at + 8] ?? 0);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    at += 2 + (((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0));
  }
  return null;
}

function webpSize(bytes: Uint8Array): Size | null {
  const chunk = ascii(bytes, 12, 4);
  const byte = (at: number) => bytes[at] ?? 0;
  if (chunk === "VP8X") {
    return {
      width: 1 + (byte(24) | (byte(25) << 8) | (byte(26) << 16)),
      height: 1 + (byte(27) | (byte(28) << 8) | (byte(29) << 16)),
    };
  }
  if (chunk === "VP8 " && byte(23) === 0x9d && byte(24) === 0x01 && byte(25) === 0x2a) {
    return {
      width: (byte(26) | (byte(27) << 8)) & 0x3fff,
      height: (byte(28) | (byte(29) << 8)) & 0x3fff,
    };
  }
  if (chunk === "VP8L" && byte(20) === 0x2f) {
    const bits = byte(21) | (byte(22) << 8) | (byte(23) << 16) | (byte(24) << 24);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
  }
  return null;
}

/** How many pixels a picture says it has, where that's in its first bytes. */
export function sizeOf(bytes: Uint8Array, kind: PhotoKind): Size | null {
  if (kind === "jpeg") return jpegSize(bytes);
  if (kind === "png" && ascii(bytes, 12, 4) === "IHDR") {
    return { width: uint32(bytes, 16), height: uint32(bytes, 20) };
  }
  if (kind === "webp") return webpSize(bytes);
  return null;
}

/** Whether a file that's too big as it is may still be made small enough here. */
export function mayBeMadeSmaller(file: File): boolean {
  return (
    /^image\/(jpeg|png|webp|avif|hei[cf])/i.test(file.type) ||
    /\.(jpe?g|png|webp|avif|heic|heics|heif|hif)$/i.test(file.name.trim())
  );
}

type Drawable = ImageBitmap | HTMLImageElement;

/** The picture, drawn the right way up, or null if this browser can't read it. */
async function decode(file: File): Promise<{ image: Drawable; done: () => void } | null> {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    return { image: bitmap, done: () => bitmap.close() };
  } catch {
    // Some browsers draw more kinds in an <img> than createImageBitmap takes.
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return { image, done: () => URL.revokeObjectURL(url) };
  } catch {
    URL.revokeObjectURL(url);
    return null;
  }
}

function widthOf(image: Drawable): number {
  return image instanceof HTMLImageElement ? image.naturalWidth : image.width;
}

function heightOf(image: Drawable): number {
  return image instanceof HTMLImageElement ? image.naturalHeight : image.height;
}

function draw(image: Drawable, scale: number, type: string): Promise<Blob | null> {
  const canvas = document.createElement("canvas");
  // Down, so it's never a pixel over what it's meant to stay under.
  canvas.width = Math.max(1, Math.floor(widthOf(image) * scale));
  canvas.height = Math.max(1, Math.floor(heightOf(image) * scale));
  const context = canvas.getContext("2d");
  if (!context) return Promise.resolve(null);
  // A JPEG can't see through, and what could would come out black.
  if (type === "image/jpeg") {
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
  }
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob(resolve, type, JPEG_QUALITY));
}

function renamed(name: string, ending: string): string {
  const base = name.trim().replace(/\.[a-z0-9]{1,5}$/i, "");
  return `${base || "photo"}.${ending}`;
}

/** The file to send: this one, or a JPEG or a smaller copy made from it. */
export async function preparePhoto(file: File): Promise<File> {
  const head = new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer());
  const kind = kindOf(head, file.name, file.type);
  // A GIF may move, which a drawing of it wouldn't.
  if (kind === null || kind === "gif") return file;
  const size = sizeOf(head, kind);
  const tooBig =
    file.size > MAX_FILE_BYTES || (size !== null && size.width * size.height > MAX_PIXELS);
  if (kind !== "heic" && !tooBig) return file;

  const decoded = await decode(file);
  if (!decoded) return file;
  try {
    const { image } = decoded;
    // A PNG stays one, so what can be seen through still can.
    const [type, ending] = kind === "png" ? ["image/png", "png"] : ["image/jpeg", "jpg"];
    let scale = Math.min(1, Math.sqrt(MADE_PIXELS / (widthOf(image) * heightOf(image))));
    for (let tries = 0; tries < 5; tries++) {
      const blob = await draw(image, scale, type);
      if (!blob) return file;
      if (blob.size <= MAX_FILE_BYTES) {
        return new File([blob], renamed(file.name, ending), {
          type,
          lastModified: file.lastModified,
        });
      }
      scale *= 0.75;
    }
    return file;
  } finally {
    decoded.done();
  }
}
