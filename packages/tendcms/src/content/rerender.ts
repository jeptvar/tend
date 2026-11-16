import { and, asc, eq, gt, isNotNull } from "drizzle-orm";
import type { Orm } from "../db/client.ts";
import { revisions, schemaMeta } from "../db/schema.ts";
import type { EntryData } from "./doc.ts";
import { RENDER_VERSION, renderDoc } from "./render-doc.ts";

const KEY = "render_version";
const BATCH_SIZE = 100;

/** The renderer the stored HTML came from. Sites from before this was kept count as 0. */
function storedVersion(orm: Orm): number {
  const row = orm
    .select({ value: schemaMeta.value })
    .from(schemaMeta)
    .where(eq(schemaMeta.key, KEY))
    .get();
  return row ? Number(row.value) : 0;
}

export interface RerenderResult {
  /** Published versions rendered again. */
  rendered: number;
  /** Ones that couldn't be, which keep the HTML they had. */
  failed: number;
}

/**
 * Renders the HTML stored with every published version again, when this Tend's renderer
 * isn't the one it came from (RENDER_VERSION). Every published version, not only the live
 * ones, because Undo after Unpublish can put an older one back on the site.
 *
 * It runs when Tend starts, before it answers anyone, so no page made by the old renderer
 * can be stored in the page cache meanwhile. The version is written only once every one is
 * done: if Tend stops partway, each page still has HTML it can show, and the next start does
 * them all again. One that can't be rendered keeps the HTML it has rather than keeping the
 * site from starting.
 */
export async function rerenderPublished(
  orm: Orm,
  options: { batchSize?: number; afterBatch?: () => void } = {},
): Promise<RerenderResult> {
  const result: RerenderResult = { rendered: 0, failed: 0 };
  if (storedVersion(orm) === RENDER_VERSION) return result;
  const size = options.batchSize ?? BATCH_SIZE;
  let after = "";
  for (;;) {
    const batch = orm
      .select({ id: revisions.id, data: revisions.data })
      .from(revisions)
      .where(and(isNotNull(revisions.html), gt(revisions.id, after)))
      .orderBy(asc(revisions.id))
      .limit(size)
      .all();
    const last = batch.at(-1);
    if (!last) break;
    orm.transaction(
      (tx) => {
        for (const row of batch) {
          let rendered: { html: string; text: string };
          try {
            rendered = renderDoc((row.data as EntryData).doc);
          } catch {
            result.failed++;
            continue;
          }
          tx.update(revisions).set(rendered).where(eq(revisions.id, row.id)).run();
          result.rendered++;
        }
      },
      { behavior: "immediate" },
    );
    after = last.id;
    options.afterBatch?.();
    // Lets anything else waiting have a turn, Ctrl+C included, on a site with a lot of them.
    await new Promise((resolve) => setImmediate(resolve));
  }
  orm
    .insert(schemaMeta)
    .values({ key: KEY, value: String(RENDER_VERSION) })
    .onConflictDoUpdate({ target: schemaMeta.key, set: { value: String(RENDER_VERSION) } })
    .run();
  return result;
}
