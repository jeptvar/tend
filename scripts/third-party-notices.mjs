// A Rolldown plugin, for tsdown, that writes THIRD_PARTY_NOTICES.md beside the server bundle:
// every package bundled into it, with its licence in full (PLAN.md §14). tsdown has no option
// for this. The packages come from the bundle itself, from the files each chunk was made
// from, so one added later can't be left out. Zero dependencies.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const NODE_MODULES = "/node_modules/";
const LICENCE_FILE = /^(licen[cs]e|copying)(\.(md|txt))?$/i;

/** The folder of the package a bundled file came from, or undefined for the project's own. */
export function packageRoot(id) {
  const path = id.replaceAll("\\", "/");
  const at = path.lastIndexOf(NODE_MODULES);
  if (at === -1) return undefined;
  const [first, second] = path.slice(at + NODE_MODULES.length).split("/");
  const name = first?.startsWith("@") ? `${first}/${second}` : first;
  return name ? `${path.slice(0, at + NODE_MODULES.length)}${name}` : undefined;
}

function noticeFor(root) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const file = readdirSync(root).find((name) => LICENCE_FILE.test(name));
  const text = file
    ? readFileSync(join(root, file), "utf8").trim()
    : `(The package has no licence file. Its package.json gives ${pkg.license ?? "no licence"}.)`;
  const repository = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  const source = pkg.homepage ?? repository;
  const about = [pkg.license, source].filter(Boolean).join(" · ");
  return {
    name: pkg.name,
    text: `## ${pkg.name} ${pkg.version}\n\n${about}\n\n\`\`\`\n${text}\n\`\`\`\n`,
  };
}

export function thirdPartyNotices() {
  return {
    name: "tend-third-party-notices",
    generateBundle(_options, bundle) {
      const roots = new Set();
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;
        for (const id of Object.keys(output.modules)) {
          const root = packageRoot(id);
          if (root) roots.add(root);
        }
      }
      const notices = [...roots].map(noticeFor).sort((a, b) => a.name.localeCompare(b.name));
      const intro = [
        "# Third-party notices",
        "",
        "Tend's server bundles these packages, each under its own licence, given in full below.",
        "The admin's are in admin/THIRD_PARTY_NOTICES.md. Packages installed beside Tend rather",
        "than bundled into it keep their licences in their own folders.",
        "",
      ].join("\n");
      this.emitFile({
        type: "asset",
        fileName: "THIRD_PARTY_NOTICES.md",
        source: `${intro}\n${notices.map((notice) => notice.text).join("\n")}`,
      });
    },
  };
}
