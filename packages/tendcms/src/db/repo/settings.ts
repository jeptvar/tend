import { eq } from "drizzle-orm";
import type { Orm } from "../client.ts";
import { settings } from "../schema.ts";

export interface SiteSettings {
  name: string;
  tagline: string;
  /** Null until the site goes online and its address is confirmed. */
  address: string | null;
  address_confirmed: boolean;
  locale: string;
  timezone: string;
}

export type Starter = "blog" | "business" | "portfolio" | "blank";

export interface SetupSettings {
  /** Which starting content to create once pages and themes exist. */
  starter: Starter;
  completed_at: number;
}

/** When a backup was last downloaded, for the monthly reminder on Overview. */
export interface BackupSettings {
  last_download_at: number;
}

export interface SettingValues {
  site: SiteSettings;
  setup: SetupSettings;
  backups: BackupSettings;
}

/** Saves something Tend keeps track of, which isn't anyone's change to undo. */
export function putSetting<K extends keyof SettingValues>(
  orm: Orm,
  key: K,
  value: SettingValues[K],
  now: number,
  userId: string | null,
): void {
  orm
    .insert(settings)
    .values({ key, value, updatedAt: now, updatedBy: userId })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now, updatedBy: userId } })
    .run();
}

export async function getSetting<K extends keyof SettingValues>(
  orm: Orm,
  key: K,
): Promise<SettingValues[K] | undefined> {
  const row = orm.select().from(settings).where(eq(settings.key, key)).get();
  return row?.value as SettingValues[K] | undefined;
}
