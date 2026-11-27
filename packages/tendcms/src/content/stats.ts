import { z } from "zod";

// Settings → Visitor stats (PLAN.md v0.2): a service that counts visitors without cookies, set
// up by pasting what it gives a site. Each is checked here, because it goes into a script tag
// on every page. There's no Google Analytics: it needs a cookie banner, which Tend doesn't make.

export const STATS_SERVICES = ["plausible", "fathom", "umami", "cloudflare"] as const;
export type StatsService = (typeof STATS_SERVICES)[number];

/** Where Umami Cloud keeps its script. Umami on a server of someone's own has its own. */
export const UMAMI_CLOUD_SCRIPT = "https://cloud.umami.is/script.js";

const DOMAIN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface Rule {
  /** Finds it in the whole snippet, for whoever pastes that instead. */
  inSnippet: RegExp;
  tidy: (pasted: string) => string;
  valid: RegExp;
  message: string;
}

const RULES: Record<StatsService, Rule> = {
  plausible: {
    inSnippet: /data-domain\s*=\s*["']([^"']*)["']/i,
    // The domain as it was added to Plausible: no https://, and nothing after it.
    tidy: (pasted) =>
      pasted
        .replace(/^https?:\/\//i, "")
        .replace(/[/?#].*$/, "")
        .toLowerCase(),
    valid: DOMAIN,
    message: "Type the domain you added to Plausible, like rise-bakery.com.",
  },
  fathom: {
    inSnippet: /data-site\s*=\s*["']([^"']*)["']/i,
    tidy: (pasted) => pasted,
    valid: /^[A-Za-z0-9]{4,16}$/,
    message: "Type the Site ID from Fathom, like ABCDEFGH.",
  },
  umami: {
    inSnippet: /data-website-id\s*=\s*["']([^"']*)["']/i,
    tidy: (pasted) => pasted.toLowerCase(),
    valid: UUID,
    message: "Type the website ID from Umami. It looks like 94db1cb1-74f4-4a40-ad6c-962362670409.",
  },
  cloudflare: {
    inSnippet: /["']?token["']?\s*:\s*["']([^"']*)["']/i,
    tidy: (pasted) => pasted.toLowerCase(),
    valid: /^[0-9a-f]{32}$/,
    message:
      'Type the token from Cloudflare: the 32 letters and numbers after "token" in its snippet.',
  },
};

/** An Umami of someone's own: its script, on https, as the browser will ask for it. */
function ownScript(pasted: string | null): string | null | undefined {
  if (pasted === null) return null;
  try {
    const url = new URL(pasted);
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    return url.toString() === UMAMI_CLOUD_SCRIPT ? null : url.toString();
  } catch {
    return undefined;
  }
}

const trimmedOrNull = (limit: number) =>
  z
    .string()
    .max(limit, "That's too long: paste only the ID, or the snippet the service gave you.")
    .nullable()
    .transform((value) => (value === null || value.trim() === "" ? null : value.trim()));

export const statsSchema = z
  .object({
    service: z.enum(STATS_SERVICES, { error: "Choose a service from the list." }).nullable(),
    /** What the service gave the site, or the whole snippet it's in. */
    id: trimmedOrNull(4000),
    /** Umami on a server of someone's own: where its script is. Null is Umami Cloud. */
    script: trimmedOrNull(2048),
  })
  .transform((value, context) => {
    const { service } = value;
    if (service === null) return { service: null, id: null, script: null };
    const rule = RULES[service];
    const pasted = value.id ?? "";
    const id = rule.tidy(rule.inSnippet.exec(pasted)?.[1]?.trim() ?? pasted);
    if (!rule.valid.test(id)) {
      context.addIssue({ code: "custom", path: ["id"], message: rule.message });
      return z.NEVER;
    }
    if (service !== "umami") return { service, id, script: null };
    // A snippet pasted whole says where the script is too.
    const src = /\bsrc\s*=\s*["']([^"']*)["']/i.exec(pasted)?.[1] ?? null;
    const script = ownScript(value.script ?? src);
    if (script === undefined) {
      context.addIssue({
        code: "custom",
        path: ["script"],
        message: "Type the address of your Umami's script, starting https://, or leave it empty.",
      });
      return z.NEVER;
    }
    return { service, id, script };
  });
export type StatsSettings = z.output<typeof statsSchema>;
