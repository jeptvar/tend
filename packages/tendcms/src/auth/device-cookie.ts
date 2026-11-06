import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const DEVICE_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

function signature(secretKey: Buffer, payload: string): Buffer {
  return createHmac("sha256", secretKey).update(`tend:device:${payload}`).digest();
}

function accountHash(email: string): string {
  return createHmac("sha256", "tend:device-account").update(email).digest("base64url");
}

/** Proof that this browser signed in to this account before (OWASP "device cookies"). */
export function createDeviceCookie(secretKey: Buffer, email: string, now = Date.now()): string {
  const expiresAt = now + DEVICE_COOKIE_MAX_AGE_SECONDS * 1000;
  const payload = `${accountHash(email)}.${expiresAt}.${randomBytes(9).toString("base64url")}`;
  return `${payload}.${signature(secretKey, payload).toString("base64url")}`;
}

export function deviceCookieIsValid(
  secretKey: Buffer,
  cookie: string | undefined,
  email: string,
  now = Date.now(),
): boolean {
  const parts = cookie?.split(".");
  if (parts?.length !== 4) return false;
  const [account, expiresAt, nonce, signed] = parts as [string, string, string, string];
  const expected = signature(secretKey, `${account}.${expiresAt}.${nonce}`);
  const actual = Buffer.from(signed, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
  return account === accountHash(email) && Number(expiresAt) > now;
}
