import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { Link, useLocation } from "wouter";
import { AdminLayout, SignedIn } from "../components/AdminLayout.tsx";
import {
  Loading,
  primaryButtonClass,
  secondaryButtonClass,
  textLinkClass,
} from "../components/AuthLayout.tsx";
import { Field } from "../components/fields.tsx";
import { ApiError, api, errorText } from "../lib/api.ts";
import { docToText, textToDoc } from "../lib/doc.ts";
import {
  type EditorDraft,
  getHeldDraft,
  type HeldDraft,
  holdDraft,
  registerBeforeSignOut,
  releaseDraft,
  trackSave,
  waitForSave,
} from "../lib/held-drafts.ts";
import {
  type EntryFull,
  type EntrySummary,
  type EntryType,
  entriesKey,
  entryKey,
  type Me,
} from "../lib/queries.ts";

/** Shows the address publishing will really use. Mirrors the server's rule. */
function toAddress(text: string, type: EntryType): string {
  const path = text.trim().replace(/^\/+/, "");
  return (type === "post" ? path.replace(/^blog\//, "") : path)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function draftFrom(entry: EntryFull): EditorDraft {
  return { title: entry.title, slug: entry.slug, body: docToText(entry.data.doc) };
}

function sameDraft(a: EditorDraft, b: EditorDraft): boolean {
  return a.title === b.title && a.slug === b.slug && a.body === b.body;
}

function hasUnsavedText(state: { draft: EditorDraft; saved: EditorDraft }): boolean {
  return !sameDraft(state.draft, state.saved);
}

function saveRequest(
  id: string,
  rev: number,
  draft: EditorDraft,
  options: { keepOtherVersion?: boolean } = {},
): Promise<EntryFull> {
  return api<EntryFull>(`/admin/entries/${id}`, {
    method: "PATCH",
    headers: { "If-Match": String(rev) },
    body: { title: draft.title, slug: draft.slug, doc: textToDoc(draft.body), ...options },
  });
}

type Activity = "saving" | "publishing" | "unpublishing" | "trashing" | "restoring";

function EditorScreen({
  me,
  entry,
  type,
  held,
}: {
  me: Me;
  entry: EntryFull;
  type: EntryType;
  held: HeldDraft | undefined;
}) {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const bodyId = useId();
  const bodyHintId = useId();
  const titleRef = useRef<HTMLInputElement>(null);
  const slugRef = useRef<HTMLInputElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);

  const serverDraft = draftFrom(entry);
  const [current, setCurrent] = useState(entry);
  const [draft, setDraftState] = useState(held?.draft ?? serverDraft);
  const [saved, setSaved] = useState(serverDraft);
  const [problem, setProblem] = useState<unknown>(null);
  const [fieldError, setFieldError] = useState<{ field: string; message: string } | null>(null);
  const [conflict, setConflict] = useState<EntryFull | null>(null);
  const [activity, setActivity] = useState<Activity | null>(null);
  const [restoredHeld, setRestoredHeld] = useState(held !== undefined);
  const [justUnpublished, setJustUnpublished] = useState(false);

  // The same facts, readable after this screen has gone, because an action or a save on
  // leaving can outlive it. A held draft keeps the version it was based on, so if the
  // entry has changed since, saving raises a conflict rather than overwriting.
  const session = useRef({
    draft: held?.draft ?? serverDraft,
    saved: serverDraft,
    rev: held?.rev ?? entry.rev,
    running: Promise.resolve() as Promise<unknown>,
    busy: false,
    done: false,
  });

  const listPath = type === "post" ? "/posts" : "/pages";
  const unsaved = !sameDraft(draft, saved);
  const isLive = current.url !== null;
  const inTrash = current.trashedAt !== null;
  const hasPendingChanges = isLive && (current.dirty || unsaved);
  const offlineText = intl.formatMessage({ id: "offline.body" });
  const busy = activity !== null;
  const locked = conflict !== null || inTrash;

  function setDraft(next: EditorDraft) {
    session.current.draft = next;
    setDraftState(next);
    setJustUnpublished(false);
  }

  /**
   * Takes on what the server answered. A field only changes if it still holds what was
   * sent, because the boxes stay editable during a save, and anything typed meanwhile is
   * newer than the answer.
   */
  function accept(next: EntryFull, sent: EditorDraft) {
    const answer = draftFrom(next);
    const typed = session.current.draft;
    const merged = {
      title: typed.title === sent.title ? answer.title : typed.title,
      slug: typed.slug === sent.slug ? answer.slug : typed.slug,
      body: typed.body === sent.body ? answer.body : typed.body,
    };
    session.current.saved = answer;
    session.current.rev = next.rev;
    session.current.draft = merged;
    setCurrent(next);
    setSaved(answer);
    setDraftState(merged);
    setConflict(null);
    setRestoredHeld(false);
    queryClient.setQueryData(entryKey(next.id), next);
    void queryClient.invalidateQueries({ queryKey: entriesKey(type, false) });
  }

  async function report(error: unknown) {
    if (error instanceof ApiError && error.field) {
      setFieldError({ field: error.field, message: errorText(error, offlineText) });
      if (error.field === "title") titleRef.current?.focus();
      if (error.field === "slug") slugRef.current?.focus();
      return;
    }
    if (error instanceof ApiError && error.code === "edit_conflict") {
      // A save's answer includes the other version, and a publish's doesn't.
      const theirs =
        (error.current as EntryFull | undefined) ??
        (await api<EntryFull>(`/admin/entries/${current.id}`));
      setConflict(theirs);
      return;
    }
    setProblem(error);
  }

  /** One action at a time, showing whatever it finds without losing what's typed. */
  function run(kind: Activity, action: () => Promise<void>) {
    if (session.current.busy) return;
    session.current.busy = true;
    setActivity(kind);
    setProblem(null);
    setFieldError(null);
    setJustUnpublished(false);
    session.current.running = action()
      .catch(report)
      .finally(() => {
        session.current.busy = false;
        setActivity(null);
      });
  }

  async function saveNow(): Promise<void> {
    const sent = session.current.draft;
    accept(await saveRequest(current.id, session.current.rev, sent), sent);
  }

  function onSave(event: FormEvent) {
    event.preventDefault();
    if (locked || !unsaved) return;
    run("saving", saveNow);
  }

  async function publishNow() {
    const sent = session.current.saved;
    accept(
      await api<EntryFull>(`/admin/entries/${current.id}/publish`, {
        method: "POST",
        headers: { "If-Match": String(session.current.rev) },
      }),
      sent,
    );
  }

  function onPublish() {
    if (locked || (isLive && !hasPendingChanges)) return;
    run("publishing", async () => {
      if (hasUnsavedText(session.current)) await saveNow();
      await publishNow();
    });
  }

  function onUnpublish() {
    run("unpublishing", async () => {
      if (hasUnsavedText(session.current)) await saveNow();
      const sent = session.current.saved;
      accept(
        await api<EntryFull>(`/admin/entries/${current.id}/unpublish`, {
          method: "POST",
          headers: { "If-Match": String(session.current.rev) },
        }),
        sent,
      );
      setJustUnpublished(true);
      statusRef.current?.focus();
    });
  }

  function onUndoUnpublish() {
    run("publishing", async () => {
      await publishNow();
      statusRef.current?.focus();
    });
  }

  function onTrash() {
    const wasLive = isLive;
    run("trashing", async () => {
      if (hasUnsavedText(session.current)) await saveNow();
      await api(`/admin/entries/${current.id}/trash`, { method: "POST" });
      session.current.done = true;
      releaseDraft(current.id);
      queryClient.removeQueries({ queryKey: entryKey(current.id) });
      // Off the list straight away, rather than sitting beside "Moved to the Trash".
      queryClient.setQueryData<{ entries: EntrySummary[] }>(
        entriesKey(type, false),
        (list) => list && { ...list, entries: list.entries.filter((row) => row.id !== current.id) },
      );
      void queryClient.invalidateQueries({ queryKey: entriesKey(type, false) });
      void queryClient.invalidateQueries({ queryKey: entriesKey(type, true) });
      navigate(listPath, {
        state: {
          trashed: { id: current.id, wasPublished: wasLive || current.firstPublishedAt !== null },
        },
      });
    });
  }

  function onRestore() {
    run("restoring", async () => {
      const sent = session.current.saved;
      accept(
        await api<EntryFull>(`/admin/entries/${current.id}/restore`, { method: "POST" }),
        sent,
      );
      void queryClient.invalidateQueries({ queryKey: entriesKey(type, true) });
      statusRef.current?.focus();
    });
  }

  function takeNewest() {
    if (!conflict) return;
    const theirs = draftFrom(conflict);
    session.current.draft = theirs;
    setDraftState(theirs);
    accept(conflict, theirs);
    releaseDraft(conflict.id);
  }

  function keepMine() {
    if (!conflict) return;
    const theirs = conflict;
    run("saving", async () => {
      const sent = session.current.draft;
      // Theirs is kept as a revision, so choosing this doesn't destroy it.
      accept(await saveRequest(theirs.id, theirs.rev, sent, { keepOtherVersion: true }), sent);
    });
  }

  function discardHeld() {
    const server = session.current.saved;
    session.current.rev = current.rev;
    session.current.draft = server;
    setDraftState(server);
    setRestoredHeld(false);
    setConflict(null);
    setFieldError(null);
    releaseDraft(current.id);
  }

  // Everything typed is held until the server has it, whatever happens to this screen.
  useEffect(() => {
    if (session.current.done) return;
    if (unsaved) {
      holdDraft({ id: entry.id, type, userId: me.user.id, rev: session.current.rev, draft });
    } else {
      releaseDraft(entry.id);
    }
  }, [draft, unsaved, entry.id, type, me.user.id]);

  // Closing the tab can't be saved reliably, so the browser asks first.
  useEffect(() => {
    if (!unsaved) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsaved]);

  // Signing out waits for the save, and doesn't go ahead if it fails.
  useEffect(
    () =>
      registerBeforeSignOut(async () => {
        await session.current.running;
        if (!session.current.done && hasUnsavedText(session.current)) {
          const sent = session.current.draft;
          const next = await saveRequest(entry.id, session.current.rev, sent);
          session.current.saved = draftFrom(next);
          session.current.rev = next.rev;
          session.current.draft = session.current.saved;
          releaseDraft(entry.id);
        }
        session.current.done = true;
      }),
    [entry.id],
  );

  // Moving elsewhere in the admin saves what's typed: nobody should lose work by clicking a
  // link. It waits for anything still running, so it uses the newest version number. If it
  // fails, the draft stays held, and the admin says so. The check is deferred because
  // StrictMode unmounts and remounts straight away, which isn't really leaving.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      queueMicrotask(() => {
        if (mounted.current || session.current.done) return;
        const save = session.current.running.then(async () => {
          if (session.current.done || !hasUnsavedText(session.current)) return;
          const sent = session.current.draft;
          await saveRequest(entry.id, session.current.rev, sent);
          releaseDraft(entry.id);
        });
        trackSave(
          entry.id,
          save.then(() => queryClient.invalidateQueries({ queryKey: entriesKey(type, false) })),
        );
        save.catch(() => {});
      });
    };
  }, [entry.id, type, queryClient]);

  const statusId = activity
    ? `editor.${activity}`
    : inTrash
      ? "editor.inTrash"
      : justUnpublished
        ? "editor.takenOff"
        : unsaved
          ? "editor.notSaved"
          : !isLive
            ? "editor.saved"
            : current.dirty
              ? "status.changes"
              : "status.onSite";
  const publishId = hasPendingChanges
    ? "editor.publishChanges"
    : isLive
      ? "editor.published"
      : type === "post"
        ? "editor.publishPost"
        : "editor.publishPage";
  const addressPrefix = type === "post" ? "/blog/" : "/";
  const addressPreview = toAddress(draft.slug, type) || toAddress(draft.title, type) || "…";
  const canPublish = !busy && !locked && (!isLive || hasPendingChanges);
  const canSave = !busy && !locked && unsaved;

  return (
    <AdminLayout
      me={me}
      screen={type === "post" ? "editor.post" : "editor.page"}
      focusHeading={entry.title !== ""}
      currentEntryId={entry.id}
    >
      <div className="mt-2">
        <Link href={listPath} className={textLinkClass}>
          <FormattedMessage id={type === "post" ? "editor.backToPosts" : "editor.backToPages"} />
        </Link>
      </div>

      {restoredHeld && unsaved && (
        <div className="mt-4 grid gap-3 rounded-lg border border-muted p-4">
          <p>
            <FormattedMessage id="editor.heldBack" />
          </p>
          <div>
            <button type="button" onClick={discardHeld} className={secondaryButtonClass}>
              <FormattedMessage id="editor.discardHeld" />
            </button>
          </div>
        </div>
      )}

      <form onSubmit={onSave} noValidate className="mt-4 grid gap-6">
        <Field
          ref={titleRef}
          label={intl.formatMessage({ id: "editor.titleLabel" })}
          value={draft.title}
          onChange={(event) => {
            setDraft({ ...session.current.draft, title: event.target.value });
            setFieldError(null);
          }}
          error={fieldError?.field === "title" ? fieldError.message : undefined}
          maxLength={200}
          readOnly={locked}
          autoFocus={entry.title === ""}
        />
        {!current.isHome && (
          <Field
            ref={slugRef}
            label={intl.formatMessage({ id: "editor.addressLabel" })}
            hint={
              <FormattedMessage
                id="editor.addressHint"
                values={{ address: `${addressPrefix}${addressPreview}` }}
              />
            }
            value={draft.slug}
            onChange={(event) => {
              setDraft({ ...session.current.draft, slug: event.target.value });
              setFieldError(null);
            }}
            error={fieldError?.field === "slug" ? fieldError.message : undefined}
            placeholder={toAddress(draft.title, type)}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            maxLength={200}
            readOnly={locked}
          />
        )}
        <div className="grid gap-2">
          <label htmlFor={bodyId} className="font-medium">
            <FormattedMessage id="editor.bodyLabel" />
          </label>
          <textarea
            id={bodyId}
            aria-describedby={bodyHintId}
            value={draft.body}
            onChange={(event) => setDraft({ ...session.current.draft, body: event.target.value })}
            rows={16}
            readOnly={locked}
            className="w-full rounded-lg border border-muted bg-white p-3 text-lg leading-relaxed text-[#1d2420] focus-visible:outline-3 focus-visible:outline-brand"
          />
          <p id={bodyHintId} className="text-sm text-muted">
            <FormattedMessage id="editor.bodyHint" />
          </p>
        </div>

        {conflict && (
          <div role="alert" className="grid gap-3 rounded-lg border border-danger p-4">
            <p className="font-medium">
              <FormattedMessage id="editor.conflict" />
            </p>
            <div className="rounded border border-muted/50 p-3 text-sm">
              <p className="font-medium">
                <FormattedMessage id="editor.conflictTheirs" />
              </p>
              <p className="mt-1 break-words">{conflict.title}</p>
              <p className="mt-1 line-clamp-4 break-words whitespace-pre-wrap text-muted">
                {docToText(conflict.data.doc)}
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                disabled={busy}
                onClick={takeNewest}
                className={secondaryButtonClass}
              >
                <FormattedMessage id="editor.useNewest" />
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={keepMine}
                className={secondaryButtonClass}
              >
                <FormattedMessage id="editor.keepMine" />
              </button>
            </div>
          </div>
        )}

        {/* Always mounted: screen readers can miss a live region added along with its text. */}
        <p role="alert" className="font-medium text-danger empty:sr-only">
          {problem ? errorText(problem, offlineText) : null}
        </p>
        <p ref={statusRef} tabIndex={-1} role="status" className="text-muted outline-none">
          <FormattedMessage id={statusId} />
          {isLive && !unsaved && !busy && current.url && (
            <>
              {" "}
              <a href={current.url} target="_blank" rel="noopener" className={textLinkClass}>
                <FormattedMessage id="editor.view" />
              </a>
            </>
          )}
        </p>

        {inTrash ? (
          <div>
            <button
              type="button"
              disabled={busy}
              onClick={onRestore}
              className={primaryButtonClass}
            >
              <FormattedMessage id="list.restore" />
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            {/* aria-disabled, so a button that's just been used keeps keyboard focus. */}
            <button
              type="button"
              aria-disabled={!canPublish}
              onClick={onPublish}
              className={`${primaryButtonClass} aria-disabled:opacity-60`}
            >
              <FormattedMessage id={publishId} />
            </button>
            <button
              type="submit"
              aria-disabled={!canSave}
              className={`${secondaryButtonClass} aria-disabled:opacity-60`}
            >
              <FormattedMessage id="editor.save" />
            </button>
            {justUnpublished && (
              <button
                type="button"
                disabled={busy}
                onClick={onUndoUnpublish}
                className={secondaryButtonClass}
              >
                <FormattedMessage id="list.undo" />
              </button>
            )}
            {isLive && !current.isHome && (
              <button
                type="button"
                disabled={busy || locked}
                onClick={onUnpublish}
                className={secondaryButtonClass}
              >
                <FormattedMessage id="editor.unpublish" />
              </button>
            )}
            {!current.isHome && (
              <button
                type="button"
                disabled={busy || locked}
                onClick={onTrash}
                className={secondaryButtonClass}
              >
                <FormattedMessage id="editor.trash" />
              </button>
            )}
          </div>
        )}
      </form>
    </AdminLayout>
  );
}

function LoadedEditor({ me, id, type }: { me: Me; id: string; type: EntryType }) {
  const intl = useIntl();
  const entry = useQuery({
    queryKey: entryKey(id),
    queryFn: async () => {
      // A save from leaving this entry a moment ago might still be on its way, and this
      // mustn't overtake it and show the old text.
      await waitForSave(id);
      return api<EntryFull>(`/admin/entries/${id}`);
    },
    // The editor keeps its own copy once open, so nothing here may disturb it, and every
    // opening starts from what's really on the server.
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  if (entry.isPending) return <Loading />;
  if (entry.isLoadingError) {
    return (
      <AdminLayout me={me} screen={type === "post" ? "editor.post" : "editor.page"}>
        <p role="alert" className="mt-6 text-lg text-muted">
          {errorText(entry.error, intl.formatMessage({ id: "offline.body" }))}
        </p>
        <div className="mt-6 flex flex-wrap items-center gap-4">
          <button
            type="button"
            disabled={entry.isFetching}
            onClick={() => entry.refetch()}
            className={primaryButtonClass}
          >
            <FormattedMessage id={entry.isFetching ? "common.trying" : "common.tryAgain"} />
          </button>
          <Link href={type === "post" ? "/posts" : "/pages"} className={textLinkClass}>
            <FormattedMessage id={type === "post" ? "editor.backToPosts" : "editor.backToPages"} />
          </Link>
        </div>
      </AdminLayout>
    );
  }

  const held = getHeldDraft(id, me.user.id);
  const stillDiffers = held && !sameDraft(held.draft, draftFrom(entry.data));
  if (held && !stillDiffers) releaseDraft(id);
  return (
    <EditorScreen
      key={entry.data.id}
      me={me}
      entry={entry.data}
      type={type}
      held={stillDiffers ? held : undefined}
    />
  );
}

export function PostEditor({ params }: { params: { id: string } }) {
  return <SignedIn>{(me) => <LoadedEditor me={me} id={params.id} type="post" />}</SignedIn>;
}

export function PageEditor({ params }: { params: { id: string } }) {
  return <SignedIn>{(me) => <LoadedEditor me={me} id={params.id} type="page" />}</SignedIn>;
}
