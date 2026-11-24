import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, expect, test } from "vitest";
import { HELP } from "../src/help.ts";

// The guide (docs/). Screens and messages lead to pages of it, and pages to each other, so each
// of them has to be there. Addresses on tendcms.dev are each a file here (docs/README.md).

const REPO = join(import.meta.dirname, "..", "..", "..");
const DOCS = join(REPO, "docs");

function filesIn(folder: string, ending: RegExp): string[] {
  return readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && ending.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((path) => !/[\\/](node_modules|dist|\.tsbuild)[\\/]/.test(path));
}

const SOURCES = [
  ...filesIn(join(REPO, "packages"), /\.(ts|tsx|json|md)$/),
  ...filesIn(join(REPO, "themes"), /\.(json|liquid)$/),
  ...filesIn(join(REPO, "docker"), /./),
  ...filesIn(join(REPO, "deploy"), /\.md$/),
].filter((path) => !/[\\/]test[\\/]/.test(path));

/** The guide's pages, and everything else in the repository that links to them. */
const PAGES = [
  ...filesIn(DOCS, /\.md$/),
  ...filesIn(join(REPO, "deploy"), /\.md$/),
  ...["README.md", "CONTRIBUTING.md", "SECURITY.md", "CODE_OF_CONDUCT.md", "TRADEMARKS.md"].map(
    (name) => join(REPO, name),
  ),
];

/** Addresses that are shorter than the page they lead to. */
const SHORT: Record<string, string> = {
  "install-node": "install-node.md",
  online: "move-your-site.md",
  railway: "railway.md",
};

const name = (path: string) => relative(REPO, path).replaceAll("\\", "/");

/** What GitHub makes of a heading, for links to it. */
function anchor(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s/g, "-");
}

function anchorsIn(markdown: string): Set<string> {
  const outsideCode = markdown.replace(/```[\s\S]*?```/g, "");
  return new Set(
    [...outsideCode.matchAll(/^#+ (.+)$/gm)].map((match) => anchor(match[1] as string)),
  );
}

describe("every address on tendcms.dev", () => {
  const asked = new Map<string, string>();
  for (const path of SOURCES) {
    const text = readFileSync(path, "utf8");
    for (const [, page] of text.matchAll(/https:\/\/tendcms\.dev\/([a-z][a-z0-9/_-]*)/g)) {
      asked.set(page as string, name(path));
    }
    // The admin and the server each put the same start on.
    for (const [, page] of text.matchAll(/guide\("([a-z-]*)"\)/g)) {
      asked.set(`docs/${page}`, name(path));
    }
    for (const [, page] of text.matchAll(/\$\{DOCS\}\/([a-z-]+)/g)) {
      asked.set(`docs/${page}`, name(path));
    }
  }

  test("is found", () => {
    for (const page of ["docs/", "docs/costs", "docs/proxies", "install-node", "railway"]) {
      expect([...asked.keys()]).toContain(page);
    }
  });

  test.each([...asked].sort())("%s, in %s, has a page", (page) => {
    if (page === "docs" || page === "docs/") return;
    if (page === "errors") return;
    const [folder, rest] = page.split(/\/(.*)/);
    // error-docs.test.ts looks at each of these.
    if (folder === "errors")
      return expect(existsSync(join(DOCS, "errors", `${rest}.md`))).toBe(true);
    const file = folder === "docs" ? `${rest}.md` : SHORT[page];
    expect(file, `${page} isn't an address anyone made`).toBeDefined();
    expect(existsSync(join(DOCS, file as string))).toBe(true);
  });

  test("that's short is in the guide's list of them", () => {
    const list = readFileSync(join(DOCS, "README.md"), "utf8");
    for (const [short, file] of Object.entries(SHORT)) {
      expect(list).toMatch(new RegExp(`tendcms\\.dev/${short}\`.*\\(${file}\\)`));
    }
  });
});

describe("every page", () => {
  test.each(PAGES.map((path) => [name(path), path]))("%s links to what's there", (_name, path) => {
    const text = readFileSync(path, "utf8");
    const links = [...text.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1] as string);
    for (const link of links) {
      if (/^(https?:|mailto:)/.test(link)) continue;
      const [file = "", hash] = link.split("#");
      const target = file === "" ? path : join(dirname(path), file);
      expect(existsSync(target), link).toBe(true);
      if (hash === undefined) continue;
      expect(statSync(target).isFile(), link).toBe(true);
      expect([...anchorsIn(readFileSync(target, "utf8"))], link).toContain(hash);
    }
  });

  test.each(PAGES.map((path) => [name(path), path]))("%s is in plain words", (_name, path) => {
    const text = readFileSync(path, "utf8");
    expect(text).not.toContain("—");
    expect(text.match(/^# .+$/gm)?.length ?? 0).toBeGreaterThanOrEqual(1);
  });

  test("of the guide can be reached from its first one", () => {
    const list = readFileSync(join(DOCS, "README.md"), "utf8");
    const pages = readdirSync(DOCS).filter((file) => file.endsWith(".md") && file !== "README.md");
    for (const page of pages) expect(list, page).toContain(`(${page})`);
  });
});

test("the command line's page has every command it has", () => {
  const page = readFileSync(join(DOCS, "command-line.md"), "utf8");
  const commands = [...HELP.matchAll(/^ {2}([a-z][a-z-]*)/gm)].map((match) => match[1] as string);
  expect(commands.length).toBeGreaterThan(5);
  for (const command of commands) expect(page, command).toContain(`| \`${command}`);
});

test("the settings' page has every setting Tend reads", () => {
  const page = readFileSync(join(DOCS, "settings-for-servers.md"), "utf8");
  const source = readFileSync(join(REPO, "packages", "tendcms", "src", "config.ts"), "utf8");
  const read = new Set(
    [...source.matchAll(/\benv\.([A-Z][A-Z_]+)/g)].map((match) => match[1] as string),
  );
  // Where it can't run, and what only working on Tend needs.
  for (const other of ["VERCEL", "NETLIFY", "AWS_LAMBDA_FUNCTION_NAME", "TEND_ADMIN_DEV_URL"]) {
    read.delete(other);
  }
  expect(read.size).toBeGreaterThan(8);
  for (const setting of read) expect(page, setting).toContain(`\`${setting}\``);
});
