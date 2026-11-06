import { join } from "node:path";
import { expect, test } from "vitest";
import { openDatabase } from "../src/db/client.ts";
import { tempDir } from "./helpers.ts";

test("every connection gets the pragmas from PLAN.md §11", () => {
  const db = openDatabase(join(tempDir(), "t.db"));
  try {
    const value = (name: string) => db.pragma(name, { simple: true });
    expect(value("journal_mode")).toBe("wal");
    expect(value("synchronous")).toBe(1); // NORMAL
    expect(value("temp_store")).toBe(2); // MEMORY
    expect(value("trusted_schema")).toBe(0);
    expect(value("foreign_keys")).toBe(1);
    expect(value("busy_timeout")).toBe(5000);
  } finally {
    db.close();
  }
});
