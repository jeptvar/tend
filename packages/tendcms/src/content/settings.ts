import { desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { ApiError } from "../api/errors.ts";
import type { Orm } from "../db/client.ts";
import type { SiteSettings } from "../db/repo/settings.ts";
import { settings, settingsHistory } from "../db/schema.ts";
import { uuidv7 } from "../ids.ts";

// Site-wide settings (PLAN.md §8): each is one row, with the last 20 versions kept for Undo.

const HISTORY_KEPT = 20;

/** A language tag JavaScript can use: one that only looks right would make every date fail. */
export function isLocale(value: string): boolean {
  try {
    return Intl.getCanonicalLocales(value).length === 1;
  } catch {
    return false;
  }
}
const MEDIA_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const blankIsNull = (limit: number, message: string) =>
  z
    .string()
    .max(limit, message)
    .nullable()
    .transform((value) => (value === null || value.trim() === "" ? null : value.trim()));

const webAddress = z
  .string()
  .max(2048, "That address is too long.")
  .nullable()
  .transform((value, context) => {
    const trimmed = value?.trim() ?? "";
    if (trimmed === "") return null;
    const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
    try {
      const url = new URL(withScheme);
      if (url.protocol === "https:" || url.protocol === "http:") return url.toString();
    } catch {}
    context.addIssue({
      code: "custom",
      message: "That doesn't look like a web address. Try https://example.com.",
    });
    return z.NEVER;
  });

const mediaId = z
  .string()
  .nullable()
  .transform((value) => (value && MEDIA_ID.test(value) ? value : null));

export const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const hoursSchema = z
  .array(
    z
      .object({
        day: z.enum(DAYS),
        closed: z.boolean(),
        opens: z.string().max(5),
        closes: z.string().max(5),
      })
      .transform((day, context) => {
        if (TIME.test(day.opens) && TIME.test(day.closes)) return day;
        // Nobody sees a closed day's times, so one left empty is no reason to refuse the rest.
        if (day.closed) return { ...day, opens: "09:00", closes: "17:00" };
        context.addIssue({
          code: "custom",
          message: "Give each open day a time it opens and a time it closes, like 09:00 and 17:30.",
        });
        return z.NEVER;
      }),
  )
  .length(7, "Every day of the week needs a row, Monday first.")
  .refine(
    (days) => days.every((entry, index) => entry.day === DAYS[index]),
    "Every day of the week, Monday first.",
  )
  .nullable();

export const businessSchema = z.object({
  address: blankIsNull(500, "Use 500 characters or fewer for the address."),
  phone: blankIsNull(40, "That phone number is too long.").refine(
    (value) => value === null || /\d/.test(value),
    "A phone number needs some digits.",
  ),
  email: blankIsNull(200, "That email address is too long.").refine(
    (value) => value === null || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
    "That doesn't look like an email address.",
  ),
  mapUrl: webAddress,
  hours: hoursSchema,
  hoursNote: blankIsNull(300, "Use 300 characters or fewer for the note."),
});
export type BusinessSettings = z.output<typeof businessSchema>;

export const visibilitySchema = z.object({
  mode: z.enum(["public", "coming_soon", "private"], { error: "Choose who can see the site." }),
});
export type VisibilitySettings = z.output<typeof visibilitySchema>;

export const seoSchema = z.object({
  description: blankIsNull(400, "Use 400 characters or fewer for the description."),
  imageId: mediaId,
});
export type SeoSettings = z.output<typeof seoSchema>;

export const codeSchema = z.object({
  head: blankIsNull(50_000, "That's too much code: keep it under 50,000 characters."),
  bodyEnd: blankIsNull(50_000, "That's too much code: keep it under 50,000 characters."),
});
export type CodeSettings = z.output<typeof codeSchema>;

export const generalSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Give your site a name.")
    .max(100, "Use 100 characters or fewer for the name."),
  tagline: z.string().trim().max(200, "Use 200 characters or fewer for the tagline."),
  locale: z
    .string()
    .max(64, "Choose a language from the list.")
    .refine(isLocale, "Choose a language from the list.")
    .transform((value) => Intl.getCanonicalLocales(value)[0] as string),
  timezone: z
    .string()
    .max(64, "Choose a time zone from the list.")
    .refine((zone) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: zone });
        return true;
      } catch {
        return false;
      }
    }, "Choose a time zone from the list."),
});

export const SOCIAL_NETWORKS = [
  "instagram",
  "facebook",
  "tiktok",
  "youtube",
  "x",
  "linkedin",
  "pinterest",
  "threads",
  "bluesky",
  "mastodon",
  "whatsapp",
  "other",
] as const;

export const designSchema = z.object({
  logoId: mediaId,
  /** Null makes one from the logo. */
  iconId: mediaId,
  footerText: blankIsNull(500, "Use 500 characters or fewer for the footer."),
  social: z
    .array(z.object({ network: z.enum(SOCIAL_NETWORKS), url: webAddress }))
    .max(12, "Use 12 links or fewer.")
    .transform((links) =>
      links.flatMap((link) => (link.url ? [{ network: link.network, url: link.url }] : [])),
    ),
  customCss: blankIsNull(100_000, "That's too much CSS: keep it under 100,000 characters."),
  /** The theme of someone's own the site uses. Null is the one Tend comes with. */
  themeId: z.string().max(64).nullable().default(null),
  /** Each theme's own choices, checked against the chosen one's theme.json when saved. */
  theme: z
    .record(z.string().regex(/^[a-z][a-z0-9_]{0,31}$/), z.string().max(200))
    .refine((choices) => Object.keys(choices).length <= 200, "That's too many design choices."),
});
export type DesignSettings = z.output<typeof designSchema>;

const menuTarget = z.discriminatedUnion("type", [
  z.object({ type: z.literal("entry"), id: z.string().max(64) }),
  z.object({ type: z.literal("tag"), id: z.string().max(64) }),
  z.object({ type: z.literal("blog") }),
  z.object({ type: z.literal("home") }),
  z.object({
    type: z.literal("url"),
    url: z
      .string()
      .max(2048, "That address is too long.")
      .refine((url) => {
        if (url.startsWith("/") && !url.startsWith("//")) return true;
        try {
          return ["http:", "https:", "mailto:", "tel:"].includes(new URL(url).protocol);
        } catch {
          return false;
        }
      }, "That doesn't look like an address. Try https://example.com, or pick one of your pages."),
  }),
]);

const menuLeaf = z.object({
  id: z.string().max(64),
  label: blankIsNull(80, "Use 80 characters or fewer for a menu link."),
  target: menuTarget,
});

export const menuSchema = z.object({
  items: z
    .array(
      menuLeaf.extend({
        children: z
          .array(menuLeaf)
          .max(30, "Use 30 links or fewer under one link. Move some back to the top level.")
          .default([]),
      }),
    )
    .max(30, "Use 30 links or fewer in a menu."),
});
export type MenuSettings = z.output<typeof menuSchema>;
export type MenuItem = MenuSettings["items"][number];

export interface SettingTypes {
  site: SiteSettings;
  business: BusinessSettings;
  visibility: VisibilitySettings;
  seo: SeoSettings;
  design: DesignSettings;
  "menu:main": MenuSettings;
  "menu:footer": MenuSettings;
  code_injection: CodeSettings;
}
export type SettingKey = keyof SettingTypes;

export const DEFAULTS: { [K in Exclude<SettingKey, "site">]: SettingTypes[K] } = {
  business: { address: null, phone: null, email: null, mapUrl: null, hours: null, hoursNote: null },
  visibility: { mode: "public" },
  seo: { description: null, imageId: null },
  design: {
    logoId: null,
    iconId: null,
    footerText: null,
    social: [],
    customCss: null,
    themeId: null,
    theme: {},
  },
  "menu:main": { items: [] },
  "menu:footer": { items: [] },
  code_injection: { head: null, bodyEnd: null },
};

export interface StoredSetting<T> {
  value: T;
  updatedAt: number | null;
  /**
   * The newest change that can be undone, named by the version it would bring back. Undo
   * has to name it, so it can never undo a different change than the one it was offered for.
   */
  undoId: string | null;
  canUndo: boolean;
}

/** The newest kept version of a setting, which is what Undo would bring back. */
function newestVersion(db: Pick<Orm, "select">, key: SettingKey) {
  return db
    .select()
    .from(settingsHistory)
    .where(eq(settingsHistory.key, key))
    .orderBy(desc(settingsHistory.createdAt), desc(settingsHistory.id))
    .limit(1)
    .get();
}

export async function readSetting<K extends SettingKey>(
  orm: Orm,
  key: K,
): Promise<StoredSetting<SettingTypes[K]> | undefined> {
  const row = orm.select().from(settings).where(eq(settings.key, key)).get();
  if (!row) return undefined;
  const undoId = newestVersion(orm, key)?.id ?? null;
  return {
    value: row.value as SettingTypes[K],
    updatedAt: row.updatedAt,
    undoId,
    canUndo: undoId !== null,
  };
}

/** The value, or what a site that never changed it has. */
export async function settingValue<K extends Exclude<SettingKey, "site">>(
  orm: Orm,
  key: K,
): Promise<SettingTypes[K]> {
  const row = orm
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, key))
    .get();
  const fallback = DEFAULTS[key] as SettingTypes[K];
  return row ? ({ ...fallback, ...(row.value as object) } as SettingTypes[K]) : fallback;
}

/** Whether a site has its own menu yet, rather than the automatic one. */
export async function hasSetting(orm: Orm, key: SettingKey): Promise<boolean> {
  return (
    orm.select({ key: settings.key }).from(settings).where(eq(settings.key, key)).get() !==
    undefined
  );
}

/**
 * Saves a new value, keeping the one it replaces for Undo. Saving what's there already
 * changes nothing, keeps nothing, and says so, so nobody is offered an Undo that would
 * take back an earlier, different change.
 */
export async function writeSetting<K extends SettingKey>(
  orm: Orm,
  input: { key: K; value: SettingTypes[K]; userId: string | null; now: number },
): Promise<StoredSetting<SettingTypes[K]> & { saved: boolean }> {
  const saved = orm.transaction(
    (tx) => {
      const current = tx.select().from(settings).where(eq(settings.key, input.key)).get();
      if (current && JSON.stringify(current.value) === JSON.stringify(input.value)) return false;
      // What it was before, for Undo. Null means it had never been set: undoing the first
      // save goes back to the automatic menu, or the theme's own design.
      tx.insert(settingsHistory)
        .values({
          id: uuidv7(input.now),
          key: input.key,
          value: current ? current.value : null,
          createdAt: input.now,
          userId: current?.updatedBy ?? null,
        })
        .run();
      // Never more than a few over, since this runs on every save.
      const old = tx
        .select({ id: settingsHistory.id })
        .from(settingsHistory)
        .where(eq(settingsHistory.key, input.key))
        .orderBy(desc(settingsHistory.createdAt), desc(settingsHistory.id))
        .all()
        .slice(HISTORY_KEPT);
      if (old.length > 0) {
        tx.delete(settingsHistory)
          .where(
            inArray(
              settingsHistory.id,
              old.map((row) => row.id),
            ),
          )
          .run();
      }
      tx.insert(settings)
        .values({
          key: input.key,
          value: input.value,
          updatedAt: input.now,
          updatedBy: input.userId,
        })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value: input.value, updatedAt: input.now, updatedBy: input.userId },
        })
        .run();
      return true;
    },
    { behavior: "immediate" },
  );
  const stored = (await readSetting(orm, input.key)) as StoredSetting<SettingTypes[K]>;
  return { ...stored, saved };
}

/**
 * Brings back the version before the newest change. Only that change can be undone, and
 * only by naming it: if anything was saved since, this says so and changes nothing.
 */
export async function undoSetting<K extends SettingKey>(
  orm: Orm,
  input: { key: K; undoId: string; userId: string | null; now: number },
): Promise<StoredSetting<SettingTypes[K]> | undefined> {
  orm.transaction(
    (tx) => {
      const previous = newestVersion(tx, input.key);
      if (!previous) {
        throw new ApiError(409, "nothing_to_undo", "There's no earlier version to go back to.", {
          fix: "Change it by hand instead.",
        });
      }
      if (previous.id !== input.undoId) {
        throw new ApiError(
          409,
          "changed_since",
          "This was changed again since, so undoing now would take back a different change.",
          { fix: "Change it back by hand." },
        );
      }
      if (previous.value === null) {
        tx.delete(settings).where(eq(settings.key, input.key)).run();
      } else {
        tx.update(settings)
          .set({ value: previous.value, updatedAt: input.now, updatedBy: input.userId })
          .where(eq(settings.key, input.key))
          .run();
      }
      tx.delete(settingsHistory).where(eq(settingsHistory.id, previous.id)).run();
    },
    { behavior: "immediate" },
  );
  return readSetting(orm, input.key);
}
