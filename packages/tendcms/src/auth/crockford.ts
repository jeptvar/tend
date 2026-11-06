import { randomBytes } from "node:crypto";

// Crockford base32: no I, L, O or U, so codes survive being read aloud or retyped.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Turns bytes into Crockford characters, using the low 5 bits of each byte. */
export function encodeCrockford(bytes: Uint8Array, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET.charAt((bytes[i] ?? 0) & 0x1f);
  return out;
}

export function randomCrockford(length: number): string {
  return encodeCrockford(randomBytes(length), length);
}

/** Forgives the usual retyping slips: case, spaces, dashes, and I, L or O for 1 or 0. */
export function normalizeCrockford(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");
}
