import { describe, expect, test } from "vitest";
import { cleanUp, KEEP_DAYS } from "../src/content/entries.ts";
import { createSessionIfPasswordUnchanged } from "../src/db/repo/sessions.ts";
import { uuidv7 } from "../src/ids.ts";
import { browser, type MadeApp, makeApp, setUp } from "./auth-helpers.ts";

const ENTRIES = "/api/admin/entries";
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

function doc(words: string) {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: words }] }],
  };
}

function bodyOf(detail: { data: { doc: { content: { content?: { text: string }[] }[] } } }) {
  return detail.data.doc.content[0]?.content?.[0]?.text;
}

function linkTo(id: string, words = "see this") {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: words, marks: [{ type: "link", attrs: { href: `entry:${id}` } }] },
        ],
      },
    ],
  };
}

type Client = Awaited<ReturnType<typeof setUp>>;

async function signedIn(): Promise<{ made: MadeApp; owner: Client }> {
  const made = await makeApp();
  const owner = await setUp(made);
  return { made, owner };
}

async function newEntry(owner: Client, type = "post") {
  return (await owner.post(ENTRIES, { type })).json();
}

async function save(owner: Client, id: string, rev: number, body: unknown) {
  const reply = await owner.patch(`${ENTRIES}/${id}`, body, { "If-Match": String(rev) });
  expect(reply.status).toBe(200);
  return reply.json();
}

async function publish(owner: Client, id: string, rev: number) {
  const reply = await owner.post(`${ENTRIES}/${id}/publish`, {}, { "If-Match": String(rev) });
  expect(reply.status).toBe(200);
  return reply.json();
}

/** A post that's on the site, ready for further edits. */
async function livePost(owner: Client, title = "Live", words = "Live words") {
  const entry = await newEntry(owner);
  await save(owner, entry.id, 1, { title, doc: doc(words) });
  return publish(owner, entry.id, 2);
}

async function versions(owner: Client, id: string) {
  const reply = await owner.get(`${ENTRIES}/${id}/revisions`);
  expect(reply.status).toBe(200);
  return (await reply.json()).revisions as {
    id: string;
    kind: string;
    title: string;
    authorName: string | null;
    createdAt: number;
    isLive: boolean;
  }[];
}

async function signedInAs(made: MadeApp, role: "writer" | "editor" | "admin", name: string) {
  const id = uuidv7(made.clock.time);
  const hash = `hash-${id}`;
  made.db
    .prepare(
      "INSERT INTO users (id, email, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(id, `${id}@example.com`, name, role, hash, made.clock.time);
  const token = await createSessionIfPasswordUnchanged(made.orm, {
    userId: id,
    verifiedHash: hash,
    userAgent: null,
    ipPrefix: null,
    now: made.clock.time,
  });
  const client = browser(made.app);
  client.jar.set("tend_session", token as string);
  return client;
}

async function pageText(made: MadeApp, path: string): Promise<string> {
  return (await made.app.request(path)).text();
}

describe("sections", () => {
  const withSection = {
    type: "doc",
    content: [
      {
        type: "section",
        attrs: { kind: "intro" },
        content: [{ type: "paragraph", content: [{ type: "text", text: "Hi" }] }],
      },
    ],
  };

  test("a page can have them", async () => {
    const { owner } = await signedIn();
    const page = await newEntry(owner, "page");
    const saved = await save(owner, page.id, 1, { doc: withSection });
    expect(saved.data.doc.content[0].type).toBe("section");
  });

  test("a post can't, and the save says what to do about it", async () => {
    const { owner } = await signedIn();
    const post = await newEntry(owner);
    const reply = await owner.patch(
      `${ENTRIES}/${post.id}`,
      { doc: withSection },
      { "If-Match": "1" },
    );
    expect(reply.status).toBe(400);
    const { error } = await reply.json();
    expect(error.field).toBe("doc");
    expect(error.fix).toBeTruthy();
  });
});

describe("saving as you type", () => {
  test("keeps at most one automatic version per ten minutes", async () => {
    const { made, owner } = await signedIn();
    const entry = await newEntry(owner);
    await save(owner, entry.id, 1, { title: "One", doc: doc("one") });
    expect(await versions(owner, entry.id)).toEqual([]);

    made.clock.time += MINUTE;
    await save(owner, entry.id, 2, { doc: doc("two") });
    const first = await versions(owner, entry.id);
    expect(first.map((version) => version.kind)).toEqual(["autosave"]);

    made.clock.time += MINUTE;
    await save(owner, entry.id, 3, { doc: doc("three") });
    expect(await versions(owner, entry.id)).toHaveLength(1);

    made.clock.time += 10 * MINUTE;
    await save(owner, entry.id, 4, { doc: doc("four") });
    expect(await versions(owner, entry.id)).toHaveLength(2);
  });

  test("an automatic version holds what was there before, not what's being typed", async () => {
    const { made, owner } = await signedIn();
    const entry = await newEntry(owner);
    await save(owner, entry.id, 1, { title: "One", doc: doc("older") });
    made.clock.time += MINUTE;
    await save(owner, entry.id, 2, { doc: doc("newer") });
    const [version] = await versions(owner, entry.id);
    const kept = await (await owner.get(`/api/admin/revisions/${version?.id}`)).json();
    expect(kept.data.doc).toEqual(doc("older"));
  });

  test("this window's own earlier save is never a conflict, even if its answer got lost", async () => {
    const { owner } = await signedIn();
    const entry = await newEntry(owner);
    const editSession = "window-one";
    await save(owner, entry.id, 1, { title: "A", doc: doc("a"), editSession });
    // The answer to that never arrived, so this window still thinks it's on version 1.
    const later = await save(owner, entry.id, 1, { doc: doc("a and more"), editSession });
    expect(later.rev).toBe(3);
    expect(later.data.doc).toEqual(doc("a and more"));
    expect((await versions(owner, entry.id)).map((version) => version.kind)).not.toContain(
      "conflict",
    );
  });

  test("a late, older request from this window can't undo a newer one", async () => {
    const { owner } = await signedIn();
    const entry = await newEntry(owner);
    const editSession = "window-one";
    await save(owner, entry.id, 1, { title: "A", doc: doc("start"), editSession, editSeq: 1 });
    // Request 2 was held up somewhere. Request 3 was sent after it, and got there first.
    await save(owner, entry.id, 2, { doc: doc("NEWER words"), editSession, editSeq: 3 });
    const late = await owner.patch(
      `${ENTRIES}/${entry.id}`,
      { doc: doc("older words"), editSession, editSeq: 2 },
      { "If-Match": "2" },
    );
    expect(late.status).toBe(409);
    const current = await (await owner.get(`${ENTRIES}/${entry.id}`)).json();
    expect(current.data.doc).toEqual(doc("NEWER words"));
  });

  test("the same goes for an action, like Discard, held up on the way", async () => {
    const { owner } = await signedIn();
    const live = await livePost(owner);
    const editSession = "window-one";
    await save(owner, live.id, live.rev, { doc: doc("Mine"), editSession, editSeq: 5 });
    const late = await owner.post(
      `${ENTRIES}/${live.id}/discard-changes`,
      { editSession, editSeq: 4 },
      { "If-Match": String(live.rev) },
    );
    expect(late.status).toBe(409);
  });

  test("another window's save is still a conflict, and the loser is kept", async () => {
    const { owner } = await signedIn();
    const entry = await newEntry(owner);
    await save(owner, entry.id, 1, { title: "A", doc: doc("mine"), editSession: "one" });
    await save(owner, entry.id, 2, { doc: doc("theirs"), editSession: "two" });
    const reply = await owner.patch(
      `${ENTRIES}/${entry.id}`,
      { doc: doc("mine, more"), editSession: "one" },
      { "If-Match": "2" },
    );
    expect(reply.status).toBe(409);
    const kept = await versions(owner, entry.id);
    expect(kept.map((version) => version.kind)).toContain("conflict");
  });

  test("a publish from elsewhere means this window has to catch up", async () => {
    const { owner } = await signedIn();
    const entry = await newEntry(owner);
    await save(owner, entry.id, 1, { title: "A", doc: doc("a"), editSession: "one" });
    await publish(owner, entry.id, 2);
    const reply = await owner.patch(
      `${ENTRIES}/${entry.id}`,
      { doc: doc("stale"), editSession: "one" },
      { "If-Match": "2" },
    );
    expect(reply.status).toBe(409);
  });

  test("a conflict says who changed it", async () => {
    const { made, owner } = await signedIn();
    const entry = await newEntry(owner);
    const sam = await signedInAs(made, "editor", "Sam");
    await save(sam, entry.id, 1, { title: "Sam's", doc: doc("Sam's") });
    const reply = await owner.patch(
      `${ENTRIES}/${entry.id}`,
      { doc: doc("mine") },
      { "If-Match": "1" },
    );
    expect(reply.status).toBe(409);
    const { current } = await reply.json();
    expect(current.updatedBy.name).toBe("Sam");
    expect(current.title).toBe("Sam's");
  });

  test("typing your way back to what's on the site clears the pending changes", async () => {
    const { owner } = await signedIn();
    const live = await livePost(owner);
    const changed = await save(owner, live.id, live.rev, { doc: doc("Different") });
    expect(changed.dirty).toBe(true);
    const back = await save(owner, live.id, changed.rev, { doc: doc("Live words") });
    expect(back.dirty).toBe(false);
  });

  test("warns about an address someone else has, without stopping the save", async () => {
    const { owner } = await signedIn();
    await livePost(owner, "Taken");
    const entry = await newEntry(owner);
    const saved = await save(owner, entry.id, 1, { title: "Taken", doc: doc("Words") });
    expect(saved.data.doc).toEqual(doc("Words"));
    expect(saved.address.path).toBe("/blog/taken");
    expect(saved.address.problem.message).toContain("/blog/taken");
    const fine = await save(owner, entry.id, 2, { slug: "taken-too" });
    expect(fine.address).toEqual({ path: "/blog/taken-too", problem: null });
  });
});

describe("two windows, or two people", () => {
  test("taking over from another window keeps its words, however recently a version was kept", async () => {
    const { made, owner } = await signedIn();
    const entry = await newEntry(owner);
    await save(owner, entry.id, 1, { title: "A", doc: doc("first"), editSession: "one" });
    await save(owner, entry.id, 2, { doc: doc("second"), editSession: "one" });
    made.clock.time += MINUTE;
    await save(owner, entry.id, 3, { doc: doc("mine, last"), editSession: "one" });
    // One automatic version is under ten minutes old, but these words are about to vanish.
    await save(owner, entry.id, 4, { doc: doc("theirs"), editSession: "two" });
    const kept = await versions(owner, entry.id);
    const contents = await Promise.all(
      kept.map(async (version) => {
        const detail = await (await owner.get(`/api/admin/revisions/${version.id}`)).json();
        return bodyOf(detail);
      }),
    );
    expect(contents).toContain("mine, last");
  });

  test("another person saving also keeps what was there", async () => {
    const { made, owner } = await signedIn();
    const entry = await newEntry(owner);
    await save(owner, entry.id, 1, { title: "A", doc: doc("first") });
    await save(owner, entry.id, 2, { doc: doc("second") });
    await save(owner, entry.id, 3, { doc: doc("the owner's") });
    const sam = await signedInAs(made, "editor", "Sam");
    await save(sam, entry.id, 4, { doc: doc("Sam's") });
    const kept = await versions(owner, entry.id);
    const contents = await Promise.all(
      kept.map(async (version) =>
        bodyOf(await (await owner.get(`/api/admin/revisions/${version.id}`)).json()),
      ),
    );
    expect(contents).toContain("the owner's");
  });

  test("this window's own publish, with the answer lost, isn't a conflict either", async () => {
    const { owner } = await signedIn();
    const entry = await newEntry(owner);
    const editSession = "window-one";
    await save(owner, entry.id, 1, { title: "A", doc: doc("a"), editSession });
    const first = await owner.post(
      `${ENTRIES}/${entry.id}/publish`,
      { editSession },
      { "If-Match": "2" },
    );
    expect(first.status).toBe(200);
    // That answer never arrived, so this window still thinks it's on version 2.
    const later = await save(owner, entry.id, 2, { doc: doc("more"), editSession });
    expect(later.data.doc).toEqual(doc("more"));
    const again = await owner.post(
      `${ENTRIES}/${entry.id}/publish`,
      { editSession },
      { "If-Match": "2" },
    );
    expect(again.status).toBe(200);
  });

  test("somebody else's publish still stops this window from publishing blind", async () => {
    const { owner } = await signedIn();
    const entry = await newEntry(owner);
    await save(owner, entry.id, 1, { title: "A", doc: doc("a"), editSession: "one" });
    await owner.post(`${ENTRIES}/${entry.id}/publish`, { editSession: "two" }, { "If-Match": "2" });
    const reply = await owner.post(
      `${ENTRIES}/${entry.id}/publish`,
      { editSession: "one" },
      { "If-Match": "2" },
    );
    expect(reply.status).toBe(409);
  });

  test.each(["unpublish", "trash"])(
    "%s records who did it, for the conflict screen",
    async (action) => {
      const { made, owner } = await signedIn();
      const live = await livePost(owner);
      const sam = await signedInAs(made, "editor", "Sam");
      const reply = await sam.post(
        `${ENTRIES}/${live.id}/${action}`,
        {},
        { "If-Match": String(live.rev) },
      );
      expect(reply.status).toBe(200);
      const stale = await owner.patch(
        `${ENTRIES}/${live.id}`,
        { doc: doc("Stale") },
        { "If-Match": String(live.rev) },
      );
      expect(stale.status).toBe(409);
      expect((await stale.json()).current.updatedBy.name).toBe("Sam");
    },
  );

  test("restoring from the Trash records who did it too", async () => {
    const { made, owner } = await signedIn();
    const entry = await newEntry(owner);
    await save(owner, entry.id, 1, { title: "A" });
    await owner.post(`${ENTRIES}/${entry.id}/trash`);
    const sam = await signedInAs(made, "editor", "Sam");
    const restored = await (await sam.post(`${ENTRIES}/${entry.id}/restore`)).json();
    expect(restored.updatedBy.name).toBe("Sam");
  });
});

describe("undoing Unpublish", () => {
  async function unpublish(owner: Client, id: string, rev: number) {
    const reply = await owner.post(`${ENTRIES}/${id}/unpublish`, {}, { "If-Match": String(rev) });
    expect(reply.status).toBe(200);
    return reply.json();
  }

  test("asking twice, after the first answer got lost, still offers the Undo", async () => {
    const { owner } = await signedIn();
    const live = await livePost(owner);
    const editSession = "window-one";
    const first = await owner.post(
      `${ENTRIES}/${live.id}/unpublish`,
      { editSession },
      { "If-Match": String(live.rev) },
    );
    const firstReply = await first.json();
    const again = await owner.post(
      `${ENTRIES}/${live.id}/unpublish`,
      { editSession },
      { "If-Match": String(live.rev) },
    );
    expect(again.status).toBe(200);
    expect((await again.json()).wasLiveRevisionId).toBe(firstReply.wasLiveRevisionId);
  });

  test("an old Undo can't replace something published since", async () => {
    const { made, owner } = await signedIn();
    const live = await livePost(owner, "Stale undo", "First words");
    const off = await unpublish(owner, live.id, live.rev);
    const edited = await save(owner, live.id, off.rev, { slug: "new-address", doc: doc("Second") });
    const again = await publish(owner, live.id, edited.rev);
    const reply = await owner.post(
      `${ENTRIES}/${live.id}/undo-unpublish`,
      { revisionId: off.wasLiveRevisionId },
      { "If-Match": String(again.rev) },
    );
    expect(reply.status).toBe(409);
    expect((await reply.json()).error.code).toBe("already_on_site");
    expect(await pageText(made, "/blog/new-address")).toContain("Second");
  });

  test("puts back the version that was live, not whatever's being worked on", async () => {
    const { made, owner } = await signedIn();
    const live = await livePost(owner, "Prices", "Old prices");
    const edited = await save(owner, live.id, live.rev, {
      slug: "prices-new",
      doc: doc("Unreviewed prices"),
    });
    const off = await unpublish(owner, live.id, edited.rev);
    expect(off.wasLiveRevisionId).toBeTruthy();
    expect((await made.app.request("/blog/prices")).status).toBe(404);

    const reply = await owner.post(
      `${ENTRIES}/${live.id}/undo-unpublish`,
      { revisionId: off.wasLiveRevisionId },
      { "If-Match": String(off.rev) },
    );
    expect(reply.status).toBe(200);
    const back = await reply.json();
    expect(back.url).toBe("/blog/prices");
    expect(back.dirty).toBe(true);
    expect(back.data.doc).toEqual(doc("Unreviewed prices"));
    const html = await pageText(made, "/blog/prices");
    expect(html).toContain("Old prices");
    expect(html).not.toContain("Unreviewed");
    expect((await made.app.request("/blog/prices-new")).status).toBe(404);
  });

  test("with nothing pending, nothing's pending afterwards", async () => {
    const { owner } = await signedIn();
    const live = await livePost(owner);
    const off = await unpublish(owner, live.id, live.rev);
    const back = await (
      await owner.post(
        `${ENTRIES}/${live.id}/undo-unpublish`,
        { revisionId: off.wasLiveRevisionId },
        { "If-Match": String(off.rev) },
      )
    ).json();
    expect(back.dirty).toBe(false);
  });

  test("the links it holds go back on the record", async () => {
    const { made, owner } = await signedIn();
    const target = await livePost(owner, "Target");
    const linker = await newEntry(owner);
    await save(owner, linker.id, 1, { title: "Linker", doc: linkTo(target.id) });
    const live = await publish(owner, linker.id, 2);
    const off = await unpublish(owner, live.id, live.rev);
    await owner.post(
      `${ENTRIES}/${live.id}/undo-unpublish`,
      { revisionId: off.wasLiveRevisionId },
      { "If-Match": String(off.rev) },
    );
    expect(
      made.db.prepare("SELECT scope FROM refs WHERE entry_id = ? AND scope = 'live'").all(live.id),
    ).toEqual([{ scope: "live" }]);
  });

  test("won't take an address someone else has since taken", async () => {
    const { owner } = await signedIn();
    const live = await livePost(owner, "Same");
    const off = await unpublish(owner, live.id, live.rev);
    await livePost(owner, "Same");
    const reply = await owner.post(
      `${ENTRIES}/${live.id}/undo-unpublish`,
      { revisionId: off.wasLiveRevisionId },
      { "If-Match": String(off.rev) },
    );
    expect(reply.status).toBe(409);
    expect((await reply.json()).error.code).toBe("address_taken");
  });

  test("won't use another entry's version, or one that was never published", async () => {
    const { owner } = await signedIn();
    const other = await livePost(owner, "Other");
    const [otherVersion] = await versions(owner, other.id);
    const live = await livePost(owner, "Mine");
    const off = await unpublish(owner, live.id, live.rev);
    for (const revisionId of [otherVersion?.id, "nope", undefined]) {
      const reply = await owner.post(
        `${ENTRIES}/${live.id}/undo-unpublish`,
        { revisionId },
        { "If-Match": String(off.rev) },
      );
      expect(reply.status).toBe(404);
    }
  });

  test("a writer can't", async () => {
    const { made, owner } = await signedIn();
    const live = await livePost(owner);
    const off = await unpublish(owner, live.id, live.rev);
    const writer = await signedInAs(made, "writer", "Wren");
    const reply = await writer.post(
      `${ENTRIES}/${live.id}/undo-unpublish`,
      { revisionId: off.wasLiveRevisionId },
      { "If-Match": String(off.rev) },
    );
    expect(reply.status).toBe(403);
  });
});

describe("History", () => {
  test("lists versions newest first, and marks what's on the site", async () => {
    const { made, owner } = await signedIn();
    const live = await livePost(owner);
    made.clock.time += MINUTE;
    await save(owner, live.id, live.rev, { doc: doc("Second") });
    const second = await publish(owner, live.id, live.rev + 1);
    const list = await versions(owner, second.id);
    expect(list.map((version) => [version.kind, version.isLive])).toEqual([
      ["publish", true],
      ["publish", false],
    ]);
    expect(list[0]?.authorName).toBeTruthy();
  });

  test("restoring an old version makes new changes, and nothing on the site moves", async () => {
    const { made, owner } = await signedIn();
    const live = await livePost(owner, "First", "First words");
    const [firstVersion] = await versions(owner, live.id);
    made.clock.time += MINUTE;
    await save(owner, live.id, live.rev, { title: "Second", doc: doc("Second words") });
    const second = await publish(owner, live.id, live.rev + 1);
    made.clock.time += MINUTE;
    await save(owner, live.id, second.rev, { doc: doc("Half-finished") });

    const reply = await owner.post(
      `/api/admin/revisions/${firstVersion?.id}/restore`,
      {},
      { "If-Match": String(second.rev + 1) },
    );
    expect(reply.status).toBe(200);
    const restored = await reply.json();
    expect(restored.data.doc).toEqual(doc("First words"));
    expect(restored.title).toBe("First");
    expect(restored.dirty).toBe(true);
    expect(await pageText(made, "/blog/first")).toContain("Second words");

    const list = await versions(owner, live.id);
    const kept = list.find((version) => version.kind === "restore");
    const detail = await (await owner.get(`/api/admin/revisions/${kept?.id}`)).json();
    expect(detail.data.doc).toEqual(doc("Half-finished"));

    await publish(owner, live.id, restored.rev);
    expect(await pageText(made, "/blog/first")).toContain("First words");
  });

  test("restoring leaves the address alone", async () => {
    const { made, owner } = await signedIn();
    const entry = await newEntry(owner);
    await save(owner, entry.id, 1, { title: "A", slug: "old-address", doc: doc("Old") });
    const first = await publish(owner, entry.id, 2);
    const [version] = await versions(owner, entry.id);
    made.clock.time += MINUTE;
    await save(owner, entry.id, first.rev, { slug: "new-address", doc: doc("New") });
    const moved = await publish(owner, entry.id, first.rev + 1);
    const restored = await (
      await owner.post(
        `/api/admin/revisions/${version?.id}/restore`,
        {},
        { "If-Match": String(moved.rev) },
      )
    ).json();
    expect(restored.slug).toBe("new-address");
    expect(restored.data.doc).toEqual(doc("Old"));
  });

  test("restoring what's already on the site leaves nothing pending", async () => {
    const { owner } = await signedIn();
    const live = await livePost(owner);
    const [version] = await versions(owner, live.id);
    await save(owner, live.id, live.rev, { doc: doc("Oops") });
    const restored = await (
      await owner.post(
        `/api/admin/revisions/${version?.id}/restore`,
        {},
        { "If-Match": String(live.rev + 1) },
      )
    ).json();
    expect(restored.dirty).toBe(false);
  });

  test("restoring refuses to go over changes it hasn't seen", async () => {
    const { owner } = await signedIn();
    const live = await livePost(owner);
    const [version] = await versions(owner, live.id);
    await save(owner, live.id, live.rev, { doc: doc("Newer") });
    const reply = await owner.post(
      `/api/admin/revisions/${version?.id}/restore`,
      {},
      { "If-Match": String(live.rev) },
    );
    expect(reply.status).toBe(409);
    expect((await reply.json()).error.code).toBe("edit_conflict");
  });

  test("can't restore into something in the Trash", async () => {
    const { owner } = await signedIn();
    const live = await livePost(owner);
    const [version] = await versions(owner, live.id);
    const trashed = await (await owner.post(`${ENTRIES}/${live.id}/trash`)).json();
    const reply = await owner.post(
      `/api/admin/revisions/${version?.id}/restore`,
      {},
      { "If-Match": String(trashed.rev) },
    );
    expect(reply.status).toBe(409);
  });

  test("a writer can't look at or restore versions of someone else's work", async () => {
    const { made, owner } = await signedIn();
    const live = await livePost(owner);
    const [version] = await versions(owner, live.id);
    const writer = await signedInAs(made, "writer", "Wren");
    expect((await writer.get(`${ENTRIES}/${live.id}/revisions`)).status).toBe(403);
    expect((await writer.get(`/api/admin/revisions/${version?.id}`)).status).toBe(403);
    const reply = await writer.post(
      `/api/admin/revisions/${version?.id}/restore`,
      {},
      { "If-Match": String(live.rev) },
    );
    expect(reply.status).toBe(403);
  });

  test("a version that doesn't exist is explained", async () => {
    const { owner } = await signedIn();
    const reply = await owner.get("/api/admin/revisions/nope");
    expect(reply.status).toBe(404);
    expect((await reply.json()).error.fix).toBeTruthy();
  });
});

describe("discarding changes", () => {
  test("goes back to what's on the site, and keeps what was being worked on", async () => {
    const { made, owner } = await signedIn();
    const live = await livePost(owner, "Live title");
    const edited = await save(owner, live.id, live.rev, { title: "Oops", doc: doc("Oops") });
    const reply = await owner.post(
      `${ENTRIES}/${live.id}/discard-changes`,
      {},
      { "If-Match": String(edited.rev) },
    );
    expect(reply.status).toBe(200);
    const discarded = await reply.json();
    expect(discarded).toMatchObject({ title: "Live title", dirty: false });
    expect(discarded.data.doc).toEqual(doc("Live words"));
    expect(await pageText(made, "/blog/live-title")).toContain("Live words");

    const kept = await (await owner.get(`/api/admin/revisions/${discarded.keptRevisionId}`)).json();
    expect(kept.kind).toBe("before_discard");
    expect(kept.data.doc).toEqual(doc("Oops"));
  });

  test("undoing it brings back a changed address as well, unlike restoring from History", async () => {
    const { owner } = await signedIn();
    const live = await livePost(owner, "Hours");
    const edited = await save(owner, live.id, live.rev, { slug: "new-address", doc: doc("New") });
    const discarded = await (
      await owner.post(
        `${ENTRIES}/${live.id}/discard-changes`,
        {},
        { "If-Match": String(edited.rev) },
      )
    ).json();
    expect(discarded.slug).toBe("hours");

    const undone = await (
      await owner.post(
        `/api/admin/revisions/${discarded.keptRevisionId}/restore`,
        { includeAddress: true },
        { "If-Match": String(discarded.rev) },
      )
    ).json();
    expect(undone.slug).toBe("new-address");
    expect(undone.data.doc).toEqual(doc("New"));
    expect(undone.dirty).toBe(true);
  });

  test("needs something on the site to go back to", async () => {
    const { owner } = await signedIn();
    const entry = await newEntry(owner);
    await save(owner, entry.id, 1, { title: "Draft" });
    const reply = await owner.post(
      `${ENTRIES}/${entry.id}/discard-changes`,
      {},
      { "If-Match": "2" },
    );
    expect(reply.status).toBe(409);
    expect((await reply.json()).error.code).toBe("not_on_site");
  });

  test("refuses to go over changes it hasn't seen", async () => {
    const { owner } = await signedIn();
    const live = await livePost(owner);
    await save(owner, live.id, live.rev, { doc: doc("Newer") });
    const reply = await owner.post(
      `${ENTRIES}/${live.id}/discard-changes`,
      {},
      { "If-Match": String(live.rev) },
    );
    expect(reply.status).toBe(409);
  });
});

describe("duplicating", () => {
  test("makes a draft with the same words and its own address", async () => {
    const { made, owner } = await signedIn();
    const live = await livePost(owner, "Original", "Original words");
    const reply = await owner.post(`${ENTRIES}/${live.id}/duplicate`);
    expect(reply.status).toBe(201);
    const copy = await reply.json();
    expect(copy).toMatchObject({
      title: "Copy of Original",
      status: "draft",
      url: null,
      slug: "",
      isHome: false,
      firstPublishedAt: null,
    });
    expect(copy.id).not.toBe(live.id);
    expect(copy.data.doc).toEqual(doc("Original words"));
    expect(await pageText(made, "/blog")).not.toContain("Copy of Original");

    const list = await (await owner.get(`${ENTRIES}?type=post`)).json();
    expect(list.entries.map((row: { id: string }) => row.id)).toContain(copy.id);
    expect((await publish(owner, copy.id, copy.rev)).url).toBe("/blog/copy-of-original");
  });

  test("a long title still fits", async () => {
    const { owner } = await signedIn();
    const live = await livePost(owner, "x".repeat(200));
    const copy = await (await owner.post(`${ENTRIES}/${live.id}/duplicate`)).json();
    expect(copy.title.length).toBeLessThanOrEqual(200);
  });

  test("duplicating the homepage doesn't make a second homepage", async () => {
    const { owner } = await signedIn();
    const list = await (await owner.get(`${ENTRIES}?type=page`)).json();
    const home = list.entries.find((row: { isHome: boolean }) => row.isHome);
    const copy = await (await owner.post(`${ENTRIES}/${home.id}/duplicate`)).json();
    expect(copy.isHome).toBe(false);
  });

  test("a writer can copy their own work, but not someone else's", async () => {
    const { made, owner } = await signedIn();
    const live = await livePost(owner);
    const writer = await signedInAs(made, "writer", "Wren");
    expect((await writer.post(`${ENTRIES}/${live.id}/duplicate`)).status).toBe(403);
    const mine = await newEntry(writer);
    const copy = await writer.post(`${ENTRIES}/${mine.id}/duplicate`);
    expect(copy.status).toBe(201);
  });
});

describe("deleting forever", () => {
  test("only from the Trash", async () => {
    const { owner } = await signedIn();
    const live = await livePost(owner);
    const refused = await owner.delete(`${ENTRIES}/${live.id}`);
    expect(refused.status).toBe(409);
    expect((await refused.json()).error.code).toBe("not_in_trash");
    expect((await owner.get(`${ENTRIES}/${live.id}`)).status).toBe(200);
  });

  test("really removes it and every version", async () => {
    const { made, owner } = await signedIn();
    const live = await livePost(owner);
    await owner.post(`${ENTRIES}/${live.id}/trash`);
    expect((await owner.delete(`${ENTRIES}/${live.id}`)).status).toBe(204);
    expect((await owner.get(`${ENTRIES}/${live.id}`)).status).toBe(404);
    const left = made.db
      .prepare("SELECT count(*) AS n FROM revisions WHERE entry_id = ?")
      .get(live.id) as { n: number };
    expect(left.n).toBe(0);
  });

  test("only an admin can", async () => {
    const { made, owner } = await signedIn();
    const live = await livePost(owner);
    await owner.post(`${ENTRIES}/${live.id}/trash`);
    const editor = await signedInAs(made, "editor", "Ed");
    expect((await editor.delete(`${ENTRIES}/${live.id}`)).status).toBe(403);
    const admin = await signedInAs(made, "admin", "Ada");
    expect((await admin.delete(`${ENTRIES}/${live.id}`)).status).toBe(204);
  });
});

describe("links to other pages", () => {
  async function linkedPair(owner: Client) {
    const target = await newEntry(owner, "page");
    await save(owner, target.id, 1, { title: "About", doc: doc("About us") });
    const about = await publish(owner, target.id, 2);
    const linker = await newEntry(owner);
    await save(owner, linker.id, 1, { title: "Linker", doc: linkTo(about.id) });
    const post = await publish(owner, linker.id, 2);
    return { about, post };
  }

  test("show the page's real address", async () => {
    const { made, owner } = await signedIn();
    await linkedPair(owner);
    const html = await pageText(made, "/blog/linker");
    expect(html).toContain('<a href="/about">see this</a>');
    expect(html).not.toContain("tend:entry");
  });

  test("follow a page when its address changes", async () => {
    const { made, owner } = await signedIn();
    const { about } = await linkedPair(owner);
    await save(owner, about.id, about.rev, { slug: "about-us" });
    await publish(owner, about.id, about.rev + 1);
    expect(await pageText(made, "/blog/linker")).toContain('<a href="/about-us">see this</a>');
  });

  test("turn into plain words when the page is unpublished or trashed", async () => {
    const { made, owner } = await signedIn();
    const { about } = await linkedPair(owner);
    await owner.post(`${ENTRIES}/${about.id}/unpublish`, {}, { "If-Match": String(about.rev) });
    let html = await pageText(made, "/blog/linker");
    expect(html).toContain("see this");
    expect(html).not.toContain('<a href="/about"');

    const again = await publish(owner, about.id, about.rev + 1);
    expect(await pageText(made, "/blog/linker")).toContain('<a href="/about">');
    await owner.post(`${ENTRIES}/${again.id}/trash`);
    html = await pageText(made, "/blog/linker");
    expect(html).toContain("see this");
    expect(html).not.toContain('<a href="/about"');
  });

  test("turn into plain words when the page is deleted forever", async () => {
    const { made, owner } = await signedIn();
    const { about } = await linkedPair(owner);
    await owner.post(`${ENTRIES}/${about.id}/trash`);
    await owner.delete(`${ENTRIES}/${about.id}`);
    expect(await pageText(made, "/blog/linker")).toContain("see this");
  });

  test("a cached page picks up the change", async () => {
    const made = await makeApp({ pageCacheBytes: 1_000_000 });
    const owner = await setUp(made);
    const { about } = await linkedPair(owner);
    expect(await pageText(made, "/blog/linker")).toContain('<a href="/about">');
    await owner.post(`${ENTRIES}/${about.id}/unpublish`, {}, { "If-Match": String(about.rev) });
    expect(await pageText(made, "/blog/linker")).not.toContain('<a href="/about">');
  });

  test("thousands of them in one document can still be saved", async () => {
    const { made, owner } = await signedIn();
    const entry = await newEntry(owner);
    const ids = Array.from(
      { length: 8192 },
      (_, index) => `0190b5d0-0000-7000-8000-${String(index).padStart(12, "0")}`,
    );
    const saved = await save(owner, entry.id, 1, {
      title: "Index",
      doc: {
        type: "doc",
        content: ids.map((id) => linkTo(id, "x").content[0]),
      },
    });
    expect(saved.rev).toBe(2);
    const row = made.db.prepare("SELECT count(*) AS n FROM refs WHERE entry_id = ?").get(entry.id);
    expect(row).toEqual({ n: 8192 });
  });

  test("are recorded for the working copy and the live version", async () => {
    const { made, owner } = await signedIn();
    const { about, post } = await linkedPair(owner);
    const rows = () =>
      made.db
        .prepare("SELECT scope, kind, ref_id AS refId FROM refs WHERE entry_id = ? ORDER BY scope")
        .all(post.id);
    expect(rows()).toEqual([
      { scope: "live", kind: "entry", refId: about.id },
      { scope: "working", kind: "entry", refId: about.id },
    ]);
    await save(owner, post.id, post.rev, { doc: doc("No links now") });
    expect(rows()).toEqual([{ scope: "live", kind: "entry", refId: about.id }]);
    await publish(owner, post.id, post.rev + 1);
    expect(rows()).toEqual([]);
  });

  test("the live record goes when the page comes off the site", async () => {
    const { made, owner } = await signedIn();
    const { post } = await linkedPair(owner);
    await owner.post(`${ENTRIES}/${post.id}/trash`);
    const rows = made.db.prepare("SELECT scope FROM refs WHERE entry_id = ?").all(post.id);
    expect(rows).toEqual([{ scope: "working" }]);
  });

  describe("searching for something to link to", () => {
    test("finds things by title, however they're written", async () => {
      const { owner } = await signedIn();
      await linkedPair(owner);
      const reply = await owner.get("/api/admin/link-targets?q=abou");
      const { targets } = await reply.json();
      expect(targets.map((target: { title: string }) => target.title)).toContain("About");
      expect(targets[0].url).toBe("/about");
    });

    test("puts a title that's exactly what was typed first", async () => {
      const { made, owner } = await signedIn();
      await livePost(owner, "News");
      for (let index = 0; index < 9; index++) {
        made.clock.time += MINUTE;
        await livePost(owner, `Bakery news ${index}`);
      }
      const { targets } = await (await owner.get("/api/admin/link-targets?q=news")).json();
      expect(targets[0].title).toBe("News");
    });

    test("ignores accents and case, however the title was written", async () => {
      const { owner } = await signedIn();
      await livePost(owner, "École d'été");
      for (const typed of ["école", "ÉCOLE", "ecole", "ete"]) {
        const { targets } = await (
          await owner.get(`/api/admin/link-targets?q=${encodeURIComponent(typed)}`)
        ).json();
        expect(
          targets.map((target: { title: string }) => target.title),
          typed,
        ).toEqual(["École d'été"]);
      }
    });

    test("treats % and _ as ordinary characters", async () => {
      const { owner } = await signedIn();
      await livePost(owner, "100% rye");
      await livePost(owner, "Plain");
      const percent = await (await owner.get("/api/admin/link-targets?q=%25")).json();
      expect(percent.targets.map((target: { title: string }) => target.title)).toEqual([
        "100% rye",
      ]);
      const underscore = await (await owner.get("/api/admin/link-targets?q=_")).json();
      expect(underscore.targets).toEqual([]);
    });

    test("doesn't offer the Trash or things never saved", async () => {
      const { owner } = await signedIn();
      const gone = await livePost(owner, "Binned");
      await owner.post(`${ENTRIES}/${gone.id}/trash`);
      await newEntry(owner);
      const { targets } = await (await owner.get("/api/admin/link-targets?q=Binned")).json();
      expect(targets).toEqual([]);
      const all = await (await owner.get("/api/admin/link-targets")).json();
      expect(all.targets.map((target: { title: string }) => target.title)).not.toContain("");
    });

    test("doesn't show a writer other people's drafts", async () => {
      const { made, owner } = await signedIn();
      const draft = await newEntry(owner);
      await save(owner, draft.id, 1, { title: "Secret plan" });
      const writer = await signedInAs(made, "writer", "Wren");
      const found = await (await writer.get("/api/admin/link-targets?q=Secret")).json();
      expect(found.targets).toEqual([]);
      const looked = await (await writer.get(`/api/admin/link-targets?ids=${draft.id}`)).json();
      expect(looked.targets).toEqual([]);
      const ownerSees = await (await owner.get("/api/admin/link-targets?q=Secret")).json();
      expect(ownerSees.targets).toHaveLength(1);
    });

    test("doesn't show a writer the unpublished title of someone else's live page", async () => {
      const { made, owner } = await signedIn();
      const live = await livePost(owner, "Pricing");
      await save(owner, live.id, live.rev, { title: "Layoffs announcement" });
      const writer = await signedInAs(made, "writer", "Wren");

      const guessed = await (await writer.get("/api/admin/link-targets?q=Layoffs")).json();
      expect(guessed.targets).toEqual([]);
      const found = await (await writer.get("/api/admin/link-targets?q=Pricing")).json();
      expect(found.targets.map((target: { title: string }) => target.title)).toEqual(["Pricing"]);
      const looked = await (await writer.get(`/api/admin/link-targets?ids=${live.id}`)).json();
      expect(looked.targets[0].title).toBe("Pricing");

      const ownerSees = await (await owner.get("/api/admin/link-targets?q=Layoffs")).json();
      expect(ownerSees.targets).toHaveLength(1);
    });

    test("a writer searches their own drafts by their working titles", async () => {
      const { made } = await signedIn();
      const writer = await signedInAs(made, "writer", "Wren");
      const mine = await newEntry(writer);
      await save(writer, mine.id, 1, { title: "My draft" });
      const found = await (await writer.get("/api/admin/link-targets?q=draft")).json();
      expect(found.targets.map((target: { title: string }) => target.title)).toEqual(["My draft"]);
    });

    test("looks up existing links, and says when one isn't on the site", async () => {
      const { owner } = await signedIn();
      const { about, post } = await linkedPair(owner);
      const trashed = await (await owner.post(`${ENTRIES}/${post.id}/trash`)).json();
      const reply = await owner.get(
        `/api/admin/link-targets?ids=${about.id},${trashed.id},missing`,
      );
      const { targets } = await reply.json();
      expect(targets).toHaveLength(2);
      const byId = Object.fromEntries(
        targets.map((target: { id: string; url: string | null }) => [target.id, target.url]),
      );
      expect(byId[about.id]).toBe("/about");
      expect(byId[trashed.id]).toBeNull();
    });
  });
});

describe("automatic summaries", () => {
  test("come from the first paragraph, not a heading or button before it", async () => {
    const { made, owner } = await signedIn();
    const entry = await newEntry(owner);
    await save(owner, entry.id, 1, {
      title: "Why",
      doc: {
        type: "doc",
        content: [
          {
            type: "heading",
            attrs: { level: 2 },
            content: [{ type: "text", text: "Why we bake" }],
          },
          { type: "button", attrs: { href: "/x", label: "Buy now" } },
          { type: "codeBlock" },
          { type: "paragraph", content: [{ type: "text", text: "Because bread matters" }] },
        ],
      },
    });
    await publish(owner, entry.id, 2);
    const html = await pageText(made, "/blog/why");
    expect(html).toContain('<meta name="description" content="Because bread matters">');
    expect(html).not.toContain("<pre><code></code></pre>");
    expect(await pageText(made, "/blog")).toContain("Because bread matters");
  });
});

describe("previews", () => {
  test("show unpublished words in the real theme, and aren't kept anywhere", async () => {
    const { made, owner } = await signedIn();
    const entry = await newEntry(owner);
    await save(owner, entry.id, 1, { title: "Draft title", doc: doc("Draft words") });
    const reply = await owner.get(`/api/admin/preview/${entry.id}`);
    expect(reply.status).toBe(200);
    expect(reply.headers.get("cache-control")).toBe("no-store");
    expect(reply.headers.get("content-type")).toContain("application/json");
    const { html } = await reply.json();
    expect(html).toContain("Draft title");
    expect(html).toContain("Draft words");
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).toContain('<base target="_blank">');
    expect(html).toContain("theme.css");
    expect(await pageText(made, "/blog")).not.toContain("Draft title");
  });

  test("show changes that aren't on the site yet", async () => {
    const { made, owner } = await signedIn();
    const live = await livePost(owner);
    await save(owner, live.id, live.rev, { doc: doc("Not yet") });
    const { html } = await (await owner.get(`/api/admin/preview/${live.id}`)).json();
    expect(html).toContain("Not yet");
    expect(await pageText(made, "/blog/live")).not.toContain("Not yet");
  });

  test("escape what people typed", async () => {
    const { owner } = await signedIn();
    const entry = await newEntry(owner);
    await save(owner, entry.id, 1, {
      title: "<script>alert(1)</script>",
      doc: doc("<img src=x onerror=alert(1)>"),
    });
    const { html } = await (await owner.get(`/api/admin/preview/${entry.id}`)).json();
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x");
  });

  test("a version can be previewed too", async () => {
    const { owner } = await signedIn();
    const live = await livePost(owner, "Old title", "Old words");
    const [version] = await versions(owner, live.id);
    await save(owner, live.id, live.rev, { title: "New title", doc: doc("New words") });
    const detail = await (await owner.get(`/api/admin/revisions/${version?.id}`)).json();
    expect(detail.previewHtml).toContain("Old words");
    expect(detail.previewHtml).not.toContain("New words");
  });

  test("the homepage previews as the homepage", async () => {
    const { owner } = await signedIn();
    const list = await (await owner.get(`${ENTRIES}?type=page`)).json();
    const home = list.entries.find((row: { isHome: boolean }) => row.isHome);
    const { html } = await (await owner.get(`/api/admin/preview/${home.id}`)).json();
    expect(html).toContain(home.title);
  });
});

describe("tidying up", () => {
  test("empties the Trash after 30 days, and not before", async () => {
    const { made, owner } = await signedIn();
    const live = await livePost(owner);
    await owner.post(`${ENTRIES}/${live.id}/trash`);
    cleanUp(made.orm, made.clock.time + (KEEP_DAYS - 1) * DAY);
    expect((await owner.get(`${ENTRIES}/${live.id}`)).status).toBe(200);
    cleanUp(made.orm, made.clock.time + (KEEP_DAYS + 1) * DAY);
    expect((await owner.get(`${ENTRIES}/${live.id}`)).status).toBe(404);
  });

  test("removes old automatic versions, and keeps every published one", async () => {
    const { made, owner } = await signedIn();
    const live = await livePost(owner);
    made.clock.time += MINUTE;
    const changed = await save(owner, live.id, live.rev, { doc: doc("Two") });
    made.clock.time += MINUTE;
    await save(owner, live.id, changed.rev, { doc: doc("Three") });
    expect((await versions(owner, live.id)).map((version) => version.kind)).toEqual([
      "autosave",
      "publish",
    ]);
    cleanUp(made.orm, made.clock.time + (KEEP_DAYS + 1) * DAY);
    expect((await versions(owner, live.id)).map((version) => version.kind)).toEqual(["publish"]);
    const reply = await made.app.request("/blog/live");
    expect(await reply.text()).toContain("Live words");
  });

  test("removes rows from pressing New and never typing, and nothing anyone wrote", async () => {
    const { made, owner } = await signedIn();
    const untouched = await newEntry(owner);
    const written = await newEntry(owner);
    await save(owner, written.id, 1, { title: "Words" });
    cleanUp(made.orm, made.clock.time + (KEEP_DAYS + 1) * DAY);
    expect((await owner.get(`${ENTRIES}/${untouched.id}`)).status).toBe(404);
    expect((await owner.get(`${ENTRIES}/${written.id}`)).status).toBe(200);
  });

  test("doesn't touch what's on the site", async () => {
    const { made, owner } = await signedIn();
    const live = await livePost(owner);
    cleanUp(made.orm, made.clock.time + 1000 * DAY);
    expect((await owner.get(`${ENTRIES}/${live.id}`)).status).toBe(200);
    expect(await pageText(made, "/blog/live")).toContain("Live words");
  });

  test("finds what points at a deleted version with an index, not by reading every entry", async () => {
    // Deleting a version runs this lookup to clear entries.published_rev_id. Tidying old
    // versions and emptying the Trash delete hundreds of versions at once.
    const { made } = await signedIn();
    const plan = made.db
      .prepare("EXPLAIN QUERY PLAN SELECT rowid FROM entries WHERE published_rev_id = ?")
      .all("a-version") as { detail: string }[];
    expect(plan.map((step) => step.detail).join("\n")).toMatch(
      /USING (COVERING )?INDEX entries_published_rev\b/,
    );
  });
});
