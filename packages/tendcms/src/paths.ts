import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The same code runs from src/**/*.ts in development and from dist/cli.mjs once
// built, at different depths, so walk up to the package root instead of using
// fixed relative paths.
function findPackageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath) && JSON.parse(readFileSync(pkgPath, "utf8")).name === "tendcms") {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error("Could not find the tendcms package root");
    dir = parent;
  }
}

export const packageRoot = findPackageRoot();

export const appVersion: string = JSON.parse(
  readFileSync(join(packageRoot, "package.json"), "utf8"),
).version;

export const migrationsDir = join(packageRoot, "migrations");

export const adminDir = join(packageRoot, "dist", "admin");

// Beside the code when built; in the repo's themes folder when running from source, so
// editing a template doesn't need a build.
const runningFromSource = fileURLToPath(import.meta.url).endsWith(".ts");
export const defaultThemeDir = runningFromSource
  ? join(packageRoot, "..", "..", "themes", "meadow")
  : join(packageRoot, "dist", "themes", "meadow");
