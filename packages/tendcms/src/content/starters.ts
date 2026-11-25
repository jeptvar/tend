import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Orm } from "../db/client.ts";
import type { Starter } from "../db/repo/settings.ts";
import { media } from "../db/schema.ts";
import { uuidv7 } from "../ids.ts";
import { widthsFor } from "../media/process.ts";
import { type MediaStore, shortHash } from "../media/store.ts";
import { parseDoc } from "./doc.ts";
import type { StarterEntry } from "./entries.ts";

// The starting points a site can be set up from: a few pages or a post of example content, and
// the pictures on them, all in the theme's starters folder.

/** A picture that comes with a starting point, ready to go into Media. */
export interface StarterPicture {
  id: string;
  name: string;
  alt: string;
  data: Buffer;
  sha256: string;
  width: number;
  height: number;
  /** Shown while it loads, as for any picture. */
  color: string;
}

export interface StarterContent {
  entries: StarterEntry[];
  pictures: StarterPicture[];
}

interface StarterFile {
  pictures?: Record<
    string,
    { file: string; alt: string; width: number; height: number; color: string }
  >;
  entries: (Omit<StarterEntry, "doc" | "featuredImage"> & {
    doc?: unknown;
    featuredImage?: string;
  })[];
}

/** Where a picture's ID goes once it has one: "{picture:table}". */
const PICTURE = /^\{picture:([a-z-]+)\}$/;

/** A block that shows a picture, and nothing else. */
function pictureIn(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { type, attrs } = value as { type?: unknown; attrs?: { mediaId?: unknown } };
  if (type !== "image" || typeof attrs?.mediaId !== "string") return undefined;
  return attrs.mediaId.match(PICTURE)?.[1];
}

/** Puts pictures' IDs in, and leaves out every block whose picture isn't there. */
function withPictures(value: unknown, ids: ReadonlyMap<string, string>): unknown {
  if (Array.isArray(value)) {
    return value
      .filter((item) => {
        const name = pictureIn(item);
        return name === undefined || ids.has(name);
      })
      .map((item) => withPictures(item, ids));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, withPictures(item, ids)]),
    );
  }
  const name = typeof value === "string" ? value.match(PICTURE)?.[1] : undefined;
  return name === undefined ? value : ids.get(name);
}

/**
 * Reads a starting point's example content from the theme, with the site's name filled in.
 * Without its pictures, when they can't be kept, its pages are the same but for them.
 */
export function loadStarter(input: {
  themeDir: string;
  starter: Starter;
  siteName: string;
  now: number;
  pictures: boolean;
}): StarterContent {
  const folder = join(input.themeDir, "starters");
  const file = readFileSync(join(folder, `${input.starter}.json`), "utf8");
  // Every string in it, wherever it is, with the name put in after it's been read: a name with
  // a quote in it can't change what the file says.
  const read = JSON.parse(file, (_key, value) =>
    // A function, because a plain replacement string gives "$&" and friends special meanings.
    typeof value === "string" ? value.replaceAll("{site}", () => input.siteName) : value,
  ) as StarterFile;

  const pictures = new Map<string, StarterPicture>();
  for (const [name, picture] of input.pictures ? Object.entries(read.pictures ?? {}) : []) {
    const data = readFileSync(join(folder, "pictures", picture.file));
    pictures.set(name, {
      id: uuidv7(input.now),
      name: picture.file,
      alt: picture.alt,
      data,
      sha256: createHash("sha256").update(data).digest("hex"),
      width: picture.width,
      height: picture.height,
      color: picture.color,
    });
  }
  const ids = new Map([...pictures].map(([name, picture]) => [name, picture.id]));
  return {
    pictures: [...pictures.values()],
    entries: read.entries.map(({ doc, featuredImage, ...entry }) => {
      const featured = withPictures(featuredImage, ids);
      return {
        ...entry,
        ...(doc
          ? { doc: parseDoc(withPictures(doc, ids), { allowSections: entry.type === "page" }) }
          : {}),
        ...(typeof featured === "string"
          ? { featuredImage: { mediaId: featured, alt: null } }
          : {}),
      };
    }),
  };
}

/** Keeps their files, all of them or none. False if they couldn't be, a full disk say. */
export function keepPictures(store: MediaStore, pictures: StarterPicture[]): boolean {
  try {
    for (const { id, sha256, data } of pictures) {
      store.write(store.originalPath(id, shortHash(sha256), "jpg"), data);
    }
    return true;
  } catch (error) {
    console.error("The starting point's pictures couldn't be kept, so it has none:", error);
    removePictures(store, pictures);
    return false;
  }
}

/** As far as they can be: what stopped them being kept can stop them being removed too. */
export function removePictures(store: MediaStore, pictures: StarterPicture[]): void {
  for (const { id, sha256 } of pictures) {
    try {
      store.removeOriginal(id, shortHash(sha256), "jpg");
    } catch {
      // A file nothing uses is left behind. The failure that matters is the one before this.
    }
  }
}

/**
 * Puts them in Media, as if the Owner had added them. The sizes visitors get are each made the
 * first time they're asked for, as after a restore, so setup waits for none of them.
 */
export function addStarterPictures(
  db: Pick<Orm, "insert">,
  input: { pictures: StarterPicture[]; uploadedBy: string; now: number },
): void {
  for (const picture of input.pictures) {
    db.insert(media)
      .values({
        id: picture.id,
        kind: "image",
        originalName: picture.name,
        mime: "image/jpeg",
        ext: "jpg",
        sizeBytes: picture.data.length,
        width: picture.width,
        height: picture.height,
        sha256: picture.sha256,
        variants: widthsFor(picture.width, picture.height),
        dominantColor: picture.color,
        alt: picture.alt,
        uploadedBy: input.uploadedBy,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .run();
  }
}
