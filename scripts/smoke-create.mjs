// The install smoke test (PLAN.md §14): `npm create tend`, the way a person runs it, from the
// packages as they'd be published. create-tend makes a site, npm installs the packed tendcms
// with its shrinkwrap and no install scripts, and the site boots to its setup screen.
// Run after pnpm build, and after scripts/shrinkwrap.mjs as the release does. It needs the
// npm registry. Zero dependencies, so it runs the same on every OS.
//
// After a release, `node scripts/smoke-create.mjs --published 0.1.0` does the same with what's
// on npm by then, and needs no build.
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { check, checkMade, checkStarts, installedPackages, npm, pack } from "./installing.mjs";

const root = join(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "tend-create-"));

// PLAN.md §11. npm takes far longer to write files on GitHub's Windows runners than anywhere.
const TARBALL_BYTES = 5 * 1024 * 1024;
const MOST_PACKAGES = 15;
const CREATE_SECONDS = process.platform === "win32" ? 180 : 60;
/** A version just published isn't everywhere on npm at once. */
const PUBLISH_TRIES = 10;
const PUBLISH_WAIT_MS = 30_000;

const { published } = parseArgs({ options: { published: { type: "string" } } }).values;

async function untilPublished(version) {
  for (let tries = 1; ; tries++) {
    try {
      for (const name of ["tendcms", "create-tend"]) {
        npm(["view", `${name}@${version}`, "version", "--prefer-online"], { cwd: work });
      }
      return;
    } catch (error) {
      if (tries === PUBLISH_TRIES) throw error;
      await new Promise((resolve) => setTimeout(resolve, PUBLISH_WAIT_MS));
    }
  }
}

try {
  let creating;
  if (published) {
    await untilPublished(published);
    creating = Date.now();
    npm(["create", "--yes", `tend@${published}`, "my-site", "--", "--no-start"], {
      cwd: work,
      stdio: ["ignore", "inherit", "inherit"],
    });
  } else {
    const tendcms = pack(root, "tendcms", work);
    const createTend = pack(root, "create-tend", work);
    check(true, "tendcms and create-tend pack");
    const size = statSync(tendcms).size;
    check(
      size <= TARBALL_BYTES,
      `tendcms is at most 5 MB to download (${(size / 1e6).toFixed(2)} MB)`,
    );
    creating = Date.now();
    // As `npm create tend@latest my-site` does, from the packed create-tend. It's told to
    // install the packed tendcms in place of the published one.
    npm(
      ["exec", "--yes", `--package=${createTend}`, "--", "create-tend", "my-site", "--no-start"],
      {
        cwd: work,
        env: { ...process.env, CREATE_TEND_TENDCMS: `file:${tendcms.replaceAll("\\", "/")}` },
        stdio: ["ignore", "inherit", "inherit"],
      },
    );
  }
  const seconds = Math.round((Date.now() - creating) / 1000);
  const site = join(work, "my-site");
  const installed = checkMade(site);
  if (published || existsSync(join(root, "packages", "tendcms", "npm-shrinkwrap.json"))) {
    check(existsSync(join(installed, "npm-shrinkwrap.json")), "the shrinkwrap came with it");
  }
  const packages = installedPackages(site);
  const count = Object.keys(packages).length;
  // Three it chose, what those need, and their parts for this kind of computer.
  check(count <= MOST_PACKAGES, `it installed at most ${MOST_PACKAGES} packages (${count})`);
  check(seconds <= CREATE_SECONDS, `it took at most ${CREATE_SECONDS} s (${seconds} s)`);
  if (published) {
    const { version } = packages["node_modules/tendcms"];
    check(version === published, `npm create tend@${published} installed that version`);
  }
  await checkStarts(site, installed);
} catch (error) {
  console.error(`not ok - ${error.message}`);
  process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
