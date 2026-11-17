import sharp from "sharp";
import { describe, expect, test } from "vitest";
import { createAdminRoutes } from "../src/api/admin/index.ts";
import type { RoutePolicy } from "../src/api/admin/routing.ts";
import { type Action, type Actor, can } from "../src/auth/policy.ts";
import { browser, makeApp, setUp, signedInAs } from "./auth-helpers.ts";

const ALL_ACTIONS: Action[] = [
  "entry:list",
  "entry:create",
  "entry:read",
  "entry:update",
  "entry:publish",
  "entry:trash",
  "entry:delete",
  "media:list",
  "media:upload",
  "media:update",
  "media:replace",
  "media:trash",
  "media:delete",
  "tag:list",
  "tag:create",
  "menu:manage",
  "design:manage",
  "settings:manage",
  "backup:download",
];
const ADMIN_ONLY: Action[] = ["entry:delete", "media:delete", "design:manage", "settings:manage"];
const OWNER_ONLY: Action[] = ["backup:download"];

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
    const forEveryone = (name: Action) => !ADMIN_ONLY.includes(name) && !OWNER_ONLY.includes(name);
    for (const action of ALL_ACTIONS.filter(forEveryone)) {
      expect(can(actor(role), action, { authorId: "someone-else" })).toBe(true);
      expect(can(actor(role), action, { authorId: "someone-else", type: "page" })).toBe(true);
    }
  });

  test("only the Owner can download a backup: it holds everyone's sign-in details", () => {
    for (const action of OWNER_ONLY) {
      expect(can({ id: "me", role: "admin", isOwner: 1 }, action)).toBe(true);
      expect(can(actor("admin"), action)).toBe(false);
      expect(can(actor("editor"), action)).toBe(false);
      expect(can(actor("writer"), action)).toBe(false);
    }
  });

  test("only an admin can delete forever, or change the design and settings", () => {
    for (const action of ADMIN_ONLY) {
      expect(can(actor("admin"), action, { authorId: "me" })).toBe(true);
      expect(can(actor("editor"), action, { authorId: "me" })).toBe(false);
      expect(can(actor("writer"), action, { authorId: "me" })).toBe(false);
    }
  });

  test("a writer can add pictures and describe their own, and nothing about the site", () => {
    const writer = actor("writer");
    expect(can(writer, "media:list")).toBe(true);
    expect(can(writer, "media:upload")).toBe(true);
    expect(can(writer, "media:update", { authorId: "me" })).toBe(true);
    expect(can(writer, "media:update", { authorId: "other" })).toBe(false);
    expect(can(writer, "media:replace", { authorId: "me" })).toBe(false);
    expect(can(writer, "media:trash", { authorId: "me" })).toBe(false);
    expect(can(writer, "menu:manage")).toBe(false);
    expect(can(writer, "tag:create")).toBe(false);
  });

  test("a writer can only work on their own posts, and can't publish", () => {
    const writer = actor("writer");
    expect(can(writer, "entry:list")).toBe(true);
    expect(can(writer, "entry:create")).toBe(true);
    expect(can(writer, "entry:create", { authorId: "me", type: "post" })).toBe(true);
    expect(can(writer, "entry:create", { authorId: "me", type: "page" })).toBe(false);
    expect(can(writer, "entry:read", { authorId: "me" })).toBe(true);
    expect(can(writer, "entry:update", { authorId: "me" })).toBe(true);
    expect(can(writer, "entry:update", { authorId: "me", type: "page" })).toBe(false);
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
    expect(can(actor("admin"), "billing:delete" as Action)).toBe(false);
    expect(can(actor("writer"), "billing:delete" as Action, { authorId: "me" })).toBe(false);
    expect(can(actor("superuser" as Actor["role"]), "entry:list")).toBe(false);
  });
});

/**
 * Who each route is for, written out by hand from PLAN.md §6 rather than read from the routes,
 * so a route guarded by the wrong action fails here.
 * - anyone: every account, Writers included.
 * - own: Writers only on their own posts and pictures; everyone else on anything.
 * - editors: Editors, Admins and the Owner.
 * - admins: Admins and the Owner.
 * - owner: the Owner alone.
 */
type Who = "anyone" | "own" | "editors" | "admins" | "owner";
const WHO: Record<string, Who> = {
  "GET /link-targets": "anyone",
  "GET /entries": "anyone",
  "POST /entries": "anyone",
  "GET /entries/:id": "own",
  "PATCH /entries/:id": "own",
  "POST /entries/:id/publish": "editors",
  "POST /entries/:id/unpublish": "editors",
  "POST /entries/:id/undo-unpublish": "editors",
  "POST /entries/:id/trash": "editors",
  "POST /entries/:id/restore": "editors",
  "POST /entries/:id/discard-changes": "editors",
  "POST /entries/:id/duplicate": "own",
  "DELETE /entries/:id": "admins",
  "GET /entries/:id/revisions": "own",
  "GET /revisions/:rid": "own",
  "POST /revisions/:rid/restore": "own",
  "GET /preview/:id": "own",
  "GET /media": "anyone",
  "POST /media": "anyone",
  "GET /media/:mid": "anyone",
  "PATCH /media/:mid": "own",
  "GET /media/:mid/usage": "anyone",
  "POST /media/:mid/replace": "editors",
  "POST /media/:mid/trash": "editors",
  "POST /media/:mid/restore": "editors",
  "DELETE /media/:mid": "admins",
  "GET /tags": "anyone",
  "POST /tags": "editors",
  "GET /settings/:key": "admins",
  "PUT /settings/:key": "admins",
  "POST /settings/:key/undo": "admins",
  "POST /address": "admins",
  "GET /menus": "editors",
  "PUT /menus/:name": "editors",
  "POST /menus/:name/undo": "editors",
  "GET /design": "admins",
  "PUT /design": "admins",
  "POST /design/undo": "admins",
  "POST /design/preview": "admins",
  "GET /redirects": "admins",
  "POST /redirects": "admins",
  "DELETE /redirects": "admins",
  "GET /backups": "admins",
  "GET /backups/download": "owner",
  "GET /people": "admins",
  "POST /people/invites": "admins",
  "DELETE /people/invites/:iid": "admins",
  "PATCH /people/:pid": "admins",
  "POST /people/:pid/reset-link": "admins",
  "DELETE /people/:pid": "admins",
};

const ROLES = ["writer", "editor", "admin", "owner"] as const;
type Role = (typeof ROLES)[number];

/** Whether the table lets this role act on a Writer's own row, or on someone else's. */
function allowed(who: Who, role: Role, writersOwn: boolean): boolean {
  switch (who) {
    case "anyone":
      return true;
    case "own":
      return role !== "writer" || writersOwn;
    case "editors":
      return role !== "writer";
    case "admins":
      return role === "admin" || role === "owner";
    case "owner":
      return role === "owner";
  }
}

function key(policy: RoutePolicy): string {
  return `${policy.method} ${policy.path}`;
}

describe("every admin route", () => {
  const options = {
    orm: undefined as never,
    store: undefined as never,
    secureCookies: false,
    onSiteChanged: () => {},
  };
  const { app, policies } = createAdminRoutes(options);

  test("has a stated permission: a new route without one fails this test", () => {
    const declared = new Set(policies.map(key));
    const actual = app.routes
      .filter((route) => route.method !== "ALL")
      .map((route) => `${route.method} ${route.path}`);
    expect(actual.length).toBeGreaterThan(0);
    for (const route of actual) expect(declared, route).toContain(route);
    expect(new Set(actual).size).toBe(declared.size);
  });

  test("is in the table of who it's for, and the table names no route that's gone", () => {
    expect(new Set(policies.map(key))).toEqual(new Set(Object.keys(WHO)));
  });

  test.each(policies.map((policy) => [key(policy), policy] as const))(
    "%s declares an action that lets in exactly who the table says",
    (name, policy) => {
      const who = WHO[name] as Who;
      for (const role of ROLES) {
        const me = {
          id: "me",
          role: role === "owner" ? "admin" : role,
          isOwner: role === "owner" ? 1 : 0,
        };
        for (const writersOwn of policy.subject === null ? [false] : [true, false]) {
          const subject =
            policy.subject === null
              ? undefined
              : {
                  authorId: writersOwn ? "me" : "someone-else",
                  ...(policy.subject === "media" ? {} : { type: "post" }),
                };
          const label = `${role}${writersOwn ? " on their own" : ""}`;
          expect(can(me, policy.action, subject), label).toBe(
            allowed(who, role, writersOwn && role === "writer"),
          );
        }
        // A page is never a Writer's, even one they wrote.
        if (policy.subject === "entry" || policy.subject === "revision") {
          expect(
            can(me, policy.action, { authorId: "me", type: "page" }),
            `${role} on a page`,
          ).toBe(allowed(who, role, false));
        }
      }
    },
  );

  /** A post or page with a version kept in History, and a picture: all a route can be about. */
  async function rowsOf(
    client: ReturnType<typeof browser>,
    picture: Buffer,
    type: "post" | "page" = "post",
  ) {
    const entry = await (await client.post("/api/admin/entries", { type })).json();
    const path = `/api/admin/entries/${entry.id}`;
    expect((await client.patch(path, { title: "Something" }, { "If-Match": "1" })).status).toBe(
      200,
    );
    // The second save keeps the first in History.
    expect(
      (await client.patch(path, { title: "Something else" }, { "If-Match": "2" })).status,
    ).toBe(200);
    const versions = await (await client.get(`${path}/revisions`)).json();
    expect(versions.revisions.length).toBeGreaterThan(0);
    const uploaded = await client.upload("/api/admin/media", picture, "dot.png");
    expect(uploaded.status).toBe(201);
    return {
      entryId: entry.id as string,
      revisionId: versions.revisions[0].id as string,
      mediaId: (await uploaded.json()).id as string,
    };
  }

  test.each(policies.map((policy) => [key(policy), policy] as const))(
    "%s answers every kind of person as the table says, on their own rows and others'",
    async (name, policy) => {
      const who = WHO[name] as Who;
      const made = await makeApp();
      const owner = await setUp(made);
      const writer = await signedInAs(made, "writer");
      const clients: Record<Role, ReturnType<typeof browser>> = {
        writer: writer.client,
        editor: (await signedInAs(made, "editor")).client,
        admin: (await signedInAs(made, "admin")).client,
        owner,
      };
      const picture = await sharp({
        create: { width: 8, height: 8, channels: 3, background: "#336699" },
      })
        .png()
        .toBuffer();
      const rows = {
        owners: await rowsOf(owner, picture),
        writers: await rowsOf(clients.writer, picture),
        // Written by the Writer, as if while they were an Editor: still not theirs to touch.
        writersPage: await rowsOf(owner, picture, "page"),
      };
      made.db
        .prepare("UPDATE entries SET author_id = ? WHERE id = ?")
        .run(writer.id, rows.writersPage.entryId);
      // The Owner's post is on the site, so publishing and unpublishing have something to do.
      const ownersPost = `/api/admin/entries/${rows.owners.entryId}`;
      const { rev } = await (await owner.get(ownersPost)).json();
      expect(
        (await owner.post(`${ownersPost}/publish`, {}, { "If-Match": String(rev) })).status,
      ).toBe(200);

      const isUpload = policy.method === "POST" && /^\/media(\/:mid\/replace)?$/.test(policy.path);
      async function request(client: ReturnType<typeof browser>, row: typeof rows.owners) {
        const path = policy.path
          .replace(":id", row.entryId)
          .replace(":rid", row.revisionId)
          .replace(":mid", row.mediaId)
          .replace(":key", "business")
          .replace(":name", "main");
        const query = policy.method === "GET" && policy.subject === null ? "?type=post" : "";
        const url = `/api/admin${path}${query}`;
        if (isUpload) return client.upload(url, picture, "dot.png");
        if (policy.method === "GET") {
          const reply = await client.get(url);
          // A download is read to its end, so the backup it started finishes.
          if (reply.headers.get("content-type") === "application/zip") await reply.bytes();
          return reply;
        }
        if (policy.method === "DELETE") return client.delete(url);
        // The newest version, so an action that's let through really runs.
        const current = await (await owner.get(`/api/admin/entries/${row.entryId}`)).json();
        const headers = { "If-Match": String(current.rev ?? 1) };
        if (policy.method === "PATCH") return client.patch(url, { title: "Edited" }, headers);
        if (policy.method === "PUT") return client.put(url, { items: [] }, headers);
        return client.post(url, { type: "post" }, headers);
      }

      expect((await request(browser(made.app), rows.owners)).status, "not signed in").toBe(401);
      const owners = { row: rows.owners, whose: "the Owner's", writersOwn: false };
      const passes =
        policy.subject === null
          ? [owners]
          : [
              owners,
              { row: rows.writers, whose: "the Writer's", writersOwn: true },
              // A page is never a Writer's, so their own is the same as someone else's.
              ...(policy.subject === "media"
                ? []
                : [{ row: rows.writersPage, whose: "the Writer's page", writersOwn: false }]),
            ];
      // Least allowed first, so nobody's refusal is hidden by someone else's change.
      for (const { row, whose, writersOwn } of passes) {
        for (const role of ROLES) {
          const label = `${role} on ${whose}`;
          const { status } = await request(clients[role], row);
          expect(status, label).not.toBe(401);
          if (allowed(who, role, writersOwn && role === "writer")) {
            expect(status, label).not.toBe(403);
          } else {
            expect(status, label).toBe(403);
          }
        }
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

describe("an editor in practice", () => {
  test("can change the menu, but not the design or settings", async () => {
    const made = await makeApp();
    await setUp(made);
    const { client: editor } = await signedInAs(made, "editor");

    expect((await editor.get("/api/admin/menus")).status).toBe(200);
    expect((await editor.put("/api/admin/menus/footer", { items: [] })).status).toBe(200);

    expect((await editor.get("/api/admin/design")).status).toBe(403);
    const design = await editor.put("/api/admin/design", { theme: {} });
    expect(design.status).toBe(403);
    expect((await editor.get("/api/admin/settings/general")).status).toBe(403);
    const settings = await editor.put("/api/admin/settings/general", { name: "Taken over" });
    expect(settings.status).toBe(403);
    expect((await settings.json()).error.fix).toBe("Ask whoever runs this site.");
  });
});
