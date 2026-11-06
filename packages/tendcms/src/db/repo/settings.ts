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

export type Starter = "blog" | "business" | "blank";

export interface SetupSettings {
  /** Which starting content to create once pages and themes exist. */
  starter: Starter;
  completed_at: number;
}

export interface SettingValues {
  site: SiteSettings;
  setup: SetupSettings;
}

export async function getSetting<K extends keyof SettingValues>(
  orm: Orm,
  key: K,
): Promise<SettingValues[K] | undefined> {
  const row = orm.select().from(settings).where(eq(settings.key, key)).get();
  return row?.value as SettingValues[K] | undefined;
}
