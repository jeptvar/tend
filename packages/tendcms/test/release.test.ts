import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, test } from "vitest";
import { changesIn, checkRelease } from "../../../scripts/check-release.mjs";
import { readTarball, startRegistry } from "../../../scripts/registry.mjs";
import { tempDir } from "./helpers.ts";

// What a release has to pass before anything is published (PLAN.md §14, release.yml).

const CHANGELOG = `# Changelog

## [Unreleased]

## [0.2.0] - 2027-01-15

### Added

- Tables in the editor.

## [0.1.0] - 2026-12-01

The first one.

- Everything.

[0.2.0]: https://example.com/compare/v0.1.0...v0.2.0
`;

function write(root: string, files: Record<string, string | object>): void {
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  }
}

/** A repository that's ready to release 0.1.0. */
function ready(changes: Record<string, string | object> = {}): string {
  const root = tempDir();
  write(root, {
    "packages/tendcms/package.json": { name: "tendcms", version: "0.1.0" },
    "packages/create-tend/package.json": { name: "create-tend", version: "0.1.0" },
    "CHANGELOG.md": CHANGELOG,
    "fixtures/upgrades/0.1.0.db.gz": "",
    "fixtures/upgrades/0.1.0.json.gz": "",
    ...changes,
  });
  return root;
}

describe("what has to be true of a release", () => {
  test("nothing is wrong when its tag, packages, changelog and fixture agree", () => {
    expect(checkRelease(ready(), "v0.1.0")).toEqual({
      problems: [],
      notes: "The first one.\n\n- Everything.",
    });
  });

  test("the tag is a version's", () => {
    for (const tag of ["0.1.0", "v0.1", "v0.1.0-", "vnext", "v0.1.0 ", ""]) {
      expect(checkRelease(ready(), tag).problems, tag).toEqual([
        `${tag} isn't a release's tag, like v0.1.0.`,
      ]);
    }
  });

  test("both packages are that version", () => {
    const old = { "packages/create-tend/package.json": { name: "create-tend", version: "0.0.9" } };
    expect(checkRelease(ready(old), "v0.1.0").problems).toEqual([
      "packages/create-tend says it's 0.0.9, and the tag says 0.1.0.",
    ]);
  });

  test("the changelog says what changed", () => {
    expect(checkRelease(ready({ "CHANGELOG.md": "# Changelog\n" }), "v0.1.0").problems).toEqual([
      'CHANGELOG.md needs "## [0.1.0] - YYYY-MM-DD", and what changed.',
    ]);
    const empty = { "CHANGELOG.md": "# Changelog\n\n## [0.1.0] - 2026-12-01\n\nSoon.\n" };
    expect(checkRelease(ready(empty), "v0.1.0").problems).toEqual([
      "CHANGELOG.md says nothing under 0.1.0.",
    ]);
  });

  test("there's a site from it to upgrade, unless it's only being tried out", () => {
    const root = ready();
    write(root, {
      "packages/tendcms/package.json": { version: "0.2.0" },
      "packages/create-tend/package.json": { version: "0.2.0" },
    });
    expect(checkRelease(root, "v0.2.0").problems).toHaveLength(2);
    expect(checkRelease(root, "v0.2.0").problems[0]).toContain("make-fixture.mjs makes it");

    write(root, {
      "packages/tendcms/package.json": { version: "0.2.0-beta.1" },
      "packages/create-tend/package.json": { version: "0.2.0-beta.1" },
      "CHANGELOG.md": "## [0.2.0-beta.1] - 2027-01-01\n\n- To try out.\n",
    });
    expect(checkRelease(root, "v0.2.0-beta.1")).toEqual({
      problems: [],
      notes: "- To try out.",
    });
  });

  test("the notes are that version's alone", () => {
    expect(changesIn(CHANGELOG, "0.2.0")).toBe("### Added\n\n- Tables in the editor.");
    expect(changesIn(CHANGELOG, "0.1.0")).toBe("The first one.\n\n- Everything.");
    expect(changesIn(CHANGELOG, "0.3.0")).toBeUndefined();
    // Not any version that looks like it.
    expect(changesIn("## [0x1y0] - 2026-01-01\n- No", "0.1.0")).toBeUndefined();
  });
});

/** A package's tarball, as npm makes one. */
function tarball(files: Record<string, string | object>): Buffer {
  const blocks = Object.entries(files).flatMap(([name, content]) => {
    const data = Buffer.from(typeof content === "string" ? content : JSON.stringify(content));
    const header = Buffer.alloc(512);
    header.write(`package/${name}`, 0);
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("0", 156);
    const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
    return [header, data, padding];
  });
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

describe("the registry a release is tried from", () => {
  const closing: (() => unknown)[] = [];
  afterEach(async () => {
    for (const close of closing.splice(0)) await close();
  });

  test("reads what's in a tarball", () => {
    const files = readTarball(
      tarball({ "package.json": { name: "x" }, "dist/a.js": "a".repeat(700) }),
    );
    expect([...files.keys()]).toEqual(["package/package.json", "package/dist/a.js"]);
    expect(files.get("package/dist/a.js")?.toString()).toBe("a".repeat(700));
  });

  test("has the release in it as of an hour ago, and gets the rest from npm", async () => {
    const asked: string[] = [];
    const npm: Server = createServer((request, response) => {
      asked.push(request.url ?? "");
      response.writeHead(request.url === "/gone" ? 404 : 200, {
        "Content-Type": "application/json",
      });
      response.end('{"from":"npm"}');
    });
    await new Promise<void>((resolve) => npm.listen(0, "127.0.0.1", resolve));
    closing.push(() => npm.close());

    const packed = tarball({
      "package.json": { name: "tendcms", version: "0.1.0", dependencies: { sharp: "1.0.0" } },
      "npm-shrinkwrap.json": {},
    });
    const path = join(tempDir(), "tendcms-0.1.0.tgz");
    writeFileSync(path, packed);
    const publishedAt = Date.now() - 60 * 60 * 1000;
    const registry = await startRegistry({
      tarballs: [path],
      publishedAt,
      upstream: `http://127.0.0.1:${(npm.address() as AddressInfo).port}`,
    });
    closing.push(registry.close);

    // biome-ignore lint/suspicious/noExplicitAny: the shape is what's being checked
    const about: any = await (await fetch(`${registry.url}/tendcms`)).json();
    expect(about["dist-tags"]).toEqual({ latest: "0.1.0" });
    expect(about.time["0.1.0"]).toBe(new Date(publishedAt).toISOString());
    const version = about.versions["0.1.0"];
    expect(version.dependencies).toEqual({ sharp: "1.0.0" });
    // Without this, npm ignores the shrinkwrap.
    expect(version._hasShrinkwrap).toBe(true);
    const sent = Buffer.from(await (await fetch(version.dist.tarball)).arrayBuffer());
    expect(sent.equals(packed)).toBe(true);
    expect(version.dist.integrity).toBe(
      `sha512-${createHash("sha512").update(packed).digest("base64")}`,
    );

    expect(await (await fetch(`${registry.url}/@img%2fsharp-linux-x64`)).json()).toEqual({
      from: "npm",
    });
    expect((await fetch(`${registry.url}/gone`)).status).toBe(404);
    expect(asked).toEqual(["/@img%2fsharp-linux-x64", "/gone"]);
    // Nothing is ever sent to npm.
    const audit = await fetch(`${registry.url}/-/npm/v1/security/audits`, { method: "POST" });
    expect(audit.status).toBe(404);
    expect(asked).toHaveLength(2);
  });
});
