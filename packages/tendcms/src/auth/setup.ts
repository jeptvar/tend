import { eq } from "drizzle-orm";
import { textToDoc } from "../content/doc.ts";
import { seedStarterEntries } from "../content/entries.ts";
import { addStarterPictures, type StarterContent } from "../content/starters.ts";
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
  content: StarterContent;
  now: number;
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
      addStarterPictures(tx, {
        pictures: input.content.pictures,
        uploadedBy: userId,
        now: input.now,
      });
      seedStarterEntries(tx, {
        entries: input.content.entries,
        toDoc: textToDoc,
        authorId: userId,
        now: input.now,
      });
    },
    { behavior: "immediate" },
  );
  return userId;
}
