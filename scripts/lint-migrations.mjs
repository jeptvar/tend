// Fails if any migration contains a PRAGMA. See scripts/db-generate.mjs for why.
// Takes the folder as an argument so the check itself can be tested.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const migrationsDir =
  process.argv[2] ?? join(import.meta.dirname, "..", "packages", "tendcms", "migrations");

// Finding nothing to check must fail: if the folder moves, this gate would
// otherwise keep passing while checking nothing.
const files = existsSync(migrationsDir)
  ? readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"))
  : [];
if (files.length === 0) {
  console.error(`No migrations found in ${migrationsDir}.`);
  process.exit(1);
}

const problems = [];
for (const file of files) {
  readFileSync(join(migrationsDir, file), "utf8")
    .split("\n")
    .forEach((line, i) => {
      if (/\bPRAGMA\b/i.test(line)) problems.push(`migrations/${file}:${i + 1}: ${line.trim()}`);
    });
}

if (problems.length > 0) {
  console.error(
    "Migrations must not contain PRAGMA statements (run `pnpm db:generate` to clean them):",
  );
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
