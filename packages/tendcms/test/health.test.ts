import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { makeApp, setUp, signedInAs } from "./auth-helpers.ts";

// What the Help screen says about how Tend is doing (PLAN.md §6, the diagnostics page).

const DAY = 24 * 60 * 60 * 1000;

interface Finding {
  kind: "OK" | "LOOK" | "FIX";
  text: string;
}

async function healthOf(client: Awaited<ReturnType<typeof setUp>>) {
  const reply = await client.get("/api/admin/health");
  expect(reply.status).toBe(200);
  return reply.json();
}

async function problems(client: Awaited<ReturnType<typeof setUp>>): Promise<string[]> {
  const { findings } = await healthOf(client);
  return findings
    .filter((finding: Finding) => finding.kind !== "OK")
    .map((finding: Finding) => `${finding.kind} ${finding.text}`);
}

describe("how Tend is doing", () => {
  test("says what's running, and that there's nothing to fix", async () => {
    const made = await makeApp({ platform: "docker" });
    const owner = await setUp(made);
    const health = await healthOf(owner);
    expect(health).toMatchObject({
      version: "1.2.3",
      node: process.versions.node,
      platform: "docker",
      system: `${process.platform} ${process.arch}`,
    });
    expect(health.memoryBytes).toBeGreaterThan(0);
    expect(health.databaseBytes).toBeGreaterThan(0);
    expect(health.runningForSeconds).toBeGreaterThanOrEqual(0);
    // How full this computer's disk is isn't up to Tend.
    expect((await problems(owner)).filter((text) => !/ disk /.test(text))).toEqual([]);
  });

  test("is for Admins", async () => {
    const made = await makeApp();
    await setUp(made);
    const { client: editor } = await signedInAs(made, "editor");
    expect((await editor.get("/api/admin/health")).status).toBe(403);
  });

  test("tells when there's been no daily copy for days", async () => {
    const made = await makeApp();
    await setUp(made);
    made.clock.time += 3 * DAY;
    const { client: admin } = await signedInAs(made, "admin");
    expect(await problems(admin)).toContainEqual(expect.stringContaining("there are none yet"));
    const stamp = new Date(made.clock.time - 3 * DAY).toISOString().replace(/[-:]/g, "");
    writeFileSync(join(made.root, "backups", `daily-${stamp}.db.gz`), "");
    expect(await problems(admin)).toContainEqual(expect.stringContaining("the newest is from"));
    const fresh = new Date(made.clock.time).toISOString().replace(/[-:]/g, "");
    writeFileSync(join(made.root, "backups", `daily-${fresh}.db.gz`), "");
    expect(await problems(admin)).not.toContainEqual(expect.stringContaining("copy of the site"));
  });

  test("tells when the site could be lost with its container", async () => {
    const made = await makeApp({
      dataRisk: { why: "unmounted", path: "/data", platform: "docker" },
    });
    const owner = await setUp(made);
    expect(await problems(owner)).toContainEqual(expect.stringMatching(/^FIX .*\/data/));
  });

  test("tells when the chosen theme is gone", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const design = await (await owner.get("/api/admin/design")).json();
    made.db
      .prepare("INSERT INTO settings (key, value, updated_at) VALUES ('design', ?, 0)")
      .run(JSON.stringify({ ...design.value, themeId: "gone" }));
    expect(await problems(owner)).toContainEqual(
      "FIX The theme this site uses, gone, isn't here any more.",
    );
  });

  test("tells when the site's address is plain http, or a proxy isn't accounted for", async () => {
    const http = await makeApp({ publicUrl: "http://rise.example.com" });
    expect(await problems(await setUp(http))).toContainEqual(expect.stringContaining("http:"));
    const proxy = await makeApp({ publicUrl: "https://rise.example.com" });
    expect(await problems(await setUp(proxy))).toContainEqual(
      expect.stringContaining("TEND_TRUST_PROXY"),
    );
  });

  test("names nobody, and nobody's folder", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const text = JSON.stringify(await healthOf(owner));
    expect(text).not.toContain("tom@example.com");
    expect(text).not.toContain("Tom Baker");
    expect(text).not.toContain(JSON.stringify(homedir()).slice(1, -1));
  });
});
