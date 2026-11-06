import { describe, expect, test } from "vitest";
import { createAdminRoutes } from "../src/api/admin/entries.ts";
import { type Action, type Actor, can } from "../src/auth/policy.ts";
import { createSessionIfPasswordUnchanged } from "../src/db/repo/sessions.ts";
import { uuidv7 } from "../src/ids.ts";
import { browser, type MadeApp, makeApp, setUp } from "./auth-helpers.ts";

const ALL_ACTIONS: Action[] = [
  "entry:list",
  "entry:create",
  "entry:read",
  "entry:update",
  "entry:publish",
  "entry:trash",
];

function actor(role: Actor["role"], id = "me"): Actor {
  return { id, role, isOwner: 0 };
}

describe("can", () => {
  test("nobody can do anything without an account", () => {
    for (const action of ALL_ACTIONS) {
      expect(can(null, action)).toBe(false);
      expect(can(undefined, action, { authorId: null })).toBe(false);
    }
  });

  test.each(["admin", "editor"] as const)("%s can work on any content", (role) => {
    for (const action of ALL_ACTIONS) {
      expect(can(actor(role), action, { authorId: "someone-else" })).toBe(true);
    }
  });

  test("a writer can only work on their own, and can't publish", () => {
    const writer = actor("writer");
    expect(can(writer, "entry:list")).toBe(true);
    expect(can(writer, "entry:create")).toBe(true);
    expect(can(writer, "entry:read", { authorId: "me" })).toBe(true);
    expect(can(writer, "entry:update", { authorId: "me" })).toBe(true);
    expect(can(writer, "entry:read", { authorId: "other" })).toBe(false);
    expect(can(writer, "entry:update", { authorId: "other" })).toBe(false);
    expect(can(writer, "entry:publish", { authorId: "me" })).toBe(false);
    expect(can(writer, "entry:trash", { authorId: "me" })).toBe(false);
  });

  test("a writer can't work on something when it isn't known whose it is", () => {
    expect(can(actor("writer"), "entry:read")).toBe(false);
    expect(can(actor("writer"), "entry:update", { authorId: null })).toBe(false);
  });

  test("deny is the default: unknown roles and actions are refused", () => {
    expect(can(actor("admin"), "people:delete" as Action)).toBe(false);
    expect(can(actor("writer"), "people:delete" as Action, { authorId: "me" })).toBe(false);
    expect(can(actor("superuser" as Actor["role"]), "entry:list")).toBe(false);
  });
});

/** Adds someone with a role directly, and returns a browser signed in as them. */
async function signedInAs(made: MadeApp, role: Actor["role"]) {
  const id = uuidv7(made.clock.time);
  const hash = `hash-${id}`;
  made.db
    .prepare(
      "INSERT INTO users (id, email, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(id, `${role}@example.com`, role, role, hash, made.clock.time);
  const token = await createSessionIfPasswordUnchanged(made.orm, {
    userId: id,
    verifiedHash: hash,
    userAgent: null,
    ipPrefix: null,
    now: made.clock.time,
  });
  const client = browser(made.app);
  client.jar.set("tend_session", token as string);
  return { client, id };
}

describe("every admin route", () => {
  const options = {
    orm: undefined as never,
    secureCookies: false,
    onSiteChanged: () => {},
  };
  const { app, policies } = createAdminRoutes(options);

  test("has a stated permission: a new route without one fails this test", () => {
    const declared = new Set(policies.map((policy) => `${policy.method} ${policy.path}`));
    const actual = app.routes
      .filter((route) => route.method !== "ALL")
      .map((route) => `${route.method} ${route.path}`);
    expect(actual.length).toBeGreaterThan(0);
    for (const route of actual) expect(declared, route).toContain(route);
    expect(new Set(actual).size).toBe(declared.size);
  });

  test.each(policies.map((policy) => [`${policy.method} ${policy.path}`, policy] as const))(
    "%s follows the policy for every kind of person",
    async (_, policy) => {
      const made = await makeApp();
      const owner = await setUp(made);
      const created = await (await owner.post("/api/admin/entries", { type: "post" })).json();
      const url = `/api/admin${policy.path.replace(":id", created.id)}${
        policy.method === "GET" && !policy.hasSubject ? "?type=post" : ""
      }`;
      const request = (client: ReturnType<typeof browser>) => {
        if (policy.method === "GET") return client.get(url);
        const headers = { "If-Match": String(created.rev) };
        if (policy.method === "PATCH") return client.patch(url, { title: "Edited" }, headers);
        return client.post(url, { type: "post" }, headers);
      };

      expect((await request(browser(made.app))).status, "not signed in").toBe(401);

      for (const role of ["writer", "editor", "admin"] as const) {
        const { client, id } = await signedInAs(made, role);
        const allowed = can(
          { id, role, isOwner: 0 },
          policy.action,
          policy.hasSubject ? { authorId: created.authorId ?? "the-owner" } : undefined,
        );
        const { status } = await request(client);
        if (allowed) expect(status, role).not.toBe(403);
        else expect(status, role).toBe(403);
        expect(status, role).not.toBe(401);
      }
    },
  );
});

describe("a writer in practice", () => {
  test("sees and edits only their own, and can't publish", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const ownersPost = await (await owner.post("/api/admin/entries", { type: "post" })).json();
    const { client: writer } = await signedInAs(made, "writer");

    const mine = await (await writer.post("/api/admin/entries", { type: "post" })).json();
    const edit = await writer.patch(
      `/api/admin/entries/${mine.id}`,
      { title: "Mine" },
      { "If-Match": "1" },
    );
    expect(edit.status).toBe(200);
    await owner.patch(
      `/api/admin/entries/${ownersPost.id}`,
      { title: "The owner's" },
      { "If-Match": "1" },
    );
    const list = await (await writer.get("/api/admin/entries?type=post")).json();
    expect(list.entries.map((entry: { id: string }) => entry.id)).toEqual([mine.id]);

    expect((await writer.get(`/api/admin/entries/${ownersPost.id}`)).status).toBe(403);
    const publish = await writer.post(
      `/api/admin/entries/${mine.id}/publish`,
      {},
      { "If-Match": "2" },
    );
    expect(publish.status).toBe(403);
  });
});
