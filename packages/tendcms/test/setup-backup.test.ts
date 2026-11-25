import { readdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { unzipSync, zipSync } from "fflate";
import sharp from "sharp";
import { describe, expect, test } from "vitest";
import { readSecretKey } from "../src/config.ts";
import { getSetting, putSetting } from "../src/db/repo/settings.ts";
import {
  browser,
  GOOD_PASSWORD,
  type MadeApp,
  makeApp,
  OWNER_EMAIL,
  type Reply,
  setUp,
  setupBody,
} from "./auth-helpers.ts";

// Start from a backup (PLAN.md J10): a backup from one site, uploaded a part at a time into a
// new one at setup, and restored into it while it runs.

/** A site online at its own address, with a picture, and a backup of it as the Owner downloads one. */
async function backupOfASite() {
  const made = await makeApp();
  const owner = await setUp(made);
  const site = (await getSetting(made.orm, "site")) as NonNullable<
    Awaited<ReturnType<typeof getSetting<"site">>>
  >;
  putSetting(
    made.orm,
    "site",
    { ...site, address: "https://old.example.com", address_confirmed: true },
    made.clock.time,
    null,
  );
  const png = await sharp({
    create: { width: 1200, height: 800, channels: 3, background: "#336699" },
  })
    .png()
    .toBuffer();
  const uploaded = await (await owner.upload("/api/admin/media", png, "Sunny day.png")).json();
  const zip = await (await owner.get("/api/admin/backups/download")).bytes();
  return { made, uploaded, zip };
}

/** What Tend answered, read as JSON. */
// biome-ignore lint/suspicious/noExplicitAny: each test checks the shape it reads
async function answer(response: Response): Promise<any> {
  return response.json();
}

function sendPart(
  site: MadeApp,
  part: Buffer,
  offset: number,
  { code = site.code, total }: { code?: string; total?: number } = {},
) {
  return site.app.request("/api/auth/setup/backup/part", {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Setup-Code": code,
      "X-Offset": String(offset),
      ...(total === undefined ? {} : { "X-Backup-Bytes": String(total) }),
    },
    body: new Uint8Array(part),
  });
}

/** Sends a backup in parts of `size` bytes, the way the setup screen does in 8 MB ones. */
async function upload(site: MadeApp, zip: Buffer, size = 64 * 1024): Promise<void> {
  for (let offset = 0; offset < zip.length; offset += size) {
    const part = zip.subarray(offset, offset + size);
    const reply = await sendPart(site, part, offset, { total: zip.length });
    expect(reply.status).toBe(200);
    expect((await answer(reply)).received).toBe(offset + part.length);
  }
}

function startRestore(site: MadeApp, bytes: number, code = site.code) {
  return browser(site.app).post("/api/auth/setup/backup/restore", { code, bytes });
}

/** Asks how a restore is going, the way the setup screen does, until it's over. */
async function outcome(site: MadeApp, started: Reply): Promise<Response> {
  expect(started.status).toBe(202);
  const { restore: id } = await started.json();
  for (let asked = 0; asked < 1000; asked++) {
    const reply = await site.app.request(`/api/auth/setup/backup/restore/${id}`);
    if (reply.status !== 200 || (await answer(reply.clone())).state !== "restoring") return reply;
    await sleep(10);
  }
  throw new Error("The restore never finished.");
}

describe("Start from a backup", () => {
  test("a new site becomes the one backed up, while it runs", async () => {
    const { made: old, uploaded, zip } = await backupOfASite();
    const site = await makeApp();
    await upload(site, zip);
    const started = await startRestore(site, zip.length);

    // Nothing can be set up underneath a restore.
    const meanwhile = await browser(site.app).post("/api/auth/setup", {
      code: site.code,
      ...setupBody({
        owner: { name: "Someone", email: "else@example.com", password: GOOD_PASSWORD },
      }),
    });
    expect(meanwhile.status).toBe(409);
    expect((await meanwhile.json()).error.code).toBe("restoring");

    const done = await outcome(site, started);
    expect(done.status).toBe(200);
    expect(await answer(done)).toEqual({ state: "restored", site: "Rise Bakery" });

    // Setup is over: the site has its Owner, who signs in as they always did.
    const status = await answer(await site.app.request("/api/auth/setup/status"));
    expect(status.needsSetup).toBe(false);
    const signIn = await browser(site.app).post("/api/auth/login", {
      email: OWNER_EMAIL,
      password: GOOD_PASSWORD,
    });
    expect(signIn.status).toBe(200);
    // It uses the old site's key from now on, in memory and on disk, as the next start reads it.
    expect(site.secretKey.equals(old.secretKey)).toBe(true);
    const onDisk = readSecretKey({ secretKeyPath: join(site.root, "secret.key") });
    expect(onDisk.equals(old.secretKey)).toBe(true);
    // Its pages and pictures are the old site's.
    const home = await (await site.app.request("/")).text();
    expect(home).toContain("Rise Bakery");
    // But not its address: until the new one is confirmed, links follow the one asked for.
    expect(home).not.toContain("old.example.com");
    expect(home).toContain('rel="canonical" href="http://localhost/"');
    expect(await (await site.app.request("/sitemap.xml")).text()).not.toContain("old.example.com");
    expect(await getSetting(site.orm, "site")).toMatchObject({
      address: null,
      address_confirmed: false,
    });
    const size = await site.app.request(uploaded.srcset.split(", ")[0].split(" ")[0]);
    expect(size.status).toBe(200);
    // The empty site it replaced was saved first, and nothing else was left behind.
    expect(readdirSync(join(site.root, "backups"))).toEqual([
      expect.stringMatching(/^before-restore-[0-9TZ.]+\.db\.gz$/),
    ]);
  });

  test("needs the setup code, every part in turn, and all of the file", async () => {
    const { zip } = await backupOfASite();
    const site = await makeApp();
    const first = zip.subarray(0, 1000);
    const second = zip.subarray(1000, 2000);
    expect((await sendPart(site, first, 0, { code: "WRONG-CODE" })).status).toBe(401);
    expect((await sendPart(site, first, 0)).status).toBe(200);
    // A part out of turn can't put the file together wrong.
    const skipped = await sendPart(site, zip.subarray(2000, 3000), 2000);
    expect(skipped.status).toBe(409);
    expect((await answer(skipped)).error.code).toBe("upload_out_of_step");
    // A part sent again, because its answer was lost, is only written once.
    expect(await answer(await sendPart(site, second, 1000))).toEqual({ received: 2000 });
    expect(await answer(await sendPart(site, second, 1000))).toEqual({ received: 2000 });
    const different = await sendPart(site, Buffer.alloc(1000, 7), 1000);
    expect(different.status).toBe(409);

    const short = await startRestore(site, zip.length);
    expect(short.status).toBe(409);
    expect((await short.json()).error.code).toBe("upload_incomplete");
    // What arrived is gone, so the next try starts clean.
    expect(readdirSync(join(site.root, "backups"))).toEqual([]);
  });

  test("refuses a backup too big for the space here before it's sent", async () => {
    const site = await makeApp();
    const part = await sendPart(site, Buffer.alloc(1000), 0, { total: 2 ** 52 });
    expect(part.status).toBe(413);
    expect((await answer(part)).error.code).toBe("no_room");
  });

  test("refuses a backup that fails its checks, and the site still waits for setup", async () => {
    const { zip } = await backupOfASite();
    const files = unzipSync(zip);
    const original = Object.keys(files).find((name) => name.startsWith("uploads/")) as string;
    const bytes = files[original] as Uint8Array;
    bytes[100] = (bytes[100] ?? 0) ^ 1;
    const changed = Buffer.from(zipSync(files));

    const site = await makeApp();
    const keyBefore = Buffer.from(site.secretKey);
    await upload(site, changed);
    const refused = await outcome(site, await startRestore(site, changed.length));
    expect(refused.status).toBe(400);
    const { error } = await answer(refused);
    expect(error.code).toBe("backup_refused");
    expect(error.message).toMatch(/isn't the file that was saved/);
    const status = await answer(await site.app.request("/api/auth/setup/status"));
    expect(status.needsSetup).toBe(true);
    expect(site.secretKey.equals(keyBefore)).toBe(true);
    expect(readdirSync(join(site.root, "backups"))).toEqual([]);
  });

  test("only says how a restore is going to whoever started it", async () => {
    const site = await makeApp();
    const reply = await site.app.request("/api/auth/setup/backup/restore/made-up");
    expect(reply.status).toBe(404);
    expect((await answer(reply)).error.code).toBe("restore_unknown");
  });

  test("closes once the site is set up", async () => {
    const { zip } = await backupOfASite();
    const site = await makeApp();
    await setUp(site);
    const part = await sendPart(site, zip.subarray(0, 1000), 0);
    expect(part.status).toBe(409);
    expect((await answer(part)).error.code).toBe("setup_closed");
    expect((await startRestore(site, 1000)).status).toBe(409);
  });
});
