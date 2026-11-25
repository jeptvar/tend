import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// A Private site's pictures are only sent to someone who's signed in. A preview in the admin is in
// a frame that's shut off from everything, as if it were another site's, so the browser sends no
// cookie with what it asks for. Each picture in a preview has a key in its address instead, which
// opens that picture and nothing else, for an hour or two.

const HOUR_MS = 60 * 60 * 1000;
const ADDRESS = /\/media\/([0-9a-f-]{36})\/[0-9a-f]+\/[^"'\s,?&<>()]+/g;
const KEY = /^(\d{1,15})-([0-9a-f]{32})$/;

export interface PictureKeys {
  /** A page with a key in the address of each of its pictures. */
  addTo(html: string, now: number): string;
  /** Whether this key is for this picture, and still works. */
  opens(key: string | undefined, id: string, now: number): boolean;
}

export function createPictureKeys(): PictureKeys {
  // New each time Tend starts. A preview that's still open then is only missing its pictures.
  const secret = randomBytes(32);
  const sign = (id: string, until: number) =>
    createHmac("sha256", secret).update(`${id} ${until}`).digest("hex").slice(0, 32);
  return {
    addTo(html, now) {
      // To the hour, so a picture's address stays the same for a while and is only fetched once.
      const until = (Math.floor(now / HOUR_MS) + 2) * HOUR_MS;
      return html.replace(ADDRESS, (address, id) => `${address}?key=${until}-${sign(id, until)}`);
    },
    opens(key, id, now) {
      const [, until, signed] = key?.match(KEY) ?? [];
      if (!until || !signed || Number(until) <= now) return false;
      return timingSafeEqual(Buffer.from(signed), Buffer.from(sign(id, Number(until))));
    },
  };
}
