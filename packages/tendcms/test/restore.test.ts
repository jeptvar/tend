import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { unzipSync, zipSync } from "fflate";
import sharp from "sharp";
import { describe, expect, test } from "vitest";
import { parseSecretKey } from "../src/config.ts";
import { getSetting, putSetting } from "../src/db/repo/settings.ts";
import {
  browser,
  GOOD_PASSWORD,
  type MadeApp,
  makeApp,
  OWNER_EMAIL,
  type Reply,
  setUp,
  signedInAs,
} from "./auth-helpers.ts";

// Settings → Backups (v0.2): the Owner puts the site back as it was, from one of the copies
// kept here or from a backup they downloaded, while it runs.

type Client = ReturnType<typeof browser>;

/** What Tend answered, read as JSON. */
// biome-ignore lint/suspicious/noExplicitAny: each test checks the shape it reads
async function answer(response: Response): Promise<any> {
  return response.json();
}

function sendPart(made: MadeApp, client: Client, part: Buffer, offset: number, total: number) {
  return made.app.request("/api/auth/restore/part", {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      Cookie: [...client.jar].map(([name, value]) => `${name}=${value}`).join("; "),
      "X-Offset": String(offset),
      "X-Backup-Bytes": String(total),
    },
    body: new Uint8Array(part),
  });
}

/** Sends a backup in parts of `size` bytes, the way Settings → Backups does in 8 MB ones. */
async function upload(made: MadeApp, client: Client, zip: Buffer, size = 64 * 1024) {
  for (let offset = 0; offset < zip.length; offset += size) {
    const part = zip.subarray(offset, offset + size);
    const reply = await sendPart(made, client, part, offset, zip.length);
    expect(reply.status).toBe(200);
    expect((await answer(reply)).received).toBe(offset + part.length);
  }
}

/** Asks how a restore is going, the way the admin does, until it's over. */
async function outcome(made: MadeApp, started: Reply): Promise<Response> {
  expect(started.status).toBe(202);
  const { restore: id } = await started.json();
  for (let asked = 0; asked < 1000; asked++) {
    // Without anyone's cookie: by the end, everyone is signed out.
    const reply = await made.app.request(`/api/auth/restore/${id}`);
    if (reply.status !== 200 || (await answer(reply.clone())).state !== "restoring") return reply;
    await sleep(10);
  }
  throw new Error("The restore never finished.");
}

async function newPost(client: Client, title: string): Promise<void> {
  const made = await (await client.post("/api/admin/entries", { type: "post" })).json();
  const saved = await client.patch(
    `/api/admin/entries/${made.id}`,
    { title },
    { "If-Match": String(made.rev) },
  );
  expect(saved.status).toBe(200);
}

async function postTitles(client: Client): Promise<string[]> {
  const { entries } = await (await client.get("/api/admin/entries?type=post")).json();
  return entries.map((entry: { title: string }) => entry.title).sort();
}

async function signIn(made: MadeApp): Promise<Client> {
  const client = browser(made.app);
  const reply = await client.post("/api/auth/login", {
    email: OWNER_EMAIL,
    password: GOOD_PASSWORD,
  });
  expect(reply.status).toBe(200);
  return client;
}

async function saveCopy(owner: Client): Promise<string> {
  const saved = await owner.post("/api/admin/backups");
  expect(saved.status).toBe(201);
  return (await saved.json()).snapshots[0].id;
}

async function aPicture(): Promise<Buffer> {
  return sharp({ create: { width: 1200, height: 800, channels: 3, background: "#336699" } })
    .png()
    .toBuffer();
}

describe("Restore from Settings → Backups", () => {
  test("the Owner puts the site back as it was in a copy kept here", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    await newPost(owner, "Kept");
    const copy = await saveCopy(owner);
    await newPost(owner, "Written after the copy");
    // The site moved to its own address after the copy was made, and stays there.
    const site = (await getSetting(made.orm, "site")) as NonNullable<
      Awaited<ReturnType<typeof getSetting<"site">>>
    >;
    putSetting(
      made.orm,
      "site",
      { ...site, address: "https://bakery.example.com", address_confirmed: true },
      made.clock.time,
      null,
    );

    const done = await outcome(
      made,
      await owner.post("/api/auth/restore", {
        password: GOOD_PASSWORD,
        copy,
      }),
    );
    expect(done.status).toBe(200);
    expect(await answer(done)).toEqual({
      state: "restored",
      site: "Rise Bakery",
      savedAt: new Date(made.clock.time).toISOString(),
    });

    // Everyone signs in again, with the password they had then.
    expect((await owner.get("/api/admin/entries?type=post")).status).toBe(401);
    const again = await signIn(made);
    expect(await postTitles(again)).not.toContain("Written after the copy");
    expect(await postTitles(again)).toContain("Kept");
    expect(await getSetting(made.orm, "site")).toMatchObject({
      address: "https://bakery.example.com",
      address_confirmed: true,
    });
    // The site as it was is saved first, as a copy that can be restored to undo this.
    const { snapshots } = await (await again.get("/api/admin/backups")).json();
    const before = snapshots.find((each: { kind: string }) => each.kind === "restore");
    expect(before).toBeDefined();
    const undone = await outcome(
      made,
      await again.post("/api/auth/restore", {
        password: GOOD_PASSWORD,
        copy: before.id,
      }),
    );
    expect(undone.status).toBe(200);
    expect(await postTitles(await signIn(made))).toContain("Written after the copy");
  });

  test("a downloaded backup, sent a part at a time, brings back its pictures too", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const uploaded = await (
      await owner.upload("/api/admin/media", await aPicture(), "Sunny day.png")
    ).json();
    const zip = await (await owner.get("/api/admin/backups/download")).bytes();
    await newPost(owner, "Written after the backup");

    await upload(made, owner, zip);
    const done = await outcome(
      made,
      await owner.post("/api/auth/restore", {
        password: GOOD_PASSWORD,
        bytes: zip.length,
      }),
    );
    expect(done.status).toBe(200);
    expect((await answer(done)).state).toBe("restored");
    const again = await signIn(made);
    expect(await postTitles(again)).not.toContain("Written after the backup");
    const size = await made.app.request(uploaded.srcset.split(", ")[0].split(" ")[0]);
    expect(size.status).toBe(200);
    // What was sent is gone, and nothing else is left behind but the copy saved first.
    expect(readdirSync(join(made.root, "backups"))).toEqual([
      expect.stringMatching(/^before-restore-[0-9TZ.]+\.db\.gz$/),
    ]);
  });

  test("another site's backup brings its key, and undoing it brings this site's back", async () => {
    const other = await makeApp();
    const otherOwner = await setUp(other);
    await newPost(otherOwner, "From the other site");
    const zip = await (await otherOwner.get("/api/admin/backups/download")).bytes();

    const made = await makeApp();
    const owner = await setUp(made);
    const ownKey = Buffer.from(made.secretKey);
    await upload(made, owner, zip);
    const done = await outcome(
      made,
      await owner.post("/api/auth/restore", {
        password: GOOD_PASSWORD,
        bytes: zip.length,
      }),
    );
    expect(done.status).toBe(200);
    expect(made.secretKey.equals(other.secretKey)).toBe(true);
    const kept = readdirSync(join(made.root, "backups")).find((name) => name.endsWith(".key"));
    expect(kept).toMatch(/^before-restore-[0-9TZ.]+\.secret\.key$/);
    const keptKey = parseSecretKey(readFileSync(join(made.root, "backups", kept as string)));
    expect(keptKey?.equals(ownKey)).toBe(true);

    const again = await signIn(made);
    expect(await postTitles(again)).toContain("From the other site");
    const { snapshots } = await (await again.get("/api/admin/backups")).json();
    const before = snapshots.find((each: { kind: string }) => each.kind === "restore");
    const undone = await outcome(
      made,
      await again.post("/api/auth/restore", {
        password: GOOD_PASSWORD,
        copy: before.id,
      }),
    );
    expect(undone.status).toBe(200);
    expect(made.secretKey.equals(ownKey)).toBe(true);
    expect(await postTitles(await signIn(made))).not.toContain("From the other site");
  });

  test("only the Owner, who says their password again", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const copy = await saveCopy(owner);
    const { client: admin } = await signedInAs(made, "admin");
    const part = await sendPart(made, admin, Buffer.alloc(1000), 0, 1000);
    expect(part.status).toBe(403);
    expect((await answer(part)).error.code).toBe("not_allowed");
    const asAdmin = await admin.post("/api/auth/restore", { password: GOOD_PASSWORD, copy });
    expect(asAdmin.status).toBe(403);
    const nobody = await browser(made.app).post("/api/auth/restore", {
      password: GOOD_PASSWORD,
      copy,
    });
    expect(nobody.status).toBe(401);

    const wrong = await owner.post("/api/auth/restore", { password: "not-my-password", copy });
    expect(wrong.status).toBe(400);
    expect((await wrong.json()).error.code).toBe("password_wrong");
    // Before a backup is sent, the password can be checked on its own, by the Owner alone.
    const mistyped = await owner.post("/api/auth/restore/check", { password: "not-my-password" });
    expect((await mistyped.json()).error.code).toBe("password_wrong");
    expect((await owner.post("/api/auth/restore/check", { password: GOOD_PASSWORD })).status).toBe(
      204,
    );
    expect((await admin.post("/api/auth/restore/check", { password: GOOD_PASSWORD })).status).toBe(
      403,
    );
    const unknown = await owner.post("/api/auth/restore", {
      password: GOOD_PASSWORD,
      copy: "manual-20200101T000000.000Z",
    });
    expect(unknown.status).toBe(404);
    const neither = await owner.post("/api/auth/restore", { password: GOOD_PASSWORD });
    expect(neither.status).toBe(400);
    // Nothing happened: the Owner is still signed in.
    expect((await owner.get("/api/admin/backups")).status).toBe(200);
  });

  test("the admin's changes wait while a backup becomes the site", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const copy = await saveCopy(owner);
    const started = await owner.post("/api/auth/restore", { password: GOOD_PASSWORD, copy });
    const meanwhile = await owner.post("/api/admin/entries", { type: "post" });
    expect(meanwhile.status).toBe(409);
    expect((await meanwhile.json()).error.code).toBe("restoring");
    const twice = await owner.post("/api/auth/restore", { password: GOOD_PASSWORD, copy });
    expect(twice.status).toBe(409);
    expect((await outcome(made, started)).status).toBe(200);
  });

  test("a backup that fails its checks leaves the site as it was", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    await owner.upload("/api/admin/media", await aPicture(), "Sunny day.png");
    const files = unzipSync(await (await owner.get("/api/admin/backups/download")).bytes());
    const original = Object.keys(files).find((name) => name.startsWith("uploads/")) as string;
    const bytes = files[original] as Uint8Array;
    bytes[100] = (bytes[100] ?? 0) ^ 1;
    const changed = Buffer.from(zipSync(files));
    await newPost(owner, "Still here");

    await upload(made, owner, changed);
    const refused = await outcome(
      made,
      await owner.post("/api/auth/restore", {
        password: GOOD_PASSWORD,
        bytes: changed.length,
      }),
    );
    expect(refused.status).toBe(400);
    const { error } = await answer(refused);
    expect(error.code).toBe("backup_refused");
    expect(error.message).toMatch(/isn't the file that was saved/);
    // Still signed in, and nothing changed.
    expect(await postTitles(owner)).toContain("Still here");
    expect(readdirSync(join(made.root, "backups"))).toEqual([]);
  });
});
