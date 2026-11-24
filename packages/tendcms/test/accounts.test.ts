import { describe, expect, test } from "vitest";
import { removeEndedSessions } from "../src/db/repo/sessions.ts";
import { removeOldTokens } from "../src/db/repo/tokens.ts";
import {
  browser,
  GOOD_PASSWORD,
  type MadeApp,
  makeApp,
  OWNER_EMAIL,
  setUp,
  setupBody,
  signedInAs,
} from "./auth-helpers.ts";

// Someone's own account, turning someone's access off, and handing the site over (PLAN.md §6,
// §9 and §12).

const NEW_PASSWORD = "harbor-violet-pencil-meadow-sky";
const ANOTHER_PASSWORD = "orchid-lantern-copper-tide-mosaic";
const PEOPLE = "/api/admin/people";

type Client = ReturnType<typeof browser>;

async function signIn(made: MadeApp, email: string, password: string): Promise<Client> {
  const client = browser(made.app);
  await client.post("/api/auth/login", { email, password });
  return client;
}

async function isSignedIn(client: Client): Promise<boolean> {
  return (await client.get("/api/auth/me")).status === 200;
}

async function idOf(client: Client): Promise<string> {
  return (await (await client.get("/api/auth/me")).json()).user.id;
}

/** Someone who joined by invite, so they have a password of their own. */
async function join(made: MadeApp, owner: Client, email: string, role: string) {
  const { token } = await (await owner.post(`${PEOPLE}/invites`, { email, role })).json();
  const client = browser(made.app);
  const reply = await client.post("/api/auth/invite/accept", {
    token,
    name: "Ed Ward",
    password: NEW_PASSWORD,
  });
  expect(reply.status).toBe(201);
  return { client, id: await idOf(client) };
}

describe("someone's own account", () => {
  test("changes its name without the password, and nothing else with it", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const reply = await owner.patch("/api/auth/me", { name: "  Thomas Baker ", role: "writer" });
    expect((await reply.json()).user).toMatchObject({ name: "Thomas Baker", role: "admin" });
    expect((await owner.patch("/api/auth/me", { name: " " })).status).toBe(400);
    expect((await browser(made.app).patch("/api/auth/me", { name: "X" })).status).toBe(401);
  });

  test("changes its email with the password, and signs in with it from then on", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    await join(made, owner, "ed@example.com", "editor");
    const change = (email: string, password = GOOD_PASSWORD) =>
      owner.post("/api/auth/me/email", { email, password });

    const wrong = await change("tom@new.example", "not my password at all");
    expect((await wrong.json()).error).toMatchObject({ code: "password_wrong", field: "password" });
    const taken = await change("ED@example.com");
    expect((await taken.json()).error).toMatchObject({ code: "already_here", field: "email" });
    expect((await change("not an email")).status).toBe(400);

    expect((await change("Tom@New.example")).status).toBe(200);
    expect(await isSignedIn(owner)).toBe(true);
    expect(await isSignedIn(await signIn(made, OWNER_EMAIL, GOOD_PASSWORD))).toBe(false);
    expect(await isSignedIn(await signIn(made, "tom@new.example", GOOD_PASSWORD))).toBe(true);
    // To what it is already, in other capitals, is fine.
    expect((await change("TOM@new.example")).status).toBe(200);
  });

  test("changes its password with the old one, and signs every other device out", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const phone = await signIn(made, OWNER_EMAIL, GOOD_PASSWORD);
    const change = (password: string, newPassword: string) =>
      owner.post("/api/auth/me/password", { password, newPassword });

    const wrong = await change("not my password at all", NEW_PASSWORD);
    expect((await wrong.json()).error).toMatchObject({ code: "password_wrong", field: "password" });
    const easy = await change(GOOD_PASSWORD, "password1234");
    expect((await easy.json()).error).toMatchObject({
      code: "needs_fixing",
      field: "newPassword",
    });
    expect(await isSignedIn(phone)).toBe(true);

    expect((await change(GOOD_PASSWORD, NEW_PASSWORD)).status).toBe(200);
    expect(await isSignedIn(owner)).toBe(true);
    expect(await isSignedIn(phone)).toBe(false);
    expect(await isSignedIn(await signIn(made, OWNER_EMAIL, GOOD_PASSWORD))).toBe(false);
    expect(await isSignedIn(await signIn(made, OWNER_EMAIL, NEW_PASSWORD))).toBe(true);
  });

  test("guessing its password from a session left open is slowed down", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const guess = () =>
      owner.post("/api/auth/me/password", { password: "a guess", newPassword: NEW_PASSWORD });
    for (let tries = 0; tries < 5; tries++) expect((await guess()).status).toBe(400);
    expect((await guess()).status).toBe(429);
  });

  test("a new password takes back a reset link made before it", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const ed = await join(made, owner, "ed@example.com", "editor");
    const { token } = await (await owner.post(`${PEOPLE}/${ed.id}/reset-link`)).json();
    const changed = await ed.client.post("/api/auth/me/password", {
      password: NEW_PASSWORD,
      newPassword: ANOTHER_PASSWORD,
    });
    expect(changed.status).toBe(200);
    const late = await browser(made.app).post("/api/auth/reset", {
      token,
      password: GOOD_PASSWORD,
    });
    expect(late.status).toBe(404);
  });

  test("says whether a copy of its recovery codes was kept, and a new kit starts over", async () => {
    const made = await makeApp();
    const owner = browser(made.app);
    await owner.post("/api/auth/setup", { code: made.code, ...setupBody() });
    const saved = async () => (await (await owner.get("/api/auth/recovery-kit")).json()).saved;
    expect(await saved()).toBe(false);
    made.clock.time += 1000;
    expect((await owner.post("/api/auth/recovery-kit/saved")).status).toBe(204);
    expect(await saved()).toBe(true);
    made.clock.time += 1000;
    await owner.post("/api/auth/recovery-kit", { password: GOOD_PASSWORD });
    expect(await saved()).toBe(false);
  });
});

describe("tidying up", () => {
  test("removes sessions that have ended, and none that haven't", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const DAY = 24 * 60 * 60 * 1000;
    await signIn(made, OWNER_EMAIL, GOOD_PASSWORD);
    const count = () =>
      (made.db.prepare("SELECT count(*) AS n FROM sessions").get() as { n: number }).n;
    expect(count()).toBe(2);
    made.clock.time += 10 * DAY;
    expect(await isSignedIn(owner)).toBe(true);
    removeEndedSessions(made.orm, made.clock.time);
    expect(count()).toBe(2);
    // Two weeks without use ends one; using the other kept it.
    made.clock.time += 5 * DAY;
    removeEndedSessions(made.orm, made.clock.time);
    expect(count()).toBe(1);
    expect(await isSignedIn(owner)).toBe(true);
    made.clock.time += 61 * DAY;
    removeEndedSessions(made.orm, made.clock.time);
    expect(count()).toBe(0);
  });

  test("removes links and codes a month after they can't be used, and keeps the rest", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const DAY = 24 * 60 * 60 * 1000;
    const kinds = () =>
      (
        made.db
          .prepare("SELECT kind, count(*) AS n FROM tokens GROUP BY kind ORDER BY kind")
          .all() as { kind: string; n: number }[]
      ).map(({ kind, n }) => `${kind} ${n}`);
    await join(made, owner, "ed@example.com", "editor");
    await owner.post(`${PEOPLE}/invites`, { email: "late@example.com", role: "editor" });
    // The Owner's codes, Ed's, the invite Ed used, and one nobody has used yet.
    expect(kinds()).toEqual(["invite 2", "recovery 16"]);
    await owner.post("/api/auth/recovery-kit", { password: GOOD_PASSWORD });
    expect(kinds()).toEqual(["invite 2", "recovery 24"]);
    removeOldTokens(made.orm, made.clock.time + 29 * DAY);
    expect(kinds()).toEqual(["invite 2", "recovery 24"]);
    // The invite that was used and the codes that were replaced go, and then the other invite,
    // which ran out after a week. Codes that still work never go.
    removeOldTokens(made.orm, made.clock.time + 31 * DAY);
    expect(kinds()).toEqual(["invite 1", "recovery 16"]);
    removeOldTokens(made.orm, made.clock.time + 38 * DAY);
    expect(kinds()).toEqual(["recovery 16"]);
  });
});

describe("turning someone's access off", () => {
  test("signs them out, keeps them out, and is undone by letting them in again", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const ed = await join(made, owner, "ed@example.com", "editor");
    const { token } = await (await owner.post(`${PEOPLE}/${ed.id}/reset-link`)).json();
    const post = await (await ed.client.post("/api/admin/entries", { type: "post" })).json();

    const off = await owner.patch(`${PEOPLE}/${ed.id}`, { disabled: true });
    expect(await off.json()).toMatchObject({ disabled: true, role: "editor" });
    expect(await isSignedIn(ed.client)).toBe(false);
    expect(await isSignedIn(await signIn(made, "ed@example.com", NEW_PASSWORD))).toBe(false);
    const reset = await browser(made.app).post("/api/auth/reset", {
      token,
      password: GOOD_PASSWORD,
    });
    expect(reset.status).toBe(404);
    const link = await owner.post(`${PEOPLE}/${ed.id}/reset-link`);
    expect((await link.json()).error.code).toBe("kept_out");
    // What they wrote stays.
    expect((await owner.get(`/api/admin/entries/${post.id}`)).status).toBe(200);

    const on = await owner.patch(`${PEOPLE}/${ed.id}`, { disabled: false });
    expect(await on.json()).toMatchObject({ disabled: false });
    expect(await isSignedIn(ed.client)).toBe(false);
    expect(await isSignedIn(await signIn(made, "ed@example.com", NEW_PASSWORD))).toBe(true);
  });

  test("needs something to change, and the Owner can't be kept out", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const ed = await join(made, owner, "ed@example.com", "editor");
    expect((await owner.patch(`${PEOPLE}/${ed.id}`, {})).status).toBe(400);
    const self = await owner.patch(`${PEOPLE}/${await idOf(owner)}`, { disabled: true });
    expect(self.status).toBe(403);
    expect(await isSignedIn(owner)).toBe(true);
  });
});

describe("a new role", () => {
  test("ends sessions from before it, and takes back a reset link made under the old one", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const admin = await signedInAs(made, "admin");
    const ed = await join(made, owner, "ed@example.com", "editor");
    // An Admin may make a link for an Editor, but not for an Admin.
    const { token } = await (await admin.client.post(`${PEOPLE}/${ed.id}/reset-link`)).json();

    expect((await owner.patch(`${PEOPLE}/${ed.id}`, { role: "admin" })).status).toBe(200);
    expect(await isSignedIn(ed.client)).toBe(false);
    const late = await browser(made.app).post("/api/auth/reset", {
      token,
      password: GOOD_PASSWORD,
    });
    expect(late.status).toBe(404);
    const back = await signIn(made, "ed@example.com", NEW_PASSWORD);
    expect((await (await back.get("/api/auth/me")).json()).user.role).toBe("admin");
    // The same role again changes nothing, so nobody is signed out for it.
    await owner.patch(`${PEOPLE}/${ed.id}`, { role: "admin" });
    expect(await isSignedIn(back)).toBe(true);
  });
});

describe("handing the site over", () => {
  function handOver(by: Client, personId: string, password = GOOD_PASSWORD) {
    return by.post("/api/auth/transfer-ownership", { personId, password });
  }

  test("makes someone else the Owner, and whoever was stays an Admin", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const oldId = await idOf(owner);
    const ed = await join(made, owner, "ed@example.com", "editor");
    const admin = await signedInAs(made, "admin");
    const { token } = await (await admin.client.post(`${PEOPLE}/${ed.id}/reset-link`)).json();

    const wrong = await handOver(owner, ed.id, "not my password at all");
    expect((await wrong.json()).error).toMatchObject({ code: "password_wrong", field: "password" });
    expect((await handOver(owner, ed.id)).status).toBe(204);

    const now = await (await owner.get("/api/auth/me")).json();
    expect(now.user).toMatchObject({ role: "admin", isOwner: false });
    // They were an Editor, so they sign in again, as the Owner.
    expect(await isSignedIn(ed.client)).toBe(false);
    const newOwner = await signIn(made, "ed@example.com", NEW_PASSWORD);
    const them = await (await newOwner.get("/api/auth/me")).json();
    expect(them.user).toMatchObject({ role: "admin", isOwner: true });
    // A link an Admin made for them as an Editor is no way into the Owner's account.
    const late = await browser(made.app).post("/api/auth/reset", {
      token,
      password: GOOD_PASSWORD,
    });
    expect(late.status).toBe(404);
    // And it's theirs now: the old Owner can be changed, and can't hand it on.
    expect((await handOver(owner, admin.id)).status).toBe(403);
    expect((await newOwner.patch(`${PEOPLE}/${oldId}`, { role: "editor" })).status).toBe(200);
    expect(made.db.prepare("SELECT count(*) AS n FROM users WHERE is_owner = 1").get()).toEqual({
      n: 1,
    });
  });

  test("is only for the Owner, and only to someone who can sign in", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const ownerId = await idOf(owner);
    const admin = await signedInAs(made, "admin");
    const editor = await signedInAs(made, "editor");
    for (const client of [admin.client, editor.client, browser(made.app)]) {
      expect([401, 403]).toContain((await handOver(client, editor.id)).status);
    }
    await owner.patch(`${PEOPLE}/${editor.id}`, { disabled: true });
    for (const id of [editor.id, ownerId, "nobody"]) {
      const reply = await handOver(owner, id);
      expect(reply.status).toBe(409);
      expect((await reply.json()).error.code).toBe("cant_hand_over");
    }
    expect((await (await owner.get("/api/auth/me")).json()).user.isOwner).toBe(true);
  });
});
