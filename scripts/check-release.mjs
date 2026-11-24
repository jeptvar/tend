// What has to be true of a release before anything is built for it (PLAN.md §14): its tag, its
// packages, the changelog and the upgrade fixture all say the same version.
//
//   node scripts/check-release.mjs v0.1.0 [--notes notes.md]
//
// With --notes, what the changelog says about it is written there. Zero dependencies.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const TAG = /^v(\d+\.\d+\.\d+(?:-[0-9a-z]+(?:\.[0-9a-z]+)*)?)$/;

/** What the changelog says about a version, or undefined if it doesn't mention it. */
export function changesIn(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const heading = new RegExp(
    `^## \\[${version.replaceAll(".", "\\.")}\\] - (\\d{4}-\\d{2}-\\d{2})$`,
  );
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^## |^\[[^\]]+\]: /.test(line));
  return rest
    .slice(0, end === -1 ? undefined : end)
    .join("\n")
    .trim();
}

/** Everything that's wrong with releasing this tag from this folder, and its notes. */
export function checkRelease(root, tag) {
  const version = TAG.exec(tag)?.[1];
  if (!version) return { problems: [`${tag} isn't a release's tag, like v0.1.0.`], notes: "" };
  const problems = [];
  for (const name of ["tendcms", "create-tend"]) {
    const manifest = JSON.parse(readFileSync(join(root, "packages", name, "package.json"), "utf8"));
    if (manifest.version !== version) {
      problems.push(`packages/${name} says it's ${manifest.version}, and the tag says ${version}.`);
    }
  }
  const changelogPath = join(root, "CHANGELOG.md");
  const changelog = existsSync(changelogPath) ? readFileSync(changelogPath, "utf8") : "";
  const notes = changesIn(changelog, version);
  if (!notes) {
    problems.push(`CHANGELOG.md needs "## [${version}] - YYYY-MM-DD", and what changed.`);
  } else if (!/^- /m.test(notes)) {
    problems.push(`CHANGELOG.md says nothing under ${version}.`);
  }
  // A version that's only tried out isn't upgraded from.
  if (!version.includes("-")) {
    for (const ending of ["db.gz", "json.gz"]) {
      const fixture = join("fixtures", "upgrades", `${version}.${ending}`);
      if (!existsSync(join(root, fixture))) {
        problems.push(`${fixture} is missing: node scripts/make-fixture.mjs makes it.`);
      }
    }
  }
  return { problems, notes: notes ?? "" };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { notes: { type: "string" } },
  });
  const { problems, notes } = checkRelease(join(import.meta.dirname, ".."), positionals[0] ?? "");
  for (const problem of problems) console.error(`not ok - ${problem}`);
  if (problems.length > 0) process.exit(1);
  if (values.notes) writeFileSync(values.notes, `${notes}\n`);
  console.log(`ok - ${positionals[0]} can be released`);
}
