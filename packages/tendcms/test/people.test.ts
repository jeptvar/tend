import { describe, expect, test } from "vitest";
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

// People and invites (PLAN.md J5), reset links and the recovery kit (J7).

const PEOPLE = "/api/admin/people";
const NEW_PASSWORD = "harbor-violet-pencil-meadow-sky";
const CODE = /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/;

type Client = ReturnType<typeof browser>;

async function invite(by: Client, email: string, role: string) {
  return by.post(`${PEOPLE}/invites`, { email, role });
}

/** Accepts an invite in a browser of its own, the way the person invited would. */
async function accept(made: MadeApp, token: string, password = NEW_PASSWORD) {
  const invitee = browser(made.app);
  const reply = await invitee.post("/api/auth/invite/accept", { token, name: "Ed Ward", password });
  return { invitee, reply };
}

async function signIn(made: MadeApp, email: string, password: string) {
  return browser(made.app).post("/api/auth/login", { email, password });
}

describe("inviting someone (J5)", () => {
  test("the Owner invites an Editor, who sets a password and gets a recovery kit", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const sent = await invite(owner, "Ed@Example.com", "editor");
    expect(sent.status).toBe(201);
    const { token, invite: pending } = await sent.json();
    expect(pending).toMatchObject({ email: "ed@example.com", role: "editor", canManage: true });

    const list = await (await owner.get(PEOPLE)).json();
    expect(list.people).toHaveLength(1);
    expect(list.people[0]).toMatchObject({ email: OWNER_EMAIL, isOwner: true, canManage: false });
    expect(list.invites).toEqual([
      expect.objectContaining({ id: pending.id, invitedBy: "Tom Baker" }),
    ]);

    // The link says who it's from and what it's for.
    const check = await browser(made.app).post("/api/auth/invite/check", { token });
    expect(await check.json()).toEqual({
      site: "Rise Bakery",
      email: "ed@example.com",
      role: "editor",
      invitedBy: "Tom Baker",
    });

    // A password that's too easy is refused, and the link still works afterwards.
    expect((await accept(made, token, "password1234")).reply.status).toBe(400);
    const { invitee, reply } = await accept(made, token);
    expect(reply.status).toBe(201);
    const accepted = await reply.json();
    expect(accepted.user).toMatchObject({ email: "ed@example.com", role: "editor" });
    expect(accepted.recoveryCodes).toHaveLength(8);
    for (const code of accepted.recoveryCodes) expect(code).toMatch(CODE);
    expect((await (await invitee.get("/api/auth/me")).json()).user.role).toBe("editor");
    expect((await invitee.get(PEOPLE)).status).toBe(403);

    // It works once.
    const again = await accept(made, token);
    expect(again.reply.status).toBe(404);
    expect((await again.reply.json()).error.code).toBe("invite_unknown");
    const after = await (await owner.get(PEOPLE)).json();
    expect(after.people.map((person: { email: string }) => person.email)).toEqual([
      OWNER_EMAIL,
      "ed@example.com",
    ]);
    expect(after.invites).toEqual([]);
  });

  test("a new invite takes the place of the last, and one can be taken back", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const first = (await (await invite(owner, "ed@example.com", "editor")).json()).token;
    const second = await (await invite(owner, "ed@example.com", "admin")).json();
    expect((await browser(made.app).post("/api/auth/invite/check", { token: first })).status).toBe(
      404,
    );
    expect((await owner.delete(`${PEOPLE}/invites/${second.invite.id}`)).status).toBe(204);
    const check = await browser(made.app).post("/api/auth/invite/check", { token: second.token });
    expect(check.status).toBe(404);
    // Nobody can be invited twice over, or invited when they're already here.
    const taken = await invite(owner, OWNER_EMAIL, "editor");
    expect(taken.status).toBe(409);
    expect((await taken.json()).error).toMatchObject({ code: "already_here", field: "email" });
  });

  test("runs out after a week", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const { token } = await (await invite(owner, "ed@example.com", "editor")).json();
    made.clock.time += 7 * 24 * 60 * 60 * 1000;
    expect((await accept(made, token)).reply.status).toBe(404);
  });
});

describe("who can act on whom", () => {
  test("Admins act only on Editors and Writers; nobody acts on the Owner", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const admin = await signedInAs(made, "admin");
    const editor = await signedInAs(made, "editor");
    const ownerId = (await (await owner.get("/api/auth/me")).json()).user.id;

    expect((await invite(admin.client, "new@example.com", "editor")).status).toBe(201);
    const asAdmin = await invite(admin.client, "boss@example.com", "admin");
    expect(asAdmin.status).toBe(403);
    expect((await asAdmin.json()).error.message).toBe("Only the Owner can do that for an Admin.");
    expect((await editor.client.get(PEOPLE)).status).toBe(403);

    const list = await (await admin.client.get(PEOPLE)).json();
    const canManage = Object.fromEntries(
      list.people.map((person: { role: string; isOwner: boolean; canManage: boolean }) => [
        person.isOwner ? "owner" : person.role,
        person.canManage,
      ]),
    );
    expect(canManage).toEqual({ owner: false, admin: false, editor: true });

    // An Admin can't touch the Owner or another Admin, or make someone an Admin.
    const role = (who: Client, id: string, to: string) =>
      who.patch(`${PEOPLE}/${id}`, { role: to });
    expect((await role(admin.client, ownerId, "editor")).status).toBe(403);
    expect((await role(admin.client, admin.id, "editor")).status).toBe(403);
    expect((await role(admin.client, editor.id, "admin")).status).toBe(403);
    expect((await role(admin.client, editor.id, "writer")).status).toBe(200);
    // The Owner can, but not on themselves.
    expect((await role(owner, editor.id, "admin")).status).toBe(200);
    expect((await role(owner, ownerId, "editor")).status).toBe(403);
    expect((await owner.post(`${PEOPLE}/${ownerId}/reset-link`)).status).toBe(403);
    expect((await owner.delete(`${PEOPLE}/${ownerId}`)).status).toBe(403);
  });

  test("someone removed is signed out at once, and what they wrote stays", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const editor = await signedInAs(made, "editor");
    const post = await (await editor.client.post("/api/admin/entries", { type: "post" })).json();
    expect((await owner.delete(`${PEOPLE}/${editor.id}`)).status).toBe(204);
    expect((await editor.client.get("/api/auth/me")).status).toBe(401);
    expect((await owner.get(`/api/admin/entries/${post.id}`)).status).toBe(200);
    expect((await owner.delete(`${PEOPLE}/${editor.id}`)).status).toBe(404);
  });
});

describe("a reset link (J7)", () => {
  test("lets someone choose a new password, once, and signs them out everywhere", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const { token } = await (await invite(owner, "ed@example.com", "editor")).json();
    const { invitee } = await accept(made, token);
    const edId = (await (await invitee.get("/api/auth/me")).json()).user.id;

    const sent = await owner.post(`${PEOPLE}/${edId}/reset-link`);
    expect(sent.status).toBe(201);
    const reset = await sent.json();
    const check = await browser(made.app).post("/api/auth/reset/check", { token: reset.token });
    expect(await check.json()).toEqual({
      email: "ed@example.com",
      name: "Ed Ward",
      site: "Rise Bakery",
    });

    const fresh = browser(made.app);
    const done = await fresh.post("/api/auth/reset", {
      token: reset.token,
      password: GOOD_PASSWORD,
    });
    expect(done.status).toBe(200);
    expect((await fresh.get("/api/auth/me")).status).toBe(200);
    expect((await invitee.get("/api/auth/me")).status).toBe(401);
    expect((await signIn(made, "ed@example.com", NEW_PASSWORD)).status).toBe(401);
    expect((await signIn(made, "ed@example.com", GOOD_PASSWORD)).status).toBe(200);
    const again = await browser(made.app).post("/api/auth/reset", {
      token: reset.token,
      password: GOOD_PASSWORD,
    });
    expect(again.status).toBe(404);
  });
});

describe("the recovery kit (J7)", () => {
  /** Sets the site up as the setup screens do, keeping the kit it ends with. */
  async function setUpWithKit(made: MadeApp) {
    const owner = browser(made.app);
    const reply = await owner.post("/api/auth/setup", { code: made.code, ...setupBody() });
    expect(reply.status).toBe(201);
    const { recoveryCodes } = await reply.json();
    return { owner, codes: recoveryCodes as string[] };
  }

  function recover(made: MadeApp, email: string, code: string) {
    return browser(made.app).post("/api/auth/recover", { email, code });
  }

  test("is made at setup, and a code from it gets the Owner back in, once", async () => {
    const made = await makeApp();
    const { owner, codes } = await setUpWithKit(made);
    expect(codes).toHaveLength(8);
    expect((await (await owner.get("/api/auth/recovery-kit")).json()).codesLeft).toBe(8);

    // Typed the way people do: lower case, with spaces, and O for 0.
    const typed = (codes[0] as string).toLowerCase().replace("-", " ").replaceAll("0", "o");
    const used = await recover(made, OWNER_EMAIL.toUpperCase(), typed);
    expect(used.status).toBe(200);
    const { token, codesLeft } = await used.json();
    expect(codesLeft).toBe(7);
    const fresh = browser(made.app);
    expect((await fresh.post("/api/auth/reset", { token, password: NEW_PASSWORD })).status).toBe(
      200,
    );
    expect((await owner.get("/api/auth/me")).status).toBe(401);
    expect((await signIn(made, OWNER_EMAIL, NEW_PASSWORD)).status).toBe(200);

    const twice = await recover(made, OWNER_EMAIL, codes[0] as string);
    expect(twice.status).toBe(401);
    expect((await twice.json()).error.code).toBe("recovery_failed");
  });

  test("a code only works with its own account's email", async () => {
    const made = await makeApp();
    const { owner, codes } = await setUpWithKit(made);
    const { token } = await (await invite(owner, "ed@example.com", "editor")).json();
    await accept(made, token);
    expect((await recover(made, "ed@example.com", codes[1] as string)).status).toBe(401);
    expect((await recover(made, "nobody@example.com", codes[1] as string)).status).toBe(401);
    expect((await recover(made, OWNER_EMAIL, codes[1] as string)).status).toBe(200);
  });

  test("a new kit needs the password, and the old codes stop working", async () => {
    const made = await makeApp();
    const { owner, codes } = await setUpWithKit(made);
    const wrong = await owner.post("/api/auth/recovery-kit", { password: NEW_PASSWORD });
    expect(wrong.status).toBe(400);
    expect((await wrong.json()).error).toMatchObject({ code: "password_wrong", field: "password" });

    const made2 = await owner.post("/api/auth/recovery-kit", { password: GOOD_PASSWORD });
    expect(made2.status).toBe(201);
    const fresh = (await made2.json()).codes as string[];
    expect(fresh).toHaveLength(8);
    expect(fresh).not.toContain(codes[2]);
    expect((await recover(made, OWNER_EMAIL, codes[2] as string)).status).toBe(401);
    expect((await recover(made, OWNER_EMAIL, fresh[0] as string)).status).toBe(200);
    const status = await (await owner.get("/api/auth/recovery-kit")).json();
    expect(status).toEqual({ codesLeft: 7, madeAt: made.clock.time });
  });
});
