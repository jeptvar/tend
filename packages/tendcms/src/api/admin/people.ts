import { asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { type Actor, canManagePerson } from "../../auth/policy.ts";
import {
  createInvite,
  createResetLink,
  findUsableToken,
  pendingInvites,
  RESET_LINK_MS,
  type Role,
  revokeToken,
  type Token,
} from "../../db/repo/tokens.ts";
import { findUserByEmail, type User } from "../../db/repo/users.ts";
import { users } from "../../db/schema.ts";
import { ApiError } from "../errors.ts";
import { type AdminOptions, parseBody, type Routing, readJson } from "./routing.ts";

// People (PLAN.md J5 and §9): who can sign in to this site, and inviting someone new. The
// Owner can act on anyone; Admins only on Editors and Writers (canManagePerson). Nobody
// changes, resets or removes the Owner from here.

const ROLES = ["admin", "editor", "writer"] as const;

const inviteSchema = z.object({
  email: z
    .string({ error: "Type their email address." })
    .trim()
    .toLowerCase()
    .min(1, "Type their email address.")
    .max(254, "That email address is too long.")
    .pipe(
      z.email("That doesn't look like an email address. It should look like name@example.com."),
    ),
  role: z.enum(ROLES, { error: "Choose what they can do." }),
});

const roleSchema = z.object({
  role: z.enum(ROLES, { error: "Choose what they can do." }),
});

function personJson(person: User, actor: Actor) {
  return {
    id: person.id,
    name: person.name,
    email: person.email,
    role: person.role,
    isOwner: person.isOwner === 1,
    lastSeenAt: person.lastSeenAt,
    createdAt: person.createdAt,
    canManage: canManagePerson(actor, person),
  };
}

function inviteJson(invite: Token & { invitedBy?: string | null }, actor: Actor) {
  const role = invite.role as Role;
  return {
    id: invite.id,
    email: invite.email,
    role,
    invitedBy: invite.invitedBy ?? null,
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt,
    canManage: canManagePerson(actor, { role, isOwner: false }),
  };
}

function notYours(role: Role): ApiError {
  return new ApiError(403, "not_allowed", "Only the Owner can do that for an Admin.", {
    fix: role === "admin" ? "Choose Editor instead, or ask the Owner." : "Ask the Owner.",
  });
}

function theOwner(): ApiError {
  return new ApiError(403, "not_allowed", "The Owner can't be changed from here.", {
    fix: "If the Owner is locked out, they can use a recovery code, or run npx tendcms reset-password on the server.",
  });
}

function noOne(): ApiError {
  return new ApiError(404, "not_found", "There's no one by that name here any more.", {
    fix: "Reload this page.",
  });
}

export function registerPeopleRoutes(routing: Routing, options: AdminOptions): void {
  const { orm } = options;
  const { now, route } = routing;

  function personOr404(id: string): User {
    const person = orm.select().from(users).where(eq(users.id, id)).get();
    if (!person) throw noOne();
    return person;
  }

  /** The person, if this actor may act on them. */
  function manageable(actor: Actor, id: string): User {
    const person = personOr404(id);
    if (person.isOwner) throw theOwner();
    if (!canManagePerson(actor, person)) throw notYours(person.role);
    return person;
  }

  route("get", "/people", "people:manage", async (c, user) => {
    const people = orm
      .select()
      .from(users)
      .orderBy(desc(users.isOwner), asc(users.name), asc(users.email))
      .all();
    return c.json({
      people: people.map((person) => personJson(person, user)),
      invites: pendingInvites(orm, now()).map((invite) => inviteJson(invite, user)),
    });
  });

  // The link is made here once and kept only as a hash, so it can't be shown again later.
  // A new invite for the same email replaces the old one.
  route("post", "/people/invites", "people:manage", async (c, user) => {
    const { email, role } = parseBody(inviteSchema, await readJson(c));
    if (!canManagePerson(user, { role, isOwner: false })) throw notYours(role);
    if (await findUserByEmail(orm, email)) {
      throw new ApiError(409, "already_here", "Someone with that email can already sign in here.", {
        field: "email",
        fix: "If they've forgotten their password, send them a reset link from their row.",
      });
    }
    const { token, invite } = createInvite(orm, { email, role, createdBy: user.id, now: now() });
    return c.json({ invite: inviteJson({ ...invite, invitedBy: user.name }, user), token }, 201);
  });

  route("delete", "/people/invites/:iid", "people:manage", async (c, user) => {
    const invite = findUsableToken(orm, "invite", c.req.param("iid") ?? "", now());
    // Accepted, taken back or out of date already: either way it can't be used now.
    if (!invite) return c.body(null, 204);
    const role = invite.role as Role;
    if (!canManagePerson(user, { role, isOwner: false })) throw notYours(role);
    revokeToken(orm, invite.id, now());
    return c.body(null, 204);
  });

  route("patch", "/people/:pid", "people:manage", async (c, user) => {
    const { role } = parseBody(roleSchema, await readJson(c));
    const person = manageable(user, c.req.param("pid") ?? "");
    if (!canManagePerson(user, { role, isOwner: false })) throw notYours(role);
    // Permissions are read from this row at every request, so the change applies at once.
    const changed = orm
      .update(users)
      .set({ role })
      .where(eq(users.id, person.id))
      .returning()
      .get();
    if (!changed) throw noOne();
    return c.json(personJson(changed, user));
  });

  // For someone who's forgotten their password: the link goes to them however suits, and
  // lets them choose a new one. It takes the place of any earlier link.
  route("post", "/people/:pid/reset-link", "people:manage", async (c, user) => {
    const person = manageable(user, c.req.param("pid") ?? "");
    const { token, expiresAt } = createResetLink(orm, {
      userId: person.id,
      createdBy: user.id,
      now: now(),
      lastsMs: RESET_LINK_MS,
    });
    return c.json({ token, expiresAt }, 201);
  });

  // Their sessions, reset links and recovery codes go with them. What they wrote stays.
  route("delete", "/people/:pid", "people:manage", async (c, user) => {
    const person = manageable(user, c.req.param("pid") ?? "");
    orm.delete(users).where(eq(users.id, person.id)).run();
    return c.body(null, 204);
  });
}
