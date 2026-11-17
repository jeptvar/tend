// Writes packages/tendcms/npm-shrinkwrap.json: the exact version of everything installing
// tendcms installs, so people get the tree that was tested (PLAN.md §12). The release runs it
// before packing, and so does CI's install check. It needs the npm registry.
//
// The trap (PLAN.md §14): npm shrinkwrap run in packages/tendcms writes a lock with only the
// root entry and still exits 0, and workspace:* breaks npm install. So the lock is made from
// a copy of package.json, without its devDependencies and scripts, in a folder of its own.
// Zero dependencies, so it runs the same on every OS.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pkgDir = join(import.meta.dirname, "..", "packages", "tendcms");
// The same wait as the repo's own installs (pnpm's minimumReleaseAge): nothing published in
// the last 7 days is pinned.
const before = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
const scratch = mkdtempSync(join(tmpdir(), "tend-shrinkwrap-"));

function npm(args) {
  // Windows can only run npm.cmd through a shell. These arguments are all written here.
  const windows = process.platform === "win32";
  const result = windows
    ? spawnSync(`npm ${args.join(" ")}`, { cwd: scratch, stdio: "inherit", shell: true })
    : spawnSync("npm", args, { cwd: scratch, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`npm ${args.join(" ")} failed`);
}

try {
  copyFileSync(join(pkgDir, "package.json"), join(scratch, "package.json"));
  npm(["pkg", "delete", "devDependencies", "scripts"]);
  npm([
    "install",
    "--package-lock-only",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    `--before=${before}`,
  ]);
  npm(["shrinkwrap"]);

  const lock = JSON.parse(readFileSync(join(scratch, "npm-shrinkwrap.json"), "utf8"));
  const installed = Object.keys(lock.packages ?? {}).filter((path) => path !== "");
  if (installed.length < 2 || !lock.packages["node_modules/better-sqlite3"]) {
    throw new Error(
      `The shrinkwrap lists ${installed.length} packages and no better-sqlite3: it was made wrong.`,
    );
  }
  writeFileSync(join(pkgDir, "npm-shrinkwrap.json"), `${JSON.stringify(lock, null, 2)}\n`);
  console.log(
    `Wrote packages/tendcms/npm-shrinkwrap.json: ${installed.length} packages, none newer than ${before.slice(0, 10)}.`,
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
