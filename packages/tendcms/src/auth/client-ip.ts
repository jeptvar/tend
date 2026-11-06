import { isIP, isIPv6 } from "node:net";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";

function socketAddress(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    return undefined;
  }
}

function plainAddress(address: string): string {
  const withoutZone = address.split("%")[0] ?? address;
  const mapped = withoutZone.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  return mapped?.[1] ?? withoutZone;
}

/**
 * The visitor's address. `trustProxy` is how many proxies Tend sits behind: the
 * address that many hops from the right of X-Forwarded-For is the one the outermost
 * trusted proxy saw. Anything further left was written by the client, so it's ignored.
 */
export function clientIp(c: Context, trustProxy: number): string {
  if (trustProxy > 0) {
    const hops = (c.req.header("x-forwarded-for") ?? "").split(",").map((hop) => hop.trim());
    const candidate = hops[hops.length - trustProxy];
    if (candidate && isIP(plainAddress(candidate))) return plainAddress(candidate);
  }
  return plainAddress(socketAddress(c) ?? "unknown");
}

function ipv6Prefix64(address: string): string {
  const [head = "", tail = ""] = address.split("::");
  const headGroups = head ? head.split(":") : [];
  const tailGroups = tail ? tail.split(":") : [];
  const missing = 8 - headGroups.length - tailGroups.length;
  const groups = [...headGroups, ...Array.from({ length: missing }, () => "0"), ...tailGroups];
  return `${groups.slice(0, 4).join(":")}::/64`;
}

/** One rate-limit bucket per IPv4 address or per IPv6 /64, which is what one customer gets. */
export function rateLimitKey(ip: string): string {
  return isIPv6(ip) ? ipv6Prefix64(ip) : ip;
}

/**
 * A coarser bucket for IPv6, because one customer's allocation is usually a /48: that's
 * 65,536 /64s, each of which would otherwise get a full allowance of its own.
 */
export function networkKey(ip: string): string | undefined {
  return isIPv6(ip) ? ipv6Prefix64(ip).split(":").slice(0, 3).join(":") : undefined;
}

/** What's stored with a session: deliberately too coarse to identify anyone. */
export function storedIpPrefix(ip: string): string | null {
  if (isIPv6(ip)) return ipv6Prefix64(ip);
  const octets = ip.split(".");
  return octets.length === 4 ? `${octets.slice(0, 3).join(".")}.0/24` : null;
}
