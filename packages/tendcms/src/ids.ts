import { randomBytes } from "node:crypto";

/** UUIDv7: random, but sorts by creation time, which keeps database indexes compact. */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(now, 0, 6);
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x70, 6);
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = bytes.toString("hex");
  return dashed(hex);
}

/** Sorts before every id made at this time or later, and after every one made before it. */
export function firstIdAt(at: number): string {
  const bytes = Buffer.alloc(16);
  bytes.writeUIntBE(Math.max(0, at), 0, 6);
  return dashed(bytes.toString("hex"));
}

function dashed(hex: string): string {
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}
