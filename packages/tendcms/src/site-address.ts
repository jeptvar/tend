import { BlockList, isIP, isIPv4 } from "node:net";
import { eq } from "drizzle-orm";
import type { Orm } from "./db/client.ts";
import type { SiteSettings } from "./db/repo/settings.ts";
import { settings } from "./db/schema.ts";

// The address a site goes by (PLAN.md J10, J11 and §12).

/** Who says what the address is. "confirmed" is an Admin, on Overview or in Settings. */
export type AddressSource = "set" | "confirmed" | "platform";

/** Names that only mean something on one network, or nothing at all (RFC 6761, 6762, 8375). */
const PRIVATE_NAMES =
  /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|private|home\.arpa|test|invalid|example)$/;

const PRIVATE_RANGES = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
] as const) {
  PRIVATE_RANGES.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 127],
  ["fc00::", 7],
  ["fe80::", 10],
] as const) {
  PRIVATE_RANGES.addSubnet(network, prefix, "ipv6");
}

/**
 * Whether people anywhere could reach this address, as far as its name says. One that only
 * works on this computer or this network isn't public, so nothing at it is live (P15).
 */
export function isPublicAddress(url: string): boolean {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(host)) return !PRIVATE_RANGES.check(host, isIPv4(host) ? "ipv4" : "ipv6");
  return host.includes(".") && !PRIVATE_NAMES.test(host);
}

/** Addresses hosting platforms give out, which people swap for a domain of their own. */
const FROM_A_HOST = /\.(railway\.app|onrender\.com|fly\.dev)$/;

export function isHostingAddress(url: string): boolean {
  return FROM_A_HOST.test(new URL(url).hostname.toLowerCase());
}

/**
 * What this site's own address is, if that's known. In this order: TEND_PUBLIC_URL, which is
 * for whoever runs the server to say; the one an Admin said is the site's; and the one the
 * hosting platform gave it. A site on someone's own computer has none of these, and neither
 * has a plain Docker run until someone answers Overview's question.
 */
export class SiteAddress {
  readonly #orm: Orm;
  readonly #publicUrl: string | undefined;
  readonly #platformUrl: string | undefined;
  readonly #secureCookies: boolean;
  #confirmed: string | null | undefined;

  constructor(
    orm: Orm,
    known: {
      publicUrl?: string | undefined;
      platformUrl?: string | undefined;
      /** Whether it's https until an address is confirmed: from TEND_PUBLIC_URL or the platform. */
      secureCookies: boolean;
    },
  ) {
    this.#orm = orm;
    this.#publicUrl = known.publicUrl;
    this.#platformUrl = known.platformUrl;
    this.#secureCookies = known.secureCookies;
  }

  get url(): string | undefined {
    return this.#publicUrl ?? this.#confirmedUrl() ?? this.#platformUrl;
  }

  get source(): AddressSource | null {
    if (this.#publicUrl) return "set";
    if (this.#confirmedUrl()) return "confirmed";
    return this.#platformUrl ? "platform" : null;
  }

  /** TEND_PUBLIC_URL, which nothing in the admin can change. */
  get setUrl(): string | undefined {
    return this.#publicUrl;
  }

  /** Whether people anywhere can reach it, so that "live" is a true thing to say. */
  get isPublic(): boolean {
    const { url } = this;
    return url !== undefined && isPublicAddress(url);
  }

  /**
   * Whether the site is reached over https, which decides the cookies and HSTS. It follows the
   * address, never what a request says about itself, which a client could make up.
   */
  get secure(): boolean {
    const confirmed = this.#publicUrl ? null : this.#confirmedUrl();
    return confirmed ? confirmed.startsWith("https:") : this.#secureCookies;
  }

  /** After anything that may have changed it. */
  refresh(): void {
    this.#confirmed = undefined;
  }

  #confirmedUrl(): string | null {
    if (this.#confirmed === undefined) {
      const row = this.#orm
        .select({ value: settings.value })
        .from(settings)
        .where(eq(settings.key, "site"))
        .get();
      const site = row?.value as SiteSettings | undefined;
      this.#confirmed =
        site?.address_confirmed && site.address ? site.address.replace(/\/+$/, "") : null;
    }
    return this.#confirmed;
  }
}
