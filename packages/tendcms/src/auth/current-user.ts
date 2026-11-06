import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import type { Orm } from "../db/client.ts";
import { findSessionUser } from "../db/repo/sessions.ts";
import type { User } from "../db/repo/users.ts";

/** __Host- makes browsers refuse a cookie unless it's Secure, host-only and on /. */
export function sessionCookieName(secure: boolean): string {
  return secure ? "__Host-tend_session" : "tend_session";
}

export function deviceCookieName(secure: boolean): string {
  return secure ? "__Host-tend_device" : "tend_device";
}

/** The signed-in person for this request, if there is one. */
export async function currentUser(
  c: Context,
  orm: Orm,
  secureCookies: boolean,
  now: number,
): Promise<User | undefined> {
  const token = getCookie(c, sessionCookieName(secureCookies));
  return token ? findSessionUser(orm, token, now) : undefined;
}
