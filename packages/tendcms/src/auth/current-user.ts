import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Orm } from "../db/client.ts";
import { ABSOLUTE_MS, findSessionUser } from "../db/repo/sessions.ts";
import type { User } from "../db/repo/users.ts";
import { DEVICE_COOKIE_MAX_AGE_SECONDS } from "./device-cookie.ts";

export const SESSION_COOKIE_MAX_AGE_SECONDS = ABSOLUTE_MS / 1000;

/** __Host- makes browsers refuse a cookie unless it's Secure, host-only and on /. */
export function sessionCookieName(secure: boolean): string {
  return secure ? "__Host-tend_session" : "tend_session";
}

export function deviceCookieName(secure: boolean): string {
  return secure ? "__Host-tend_device" : "tend_device";
}

export function cookieOptions(secure: boolean) {
  return { httpOnly: true, sameSite: "Lax", path: "/", secure } as const;
}

/**
 * Keeps whoever just confirmed the site's address signed in, since that can change the
 * cookies' names: a site that turns out to be on https gets ones other sites can't plant.
 */
export function carrySignInOver(c: Context, wasSecure: boolean, isSecure: boolean): void {
  if (wasSecure === isSecure) return;
  for (const [nameOf, maxAge] of [
    [sessionCookieName, SESSION_COOKIE_MAX_AGE_SECONDS],
    [deviceCookieName, DEVICE_COOKIE_MAX_AGE_SECONDS],
  ] as const) {
    const value = getCookie(c, nameOf(wasSecure));
    if (value === undefined) continue;
    setCookie(c, nameOf(isSecure), value, { ...cookieOptions(isSecure), maxAge });
    deleteCookie(c, nameOf(wasSecure), cookieOptions(wasSecure));
  }
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
