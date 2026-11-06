// Wraps `drizzle-kit generate` and removes the PRAGMA lines it writes into SQLite
// table rebuilds. Tend's migration runner turns foreign keys off itself, outside
// the transaction (see PLAN.md §13); a PRAGMA inside a migration would do nothing
// or, worse, hide a cascade.
//
// Usage: pnpm db:generate <name>
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const name = process.argv[2];
if (!name || !/^[a-z0-9_]+$/.test(name)) {
  console.error("Usage: pnpm db:generate <name>   (lowercase letters, digits and _ only)");
  process.exit(1);
}

const pkgDir = join(import.meta.dirname, "..", "packages", "tendcms");
const result = spawnSync("pnpm", ["exec", "drizzle-kit", "generate", "--name", name], {
  cwd: pkgDir,
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (result.status !== 0) process.exit(result.status ?? 1);

const migrationsDir = join(pkgDir, "migrations");
for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"))) {
  const path = join(migrationsDir, file);
  const before = readFileSync(path, "utf8");
  const after = before
    .split("\n")
    .filter((line) => !/^\s*PRAGMA\b/i.test(line))
    .join("\n");
  if (after !== before) {
    writeFileSync(path, after);
    console.log(`Removed PRAGMA lines from migrations/${file}`);
  }
}

const lint = spawnSync(process.execPath, [join(import.meta.dirname, "lint-migrations.mjs")], {
  stdio: "inherit",
});
process.exit(lint.status ?? 1);
