import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { parseDoc, textToDoc } from "../content/doc.ts";
import { type StarterEntry, seedStarterEntries } from "../content/entries.ts";
import type { Orm } from "../db/client.ts";
import type { SetupSettings, SiteSettings, Starter } from "../db/repo/settings.ts";
import { settings, users } from "../db/schema.ts";
import { uuidv7 } from "../ids.ts";

/** Setup closes for good once an Owner exists. */
export class SetupClosedError extends Error {}

export interface CompleteSetupInput {
  site: { name: string; tagline: string; locale: string; timezone: string };
  owner: { name: string; email: string; passwordHash: string };
  starter: Starter;
  starterEntries: StarterEntry[];
  now: number;
}

/** Reads a starting point's example content from the theme, with the site's name filled in. */
export function loadStarter(themeDir: string, starter: Starter, siteName: string): StarterEntry[] {
  const file = readFileSync(join(themeDir, "starters", `${starter}.json`), "utf8");
  // Every string in it, wherever it is, with the name put in after it's been read: a name with
  // a quote in it can't change what the file says.
  const { entries } = JSON.parse(file, (_key, value) =>
    // A function, because a plain replacement string gives "$&" and friends special meanings.
    typeof value === "string" ? value.replaceAll("{site}", () => siteName) : value,
  ) as { entries: StarterEntry[] };
  return entries.map((entry) =>
    entry.doc
      ? { ...entry, doc: parseDoc(entry.doc, { allowSections: entry.type === "page" }) }
      : entry,
  );
}

/** Creates the Owner, the site's settings and its first content together: all of it or none. */
export function completeSetup(orm: Orm, input: CompleteSetupInput): string {
  const userId = uuidv7(input.now);
  const site: SiteSettings = {
    ...input.site,
    address: null,
    address_confirmed: false,
  };
  const setup: SetupSettings = { starter: input.starter, completed_at: input.now };

  // BEGIN IMMEDIATE takes the write lock first, so two people finishing setup at the
  // same moment can't both see "no Owner yet".
  orm.transaction(
    (tx) => {
      if (tx.select({ id: users.id }).from(users).where(eq(users.isOwner, 1)).get()) {
        throw new SetupClosedError();
      }
      tx.insert(users)
        .values({
          id: userId,
          email: input.owner.email,
          name: input.owner.name,
          role: "admin",
          isOwner: 1,
          passwordHash: input.owner.passwordHash,
          locale: input.site.locale,
          createdAt: input.now,
          lastSeenAt: input.now,
        })
        .run();
      tx.insert(settings)
        .values([
          { key: "site", value: site, updatedAt: input.now, updatedBy: userId },
          { key: "setup", value: setup, updatedAt: input.now, updatedBy: userId },
        ])
        .run();
      seedStarterEntries(tx, {
        entries: input.starterEntries,
        toDoc: textToDoc,
        authorId: userId,
        now: input.now,
      });
    },
    { behavior: "immediate" },
  );
  return userId;
}
