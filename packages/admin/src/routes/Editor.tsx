import { type InfiniteData, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Node as PmNode } from "@tiptap/pm/model";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { FormattedMessage, type IntlShape, useIntl } from "react-intl";
import { Link, Redirect, useLocation } from "wouter";
import { AdminLayout, SignedIn } from "../components/AdminLayout.tsx";
import {
  Loading,
  primaryButtonClass,
  secondaryButtonClass,
  textLinkClass,
} from "../components/AuthLayout.tsx";
import { Field } from "../components/fields.tsx";
import { Problem } from "../components/Problem.tsx";
import { dismissToast, showToast } from "../components/Toast.tsx";
import { BodyEditor, type BodyHandle } from "../editor/BodyEditor.tsx";
import {
  type Check,
  type CheckTarget,
  findChecks,
  linkedIds,
  type PictureFacts,
} from "../editor/checks.ts";
import { FeaturedImageField, SearchFields, TagsField } from "../editor/EntrySettings.tsx";
import { HistoryDialog } from "../editor/HistoryDialog.tsx";
import { PreviewDialog } from "../editor/PreviewDialog.tsx";
import { PublishDialog } from "../editor/PublishDialog.tsx";
import { getUpload, isUploading, useUploadsChanged } from "../editor/uploads.ts";
import { ApiError, api, errorText, OFFLINE } from "../lib/api.ts";
import { cleanDoc, type Doc, docToText, imageIds, leadText, sameDoc } from "../lib/doc.ts";
import {
  completeDraft,
  type DraftFields,
  draftFields,
  draftsLoaded,
  type EditorDraft,
  getHeldDrafts,
  type HeldDraft,
  holdDraft,
  holdWindowOpen,
  keptOnDevice,
  registerBeforeSignOut,
  releaseDraft,
  releaseHeld,
  takeOverDraft,
  trackSave,
  useHeldDrafts,
  useKeptOnDevice,
  waitForSave,
} from "../lib/held-drafts.ts";
import { lookUpMedia } from "../lib/media.ts";
import {
  type EntryFull,
  type EntryPage,
  type EntrySummary,
  type EntryType,
  entriesKey,
  entryKey,
  type LinkTarget,
  ME_KEY,
  type Me,
  withoutEntry,
} from "../lib/queries.ts";

// PLAN.md §5: a copy on this device almost straight away, and the server soon after.
const HOLD_DELAY_MS = 250;
const HOLD_MAX_MS = 1000;
const SAVE_DELAY_MS = 1500;
const SAVE_MAX_MS = 10_000;
const BUSY_RECHECK_MS = 500;
const RETRY_MIN_MS = 2000;
const RETRY_MAX_MS = 30_000;
const ADDRESS_LIMIT = 100;
const LINK_LOOKUP_BATCH = 200;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Shows the address publishing will really use. Mirrors the server's rule, which forgives a
 * typed address starting with /blog/, but not a title that does.
 */
function toAddress(text: string, type: EntryType, from: "address" | "title" = "address"): string {
  const path = from === "title" ? text : text.trim().replace(/^\/+/, "");
  return (type === "post" && from === "address" ? path.replace(/^blog\//, "") : path)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, ADDRESS_LIMIT)
    .replace(/-+$/, "");
}

// aria-disabled rather than disabled, so a button that's just been used keeps keyboard focus,
// and a dialog it opens has somewhere to hand focus back to.
const actionButtonClass = `${secondaryButtonClass} aria-disabled:opacity-60`;

function newEditSession(): string {
  // Not crypto.randomUUID, which only exists on https and localhost.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Placeholders for pictures that haven't arrived: still uploading, or failed. */
function placeholderUploads(doc: PmNode | null): { going: number; failed: number } {
  let going = 0;
  let failed = 0;
  doc?.descendants((node) => {
    if (node.type.name === "image" && !node.attrs.mediaId && node.attrs.uploadId) {
      const upload = getUpload(node.attrs.uploadId as string);
      if (isUploading(upload)) going++;
      else if (!upload?.done) failed++;
    }
    return true;
  });
  return { going, failed };
}

function draftFrom(entry: EntryFull): EditorDraft {
  return completeDraft({
    title: entry.title,
    slug: entry.slug,
    summary: entry.data.summary ?? "",
    featuredImageId: entry.data.featuredImage?.mediaId ?? null,
    seoTitle: entry.data.seo?.title ?? "",
    seoDescription: entry.data.seo?.description ?? "",
    noindex: entry.data.seo?.noindex ?? false,
    tagIds: entry.data.tagIds ?? [],
    doc: cleanDoc(entry.data.doc),
  });
}

const FIELD_NAMES = [
  "title",
  "slug",
  "summary",
  "featuredImageId",
  "seoTitle",
  "seoDescription",
  "noindex",
  "tagIds",
] as const satisfies readonly (keyof DraftFields)[];

function sameDraft(a: EditorDraft, b: EditorDraft): boolean {
  return (
    FIELD_NAMES.every((name) => JSON.stringify(a[name]) === JSON.stringify(b[name])) &&
    sameDoc(a.doc, b.doc)
  );
}

/** Whether these are the same once the server has tidied them, as it does with every save. */
function sameOnceTidied(a: EditorDraft, b: EditorDraft, type: EntryType): boolean {
  return (
    a.title.trim() === b.title.trim() &&
    toAddress(a.slug, type) === toAddress(b.slug, type) &&
    a.summary.trim() === b.summary.trim() &&
    a.featuredImageId === b.featuredImageId &&
    a.seoTitle.trim() === b.seoTitle.trim() &&
    a.seoDescription.trim() === b.seoDescription.trim() &&
    a.noindex === b.noindex &&
    JSON.stringify(a.tagIds) === JSON.stringify(b.tagIds) &&
    sameDoc(a.doc, b.doc)
  );
}

/** Which window a request comes from, and its place in that window's order. */
interface Stamp {
  editSession: string;
  editSeq: number;
}

function saveRequest(
  id: string,
  rev: number,
  draft: EditorDraft,
  stamp: Stamp,
  options: { keepOtherVersion?: boolean } = {},
): Promise<EntryFull> {
  return api<EntryFull>(`/admin/entries/${id}`, {
    method: "PATCH",
    headers: { "If-Match": String(rev) },
    body: {
      title: draft.title,
      slug: draft.slug,
      summary: draft.summary.trim() === "" ? null : draft.summary,
      featuredImage: draft.featuredImageId ? { mediaId: draft.featuredImageId, alt: null } : null,
      seo: {
        title: draft.seoTitle.trim() || null,
        description: draft.seoDescription.trim() || null,
        noindex: draft.noindex,
      },
      tagIds: draft.tagIds,
      doc: draft.doc,
      ...stamp,
      ...options,
    },
  });
}

/** How long ago, in the largest unit that makes sense: never "4,320 minutes ago". */
function timeAgo(intl: IntlShape, time: number): string {
  const age = Math.max(0, Date.now() - time);
  if (age < MINUTE_MS) return intl.formatMessage({ id: "editor.justNow" });
  if (age < HOUR_MS) return intl.formatRelativeTime(-Math.round(age / MINUTE_MS), "minute");
  if (age < DAY_MS) return intl.formatRelativeTime(-Math.round(age / HOUR_MS), "hour");
  return intl.formatRelativeTime(-Math.round(age / DAY_MS), "day");
}

/** The parts of a session needed to read what's in the boxes right now. */
interface DraftSource {
  fields: DraftFields;
  pmDoc: PmNode | null;
  readFrom: PmNode | null;
  doc: Doc;
}

/** Reads the editor only if it's changed since last time, and works after it's gone. */
function readDraft(source: DraftSource): EditorDraft {
  if (source.pmDoc && source.pmDoc !== source.readFrom) {
    source.doc = cleanDoc(source.pmDoc.toJSON());
    source.readFrom = source.pmDoc;
  }
  return { ...source.fields, doc: source.doc };
}

type Activity =
  | "preparing"
  | "publishing"
  | "unpublishing"
  | "trashing"
  | "restoring"
  | "discarding"
  | "reverting"
  | "duplicating"
  | "resolving";

/** While these run, the words are about to be replaced or put away, so typing waits. */
const REPLACES_THE_WORDS = new Set<Activity>([
  "trashing",
  "discarding",
  "reverting",
  "duplicating",
  "resolving",
]);

/** Why the newest words aren't on the server. Each says so differently (PLAN.md P15). */
type SaveTrouble = "offline" | "signedOut" | "problem" | null;

/** Which entries have an editor open in this tab, and any toast left over from leaving one. */
const openEditors = new Map<string, number>();
const leavingToasts = new Map<string, number>();

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
  const bodyLabelId = useId();
  const titleRef = useRef<HTMLInputElement>(null);
  const slugRef = useRef<HTMLInputElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const bodyRef = useRef<BodyHandle>(null);
  const conflictRef = useRef<HTMLDivElement>(null);

  const serverDraft = draftFrom(entry);
  const startingDraft = held?.draft ?? serverDraft;
  const [current, setCurrent] = useState(entry);
  const [fields, setFields] = useState(draftFields(startingDraft));
  const [unsaved, setUnsaved] = useState(held !== undefined);
  const [saving, setSaving] = useState(false);
  const [trouble, setTroubleState] = useState<SaveTrouble>(null);
  const [problem, setProblem] = useState<unknown>(null);
  const [fieldError, setFieldError] = useState<{ field: string; message: string } | null>(null);
  const [conflict, setConflict] = useState<EntryFull | null>(null);
  const [activity, setActivity] = useState<Activity | null>(null);
  const [restoredHeld, setRestoredHeld] = useState(held !== undefined);
  const [justUnpublished, setJustUnpublished] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [review, setReview] = useState<{ checks: Check[]; done: boolean } | null>(null);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const onDevice = useKeptOnDevice();

  // The same facts, readable after this screen has gone, because a save can outlive it. A
  // held draft keeps the version it was based on, so if the entry has changed since, saving
  // raises a conflict rather than overwriting. The window ID is always new: reusing one
  // would tell the server that this window had seen changes it never saw.
  const session = useRef({
    fields: draftFields(startingDraft),
    /** The newest text from the editor. Immutable, so it's safe to keep after the editor has gone. */
    pmDoc: null as PmNode | null,
    readFrom: null as PmNode | null,
    doc: startingDraft.doc,
    saved: serverDraft,
    entry,
    rev: held?.rev ?? entry.rev,
    editSession: newEditSession(),
    running: Promise.resolve() as Promise<unknown>,
    busy: false,
    /** Nothing more to save, ever: it's in the Trash, say, or a new one is being opened. */
    done: false,
    /** The screen has gone. Only the last save on leaving is still allowed to happen. */
    closed: false,
    locked: entry.trashedAt !== null,
    /** A draft brought back from this device waits to be looked at before it's saved. */
    heldUntouched: held?.draft ?? (null as EditorDraft | null),
    /** What the server kept when a save lost out to someone else's. */
    keptInConflict: null as EditorDraft | null,
    trouble: null as SaveTrouble,
    /**
     * The server refused the last save for what it held, like being too big. No retry is
     * coming, because the same words would be refused again, so the next change tries.
     */
    retryOnChange: false,
    /**
     * A request went out and no answer came back, so the server may or may not have it. Until
     * one is confirmed, what's on the screen counts as unsaved, and it's sent again.
     */
    unconfirmed: false,
    /** How many requests this window has sent, so the server can put them in order. */
    seq: 0,
    /** Someone pressed Ctrl+S, so they should hear how it went. */
    announceNextSave: false,
    firstChangeAt: null as number | null,
    firstUnsavedAt: null as number | null,
    holdTimer: undefined as ReturnType<typeof setTimeout> | undefined,
    saveTimer: undefined as ReturnType<typeof setTimeout> | undefined,
    retryDelay: RETRY_MIN_MS,
    undoToast: undefined as number | undefined,
  });

  const listPath = type === "post" ? "/posts" : "/pages";
  const isLive = current.url !== null;
  const inTrash = current.trashedAt !== null;
  const canPublishRole = me.user.role !== "writer";
  const hasPendingChanges = isLive && (current.dirty || unsaved);
  const offlineText = intl.formatMessage({ id: "offline.body" });
  const busy = activity !== null;
  const locked = conflict !== null || inTrash;
  const readOnly = locked || (activity !== null && REPLACES_THE_WORDS.has(activity));
  session.current.locked = locked;

  function draftNow(): EditorDraft {
    return readDraft(session.current);
  }

  function differsFromSaved(): boolean {
    return session.current.unconfirmed || !sameDraft(draftNow(), session.current.saved);
  }

  function stamp(): Stamp {
    const s = session.current;
    s.seq += 1;
    return { editSession: s.editSession, editSeq: s.seq };
  }

  function setTrouble(next: SaveTrouble): void {
    session.current.trouble = next;
    session.current.retryOnChange = false;
    setTroubleState(next);
  }

  /** Says it to a screen reader, even if it's the same words as last time. */
  function announce(id: string): void {
    setAnnouncement("");
    const words = intl.formatMessage({ id });
    requestAnimationFrame(() => setAnnouncement(words));
  }

  function keepOnDevice(draft: EditorDraft): void {
    const s = session.current;
    holdDraft({
      id: entry.id,
      type,
      userId: me.user.id,
      rev: s.rev,
      editSession: s.editSession,
      draft,
      heldAt: Date.now(),
    });
  }

  function scheduleSave(): void {
    const s = session.current;
    // While saving isn't working, retries go at their own slowing pace, not with each word.
    // After a refusal there are no retries, so a change is what tries again.
    if (s.trouble !== null && !s.retryOnChange) return;
    clearTimeout(s.saveTimer);
    if (s.done || s.closed || s.locked || s.heldUntouched) return;
    const now = Date.now();
    s.firstUnsavedAt ??= now;
    const wait = Math.min(SAVE_DELAY_MS - HOLD_DELAY_MS, s.firstUnsavedAt + SAVE_MAX_MS - now);
    s.saveTimer = setTimeout(autosave, Math.max(0, wait));
  }

  /** Runs a moment after typing: copies it to this device, and lines up the save. */
  function settle(): void {
    const s = session.current;
    clearTimeout(s.holdTimer);
    s.firstChangeAt = null;
    if (s.done || s.closed) return;
    const draft = draftNow();
    if (s.heldUntouched && !sameDraft(draft, s.heldUntouched)) s.heldUntouched = null;
    if (!s.unconfirmed && sameDraft(draft, s.saved)) {
      clearTimeout(s.saveTimer);
      s.firstUnsavedAt = null;
      s.heldUntouched = null;
      setUnsaved(false);
      setRestoredHeld(false);
      setTrouble(null);
      setProblem(null);
      releaseDraft(entry.id, s.editSession);
      return;
    }
    setUnsaved(true);
    setJustUnpublished(false);
    keepOnDevice(draft);
    scheduleSave();
  }

  function noteChange(): void {
    const s = session.current;
    if (s.done || s.closed) return;
    clearTimeout(s.holdTimer);
    // At once, so the status never says Saved about words that have only just been typed.
    setUnsaved(true);
    const now = Date.now();
    s.firstChangeAt ??= now;
    const wait = Math.min(HOLD_DELAY_MS, s.firstChangeAt + HOLD_MAX_MS - now);
    s.holdTimer = setTimeout(settle, Math.max(0, wait));
  }

  function changeField<K extends keyof DraftFields>(name: K, value: DraftFields[K]): void {
    session.current.fields = { ...session.current.fields, [name]: value };
    setFields(session.current.fields);
    setFieldError(null);
    noteChange();
  }

  /** The server has this version. The boxes are left alone, because people type past a save. */
  function acceptSave(next: EntryFull, sent: EditorDraft): void {
    const s = session.current;
    const wasInTrouble = s.trouble !== null;
    s.saved = sent;
    s.rev = next.rev;
    s.entry = next;
    s.unconfirmed = false;
    s.firstUnsavedAt = null;
    s.retryDelay = RETRY_MIN_MS;
    setCurrent(next);
    setTrouble(null);
    setProblem(null);
    void queryClient.invalidateQueries({ queryKey: entriesKey(type) });
    const latest = draftNow();
    if (sameDraft(latest, sent)) {
      s.heldUntouched = null;
      setUnsaved(false);
      setRestoredHeld(false);
      releaseDraft(entry.id, s.editSession);
      if (wasInTrouble || s.announceNextSave) {
        announce(!next.url ? "editor.saved" : next.dirty ? "status.changes" : "status.onSite");
      }
    } else {
      setUnsaved(true);
      keepOnDevice(latest);
      if (!s.busy) scheduleSave();
    }
    s.announceNextSave = false;
  }

  /**
   * Takes on an answer from publishing and the like, which can change the address or title.
   * A box only changes if it still holds what was sent: anything typed meanwhile is newer.
   */
  function acceptAnswer(next: EntryFull, sent: EditorDraft): void {
    const s = session.current;
    const answer = draftFrom(next);
    const typed = draftNow();
    const keep = <K extends keyof DraftFields>(name: K): DraftFields[K] =>
      JSON.stringify(typed[name]) === JSON.stringify(sent[name]) ? answer[name] : typed[name];
    s.fields = {
      title: keep("title"),
      slug: keep("slug"),
      summary: keep("summary"),
      featuredImageId: keep("featuredImageId"),
      seoTitle: keep("seoTitle"),
      seoDescription: keep("seoDescription"),
      noindex: keep("noindex"),
      tagIds: keep("tagIds"),
    };
    setFields(s.fields);
    acceptSave(next, answer);
  }

  /** Replaces everything with a version from the server, including the words on the screen. */
  function takeVersion(next: EntryFull): void {
    const s = session.current;
    const version = draftFrom(next);
    s.fields = draftFields(version);
    setFields(s.fields);
    s.doc = version.doc;
    s.heldUntouched = null;
    s.keptInConflict = null;
    clearTimeout(s.holdTimer);
    s.firstChangeAt = null;
    bodyRef.current?.setDoc(version.doc);
    s.locked = next.trashedAt !== null;
    setConflict(null);
    setFieldError(null);
    setRestoredHeld(false);
    acceptSave(next, version);
    // Anything from before, like what that version just replaced, has been dealt with.
    releaseDraft(entry.id, s.editSession);
  }

  async function showConflict(error: ApiError, sent: EditorDraft | null): Promise<void> {
    const s = session.current;
    // A save's answer includes the other version, and a publish's doesn't.
    const theirs =
      (error.current as EntryFull | undefined) ??
      (await api<EntryFull>(`/admin/entries/${entry.id}`));
    // The words on screen go to this device first: the panel can be up for a long time.
    const latest = draftNow();
    if (!sameDraft(latest, s.saved)) keepOnDevice(latest);
    s.locked = true;
    s.keptInConflict = sent;
    clearTimeout(s.saveTimer);
    clearTimeout(s.holdTimer);
    s.firstChangeAt = null;
    setSaving(false);
    setReview(null);
    setHistoryOpen(false);
    setConflict(theirs);
  }

  /**
   * The server kept what the losing save sent. Anything typed while that was on its way
   * isn't in it, so this sends those words too, before they're replaced. It's refused, as it's
   * bound to be, and being refused is what stores it.
   */
  async function keepWordsTypedSince(): Promise<void> {
    const s = session.current;
    const latest = draftNow();
    if (sameDraft(latest, s.saved)) return;
    if (s.keptInConflict && sameDraft(latest, s.keptInConflict)) return;
    try {
      await saveRequest(entry.id, s.rev, latest, stamp());
    } catch (error) {
      if (!(error instanceof ApiError && error.code === "edit_conflict")) throw error;
    }
    s.keptInConflict = latest;
  }

  async function report(error: unknown): Promise<void> {
    // No answer, so it may or may not have happened. Sending the words on screen again puts
    // the server back in step with what this window shows, whichever it was.
    if (mayHaveArrived(error)) {
      session.current.unconfirmed = true;
    }
    if (error instanceof ApiError && error.code === "edit_conflict") {
      try {
        await showConflict(error, null);
      } catch (lookup) {
        setProblem(lookup);
      }
      return;
    }
    if (error instanceof ApiError && (error.field === "title" || error.field === "slug")) {
      setReview(null);
      setFieldError({ field: error.field, message: errorText(error, offlineText) });
      goToField(error.field);
      return;
    }
    setProblem(error);
  }

  function goToField(field: "title" | "slug"): void {
    if (field === "slug") setSettingsOpen(true);
    // After anything open has closed and handed focus back, and the settings have opened,
    // because something hidden can't take focus.
    requestAnimationFrame(() => (field === "title" ? titleRef : slugRef).current?.focus());
  }

  /** Leads to what a check is about, for its Fix button. */
  function goToCheck(target: CheckTarget): void {
    setReview(null);
    if (target.kind === "slug") {
      goToField("slug");
      return;
    }
    // Once the review has closed and handed focus back, or it would take it again.
    requestAnimationFrame(() => {
      if (!bodyRef.current?.goTo(target)) statusRef.current?.focus();
    });
  }

  /** Says it's on the site, with the way to see it there (PLAN.md J1). */
  function sayPublished(url: string | null): void {
    showToast({
      message: intl.formatMessage({ id: "publish.done" }),
      ...(url
        ? {
            action: {
              label: intl.formatMessage({
                id: type === "post" ? "publish.viewPost" : "publish.viewPage",
              }),
              run: () => window.open(url, "_blank", "noopener"),
            },
          }
        : {}),
    });
  }

  function retrySoon(): void {
    const s = session.current;
    clearTimeout(s.saveTimer);
    if (s.closed || s.done || s.locked) return;
    s.saveTimer = setTimeout(autosave, s.retryDelay);
    s.retryDelay = Math.min(s.retryDelay * 2, RETRY_MAX_MS);
  }

  /** Sets the trouble, and tells a screen reader only when it's news. */
  function troubleIs(next: Exclude<SaveTrouble, null>, messageId?: string): void {
    const s = session.current;
    const changed = s.trouble !== next;
    setTrouble(next);
    if (changed && messageId) announce(messageId);
  }

  async function saveFailed(error: unknown, sent: EditorDraft): Promise<void> {
    const s = session.current;
    if (mayHaveArrived(error)) s.unconfirmed = true;
    // Whoever's left the screen is told by the notice if the last save on leaving fails too.
    // Starting retries from here would have a closed window saving over newer work.
    if (s.closed) return;
    s.announceNextSave = false;
    // Undone back to what the server has, and nothing in doubt: there's nothing to tell.
    if (!differsFromSaved()) {
      setTrouble(null);
      setProblem(null);
      return;
    }
    if (error instanceof ApiError) {
      if (error.code === "edit_conflict") {
        try {
          await showConflict(error, sent);
        } catch (lookup) {
          setProblem(lookup);
        }
        return;
      }
      if (error.status === 401) {
        troubleIs("signedOut", keptOnDevice() ? "editor.signedOut" : "editor.signedOutTab");
        return;
      }
      if (error.code === OFFLINE) {
        troubleIs("offline", keptOnDevice() ? "editor.offlineKept" : "editor.offlineTab");
        retrySoon();
        return;
      }
      if (error.status >= 500 || error.status === 429) {
        troubleIs("problem");
        setProblem(error);
        retrySoon();
        return;
      }
    }
    troubleIs("problem");
    setProblem(error);
    // Refused for what was sent, like being too big or not making sense. What fixes it is a
    // change, so the next one is saved after the usual pause, not straight away.
    s.retryOnChange = true;
    s.firstUnsavedAt = null;
  }

  /** Saves if anything's waiting. Never throws: whatever goes wrong shows in the status. */
  async function saveStep(): Promise<void> {
    const s = session.current;
    if (s.done || s.closed || s.locked || !differsFromSaved()) return;
    const sent = draftNow();
    keepOnDevice(sent);
    setSaving(true);
    try {
      acceptSave(await saveRequest(entry.id, s.rev, sent, stamp()), sent);
    } catch (error) {
      await saveFailed(error, sent);
    } finally {
      setSaving(false);
    }
  }

  function autosave(): Promise<unknown> {
    const s = session.current;
    if (s.closed) return s.running;
    if (s.busy) {
      clearTimeout(s.saveTimer);
      s.saveTimer = setTimeout(autosave, BUSY_RECHECK_MS);
      return s.running;
    }
    s.running = s.running.then(saveStep);
    return s.running;
  }

  /** Saves right now, and lets any problem through to whoever needs this done first. */
  async function saveFirst(): Promise<void> {
    const s = session.current;
    if (!differsFromSaved()) return;
    const sent = draftNow();
    keepOnDevice(sent);
    s.heldUntouched = null;
    try {
      acceptSave(await saveRequest(entry.id, s.rev, sent, stamp()), sent);
    } catch (error) {
      if (error instanceof ApiError && error.code === "edit_conflict") {
        await showConflict(error, sent);
        // Handled: the panel's up, and whatever this was for can't go ahead.
        throw new StoppedForConflict();
      }
      throw error;
    }
  }

  /** One action at a time, showing whatever it finds without losing what's typed. */
  function run(
    kind: Activity,
    action: () => Promise<void>,
    options: { wait?: boolean; evenIfClosed?: boolean } = {},
  ): void {
    const s = session.current;
    if (s.closed) {
      // A toast's Undo can outlive the screen, and pressing it still has to do something.
      if (options.evenIfClosed) {
        void s.running
          .then(action)
          .catch((error) => showToast({ message: errorText(error, offlineText), sticky: true }));
      }
      return;
    }
    if (s.busy) {
      // A toast's Undo mustn't vanish without doing anything just because it's mid-something.
      if (options.wait) void s.running.finally(() => run(kind, action, options));
      return;
    }
    s.busy = true;
    // What's typed goes to this device before anything else happens, and the status catches up.
    settle();
    clearTimeout(s.saveTimer);
    // An old Undo would now act on an older state than the one about to exist. Only looking,
    // as Preview does, changes nothing, so the Undo stays.
    if (kind !== "preparing" && s.undoToast !== undefined) dismissToast(s.undoToast);
    setActivity(kind);
    setProblem(null);
    setFieldError(null);
    setJustUnpublished(false);
    s.running = s.running
      .then(action)
      .catch((error) => (error instanceof StoppedForConflict ? undefined : report(error)))
      .finally(() => {
        s.busy = false;
        setActivity(null);
        if (!s.done && !s.closed && !s.heldUntouched && differsFromSaved()) scheduleSave();
      });
  }

  function actionBody(extra: Record<string, unknown> = {}): {
    method: "POST";
    headers: Record<string, string>;
    body: Record<string, unknown>;
  } {
    const s = session.current;
    return {
      method: "POST",
      headers: { "If-Match": String(s.rev) },
      body: { ...stamp(), ...extra },
    };
  }

  async function publishNow(options: { addToMenu?: boolean } = {}): Promise<void> {
    const s = session.current;
    const sent = s.saved;
    acceptAnswer(
      await api<EntryFull>(`/admin/entries/${entry.id}/publish`, actionBody(options)),
      sent,
    );
    if (options.addToMenu) void queryClient.invalidateQueries({ queryKey: ["menus"] });
    // Anything a toast was offering to undo, or telling someone to publish, is behind them now.
    if (s.undoToast !== undefined) dismissToast(s.undoToast);
  }

  /** Whether each picture is described, as Media says now. */
  async function pictureFacts(doc: Doc): Promise<PictureFacts[]> {
    const ids = imageIds(doc);
    if (ids.length === 0) return [];
    try {
      // In batches, like links: a gallery can have hundreds of pictures.
      const found = new Map((await lookUpMedia(ids)).map((item) => [item.id, item]));
      return ids.map((id) => {
        const item = found.get(id);
        return {
          id,
          described: Boolean(item && (item.decorative || item.alt)),
          gone: !item || item.trashedAt !== null,
        };
      });
    } catch {
      return [];
    }
  }

  async function findReviewChecks(saved: EditorDraft): Promise<Check[]> {
    const ids = linkedIds(saved.doc);
    const pictures = await pictureFacts(saved.doc);
    const arriving = placeholderUploads(session.current.pmDoc);
    const uploadChecks: Check[] = [
      ...(arriving.going > 0
        ? [{ id: "check.uploading", values: { count: String(arriving.going) } }]
        : []),
      ...(arriving.failed > 0
        ? [
            {
              id: "check.uploadFailed",
              values: { count: String(arriving.failed) },
              target: { kind: "upload" as const },
            },
          ]
        : []),
    ];
    const s = session.current.entry;
    const from = s.url;
    const to = s.address.path;
    const move = from && from !== to ? { from, to } : null;
    try {
      // In batches, because a long index page can link to hundreds of things.
      const targets: LinkTarget[] = [];
      for (let start = 0; start < ids.length; start += LINK_LOOKUP_BATCH) {
        const batch = ids.slice(start, start + LINK_LOOKUP_BATCH);
        const reply = await api<{ targets: LinkTarget[] }>(
          `/admin/link-targets?ids=${batch.join(",")}`,
        );
        targets.push(...reply.targets);
      }
      const untitled = intl.formatMessage({ id: "list.untitled" });
      return [
        ...uploadChecks,
        ...findChecks(
          saved.doc,
          targets.map((target) => ({ ...target, title: target.title || untitled })),
          move,
          pictures,
        ),
      ];
    } catch {
      // Only a courtesy, so it's no reason to stand in the way of publishing.
      return [
        ...uploadChecks,
        ...findChecks(
          saved.doc,
          ids.map((id) => ({ id, type, title: "", url: "/" })),
          move,
          pictures,
        ),
      ];
    }
  }

  function onPublish(): void {
    if (session.current.locked || (isLive && !hasPendingChanges)) return;
    run("preparing", async () => {
      await saveFirst();
      const s = session.current;
      const checks = await findReviewChecks(s.saved);
      const blocked = s.entry.title.trim() === "" || s.entry.address.problem !== null;
      // Publishing changes is a routine thing, so it only stops if there's something to say.
      if (s.entry.url && checks.length === 0 && !blocked) {
        await publishNow();
        sayPublished(session.current.entry.url);
      } else {
        setReview({ checks, done: false });
      }
    });
  }

  function onConfirmPublish(options: { addToMenu: boolean }): void {
    const firstTime = session.current.entry.url === null;
    run("publishing", async () => {
      await saveFirst();
      await publishNow(options);
      setReview((open) => (open && firstTime ? { ...open, done: true } : null));
      if (!firstTime) sayPublished(session.current.entry.url);
    });
  }

  function onUnpublish(): void {
    run("unpublishing", async () => {
      await saveFirst();
      const s = session.current;
      const sent = s.saved;
      // The menu only shows what's on the site, so its link goes too, until it's back.
      const wasInMenu = s.entry.type === "page" && s.entry.menu?.inMenu === true;
      const reply = await api<EntryFull & { wasLiveRevisionId: string | null }>(
        `/admin/entries/${entry.id}/unpublish`,
        actionBody(),
      );
      acceptAnswer(reply, sent);
      setJustUnpublished(true);
      const { wasLiveRevisionId } = reply;
      s.undoToast = showToast({
        message: intl.formatMessage({
          id: wasInMenu ? "editor.takenOffMenu" : "editor.takenOff",
        }),
        ...(wasLiveRevisionId
          ? {
              action: {
                label: intl.formatMessage({ id: "list.undo" }),
                run: () => {
                  run(
                    "publishing",
                    async () => {
                      // The same version that was live, not whatever's being worked on.
                      const kept = session.current.saved;
                      acceptAnswer(
                        await api<EntryFull>(
                          `/admin/entries/${entry.id}/undo-unpublish`,
                          actionBody({ revisionId: wasLiveRevisionId }),
                        ),
                        kept,
                      );
                      statusRef.current?.focus();
                      if (session.current.closed) {
                        showToast({ message: intl.formatMessage({ id: "editor.backOnSite" }) });
                      }
                    },
                    { wait: true, evenIfClosed: true },
                  );
                },
              },
            }
          : {}),
      });
      statusRef.current?.focus();
    });
  }

  function onDiscard(): void {
    run("discarding", async () => {
      await saveFirst();
      const s = session.current;
      const reply = await api<EntryFull & { keptRevisionId: string }>(
        `/admin/entries/${entry.id}/discard-changes`,
        actionBody(),
      );
      takeVersion(reply);
      statusRef.current?.focus();
      s.undoToast = showToast({
        message: intl.formatMessage({ id: "editor.discarded" }),
        action: {
          label: intl.formatMessage({ id: "list.undo" }),
          // Taking back a discard brings back a changed address, too: those were this
          // person's own changes, not an old version from History.
          run: () =>
            bringBack(reply.keptRevisionId, () => "editor.discardUndone", {
              includeAddress: true,
              evenIfClosed: true,
            }),
        },
      });
    });
  }

  function bringBack(
    revisionId: string,
    messageFor: (version: EntryFull) => string,
    options: { includeAddress?: boolean; evenIfClosed?: boolean } = {},
  ): void {
    run(
      "reverting",
      async () => {
        await saveFirst();
        const version = await api<EntryFull>(
          `/admin/revisions/${revisionId}/restore`,
          actionBody(options.includeAddress ? { includeAddress: true } : {}),
        );
        takeVersion(version);
        setHistoryOpen(false);
        session.current.undoToast = showToast({
          message: intl.formatMessage({ id: messageFor(version) }),
        });
      },
      { wait: true, evenIfClosed: options.evenIfClosed ?? false },
    );
  }

  function onPreview(): void {
    // Looking at a copy left on this device mustn't decide for the person to keep it.
    if (session.current.heldUntouched) return;
    run("preparing", async () => {
      await saveFirst();
      const reply = await api<{ html: string }>(`/admin/preview/${entry.id}`);
      setPreviewHtml(reply.html);
    });
  }

  function onDuplicate(): void {
    run("duplicating", async () => {
      await saveFirst();
      const copy = await api<EntryFull>(`/admin/entries/${entry.id}/duplicate`, {
        method: "POST",
      });
      session.current.done = true;
      void queryClient.invalidateQueries({ queryKey: entriesKey(type) });
      navigate(`${listPath}/${copy.id}`);
      showToast({ message: intl.formatMessage({ id: "editor.duplicated" }) });
    });
  }

  function onWriteAnother(): void {
    // Typing waits too: the screen is about to move on, and nothing typed should be left behind.
    run("duplicating", async () => {
      await saveFirst();
      const next = await api<EntrySummary>("/admin/entries", { method: "POST", body: { type } });
      session.current.done = true;
      navigate(`${listPath}/${next.id}`);
    });
  }

  function onTrash(): void {
    const s = session.current;
    const wasLive = isLive;
    run("trashing", async () => {
      await saveFirst();
      await api(`/admin/entries/${entry.id}/trash`, { method: "POST" });
      s.done = true;
      releaseDraft(entry.id, s.editSession);
      queryClient.removeQueries({ queryKey: entryKey(entry.id) });
      // Off the list straight away, rather than sitting beside "Moved to the Trash".
      queryClient.setQueriesData<InfiniteData<EntryPage>>(
        { queryKey: entriesKey(type), predicate: ({ queryKey }) => !queryKey.includes("trash") },
        (data) => withoutEntry(data, entry.id),
      );
      const refreshLists = () => {
        void queryClient.invalidateQueries({ queryKey: entriesKey(type) });
      };
      refreshLists();
      navigate(listPath);
      showToast({
        message: intl.formatMessage({
          id: wasLive ? "list.movedToTrash" : "list.movedDraftToTrash",
        }),
        action: {
          label: intl.formatMessage({ id: "list.undo" }),
          run: () => {
            void api(`/admin/entries/${entry.id}/restore`, { method: "POST" })
              .then(() => {
                refreshLists();
                showToast({
                  message: intl.formatMessage({
                    id: wasLive ? "list.restored" : "list.restoredDraft",
                  }),
                });
              })
              .catch((error) => {
                showToast({ message: errorText(error, offlineText), sticky: true });
              });
          },
        },
      });
    });
  }

  function onRestore(): void {
    run("restoring", async () => {
      const s = session.current;
      // Based on an older version, as a copy left on this device can be. It mustn't pick up
      // the newest version number, or keeping it would go over newer words without asking.
      const basedOnOlder = s.rev !== s.entry.rev;
      const next = await api<EntryFull>(`/admin/entries/${entry.id}/restore`, { method: "POST" });
      s.locked = false;
      if (!basedOnOlder && sameDraft(draftFrom(next), s.saved)) {
        acceptAnswer(next, s.saved);
      } else if (!differsFromSaved()) {
        // Someone else changed it meanwhile, and nothing here is unsaved: show theirs.
        takeVersion(next);
      } else {
        // Changes here, and different ones there. Saving these will ask which to keep.
        s.entry = next;
        setCurrent(next);
        if (!s.heldUntouched) scheduleSave();
      }
      void queryClient.invalidateQueries({ queryKey: entriesKey(type) });
      statusRef.current?.focus();
    });
  }

  function takeNewest(): void {
    const theirs = conflict;
    if (!theirs) return;
    run("resolving", async () => {
      // If this fails, nothing's replaced, and the choice is still there to make.
      await keepWordsTypedSince();
      takeVersion(theirs);
      statusRef.current?.focus();
    });
  }

  function keepMine(): void {
    const theirs = conflict;
    if (!theirs) return;
    run("resolving", async () => {
      const s = session.current;
      const sent = draftNow();
      // Theirs is kept as a revision, so choosing this doesn't destroy it.
      const next = await saveRequest(entry.id, theirs.rev, sent, stamp(), {
        keepOtherVersion: true,
      });
      s.locked = false;
      s.keptInConflict = null;
      setConflict(null);
      acceptSave(next, sent);
      statusRef.current?.focus();
    });
  }

  function discardHeld(): void {
    const s = session.current;
    const thrownAway = readDraft(s);
    const thrownAwayRev = s.rev;
    const version = s.saved;
    s.rev = s.entry.rev;
    s.fields = draftFields(version);
    setFields(s.fields);
    s.doc = version.doc;
    s.heldUntouched = null;
    bodyRef.current?.setDoc(version.doc);
    setUnsaved(false);
    setRestoredHeld(false);
    setConflict(null);
    setFieldError(null);
    setProblem(null);
    setTrouble(null);
    s.locked = s.entry.trashedAt !== null;
    releaseDraft(entry.id, s.editSession);
    statusRef.current?.focus();
    s.undoToast = showToast({
      message: intl.formatMessage({ id: "editor.heldDiscarded" }),
      action: {
        label: intl.formatMessage({ id: "list.undo" }),
        run: () => {
          if (session.current.closed) {
            // Back on this device, to be offered again next time it's opened.
            holdDraft({
              id: entry.id,
              type,
              userId: me.user.id,
              rev: thrownAwayRev,
              editSession: s.editSession,
              draft: thrownAway,
              heldAt: Date.now(),
            });
            return;
          }
          s.rev = thrownAwayRev;
          s.fields = draftFields(thrownAway);
          setFields(s.fields);
          s.doc = thrownAway.doc;
          bodyRef.current?.setDoc(thrownAway.doc);
          s.heldUntouched = thrownAway;
          setUnsaved(true);
          setRestoredHeld(true);
          keepOnDevice(thrownAway);
          statusRef.current?.focus();
        },
      },
    });
  }

  function saveNowByHand(): void {
    const s = session.current;
    settle();
    if (s.locked) {
      announce(s.entry.trashedAt !== null ? "editor.inTrash" : "editor.conflictStatus");
      return;
    }
    s.heldUntouched = null;
    if (differsFromSaved()) {
      s.announceNextSave = true;
      s.retryDelay = RETRY_MIN_MS;
      announce("editor.saving");
      void autosave();
    } else {
      const { entry: latest } = s;
      announce(!latest.url ? "editor.saved" : latest.dirty ? "status.changes" : "status.onSite");
    }
  }

  // Latest versions of these, for listeners that outlive a render.
  const handlers = useRef({ settle, autosave, saveNowByHand });
  handlers.current = { settle, autosave, saveNowByHand };

  // This window is open, so what it's holding isn't anybody else's to pick up.
  useEffect(() => {
    const s = session.current;
    if (held) {
      takeOverDraft(held.key, {
        id: held.id,
        type: held.type,
        userId: held.userId,
        rev: held.rev,
        editSession: s.editSession,
        draft: held.draft,
        heldAt: held.heldAt,
      });
    }
    return holdWindowOpen(s.editSession);
  }, [held]);

  useEffect(() => {
    // Coming back online or back to this tab shouldn't have to wait for the next retry, and
    // someone who signed in again in another tab shouldn't have to type before it notices.
    const tryAgain = () => {
      const s = session.current;
      if (s.heldUntouched || s.locked || s.trouble === null) return;
      s.retryDelay = RETRY_MIN_MS;
      void handlers.current.autosave();
    };
    // A phone can drop a page in the background without warning, so this is the last chance.
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        tryAgain();
        return;
      }
      handlers.current.settle();
      if (!session.current.heldUntouched) void handlers.current.autosave();
    };
    // Both, because the earlier one gives the copy on this device more time to finish.
    const onPageHide = () => handlers.current.settle();
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        handlers.current.saveNowByHand();
      }
    };
    window.addEventListener("online", tryAgain);
    window.addEventListener("focus", tryAgain);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("beforeunload", onPageHide);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("online", tryAgain);
      window.removeEventListener("focus", tryAgain);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("beforeunload", onPageHide);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  // The copy on this device covers closing the tab, so nobody needs asking. If this device
  // can't store anything, there's no such copy, and the browser's warning is all that's left.
  useEffect(() => {
    if (!unsaved) return;
    const warn = (event: BeforeUnloadEvent) => {
      if (!keptOnDevice()) event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsaved]);

  // Signing out waits for the save, and doesn't go ahead if it fails. Nothing here stops the
  // editor, because signing out can still fail after this, leaving someone carrying on.
  useEffect(
    () =>
      registerBeforeSignOut(async () => {
        const s = session.current;
        handlers.current.settle();
        await s.running;
        if (s.done || s.closed || s.heldUntouched) return;
        const sent = readDraft(s);
        if (!s.unconfirmed && sameDraft(sent, s.saved)) return;
        clearTimeout(s.saveTimer);
        try {
          handlers2.current.acceptSave(
            await saveRequest(entry.id, s.rev, sent, handlers2.current.stamp()),
            sent,
          );
        } catch (error) {
          await handlers2.current.saveFailed(error, sent);
          throw error;
        }
      }),
    [entry.id],
  );
  const handlers2 = useRef({ saveFailed, acceptSave, stamp });
  handlers2.current = { saveFailed, acceptSave, stamp };

  // An old toast about this entry would act on an older version than the one now open.
  useEffect(() => {
    const leftover = leavingToasts.get(entry.id);
    if (leftover !== undefined) {
      dismissToast(leftover);
      leavingToasts.delete(entry.id);
    }
    openEditors.set(entry.id, (openEditors.get(entry.id) ?? 0) + 1);
    return () => {
      const count = (openEditors.get(entry.id) ?? 1) - 1;
      if (count > 0) openEditors.set(entry.id, count);
      else openEditors.delete(entry.id);
    };
  }, [entry.id]);

  // The panel takes focus when typing was what got interrupted. Locking the text drops focus.
  const hasConflict = conflict !== null;
  useEffect(() => {
    if (!hasConflict) return;
    const active = document.activeElement;
    if (!active || active === document.body || active.closest?.(".tend-prose")) {
      conflictRef.current?.focus();
    }
  }, [hasConflict]);

  // Moving elsewhere in the admin saves what's typed: nobody should lose work by clicking a
  // link. It waits for anything still running, so it uses the newest version number. If it
  // fails, the draft stays held, and the admin says so. A draft brought back from this
  // device that nobody's decided about stays as it is. The check is deferred because
  // StrictMode unmounts and remounts straight away, which isn't really leaving.
  const mounted = useRef(false);
  const leaving = useRef({ intl, canPublishRole, offlineText });
  leaving.current = { intl, canPublishRole, offlineText };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const s = session.current;
      clearTimeout(s.saveTimer);
      clearTimeout(s.holdTimer);
      queueMicrotask(() => {
        if (mounted.current) return;
        s.closed = true;
        if (s.done) return;
        if (s.undoToast !== undefined) dismissToast(s.undoToast);
        const read = () => readDraft(s);
        if (s.unconfirmed || !sameDraft(read(), s.saved)) {
          holdDraft({
            id: entry.id,
            type,
            userId: me.user.id,
            rev: s.rev,
            editSession: s.editSession,
            draft: read(),
            heldAt: Date.now(),
          });
        }
        if (s.heldUntouched) return;
        const save = s.running.then(async () => {
          if (s.done || s.locked) return;
          const sent = read();
          if (!s.unconfirmed && sameDraft(sent, s.saved)) return;
          s.seq += 1;
          const next = await saveRequest(entry.id, s.rev, sent, {
            editSession: s.editSession,
            editSeq: s.seq,
          });
          s.unconfirmed = false;
          s.saved = sent;
          s.rev = next.rev;
          s.entry = next;
          releaseDraft(entry.id, s.editSession);
        });
        trackSave(
          entry.id,
          save.then(() => queryClient.invalidateQueries({ queryKey: entriesKey(type) })),
        );
        save.then(
          () => {
            const {
              intl: words,
              canPublishRole: canPublish,
              offlineText: offline,
            } = leaving.current;
            // Not with a conflict still to be decided: publishing would only be refused.
            if (s.done || s.locked || !canPublish || !s.entry.url || !s.entry.dirty) return;
            // It says "Your changes", which has to be true. Someone else's are theirs to put
            // on the site, after they've looked them over, not one click away for whoever
            // happened to open the page.
            if (s.entry.updatedBy?.id !== me.user.id) return;
            // Signed out, or back in the editor already: either way, this isn't the moment.
            if (!queryClient.getQueryData(ME_KEY) || openEditors.has(entry.id)) return;
            const toast = showToast({
              message: words.formatMessage({ id: "editor.leftChanges" }),
              action: {
                label: words.formatMessage({ id: "editor.publishNow" }),
                run: () => {
                  s.seq += 1;
                  void api<EntryFull>(`/admin/entries/${entry.id}/publish`, {
                    method: "POST",
                    headers: { "If-Match": String(s.rev) },
                    body: { editSession: s.editSession, editSeq: s.seq },
                  })
                    .then(() => {
                      void queryClient.invalidateQueries({ queryKey: entriesKey(type) });
                      showToast({ message: words.formatMessage({ id: "editor.publishedNow" }) });
                    })
                    .catch((error) => {
                      showToast({ message: errorText(error, offline), sticky: true });
                    });
                },
              },
            });
            leavingToasts.set(entry.id, toast);
          },
          () => {},
        );
      });
    };
  }, [entry.id, type, queryClient, me.user.id]);

  // Pictures still on their way, or that didn't make it: the words can be saved without
  // them, so the status says so beside whatever it says about the words.
  useUploadsChanged();
  const pictures = placeholderUploads(session.current.pmDoc);
  const statusId = activity
    ? `editor.${activity}`
    : inTrash
      ? "editor.inTrash"
      : conflict
        ? "editor.conflictStatus"
        : trouble === "offline"
          ? onDevice
            ? "editor.offlineKept"
            : "editor.offlineTab"
          : trouble === "signedOut"
            ? onDevice
              ? "editor.signedOut"
              : "editor.signedOutTab"
            : trouble === "problem"
              ? "editor.notSaved"
              : restoredHeld && unsaved
                ? "editor.notSaved"
                : justUnpublished && !unsaved
                  ? "editor.takenOff"
                  : saving || unsaved
                    ? "editor.saving"
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
  // The same as the server's rule: the typed address, then the title, then something made up.
  const addressPreview =
    toAddress(fields.slug, type) ||
    toAddress(fields.title, type, "title") ||
    `${type}-${entry.id.slice(-8)}`;
  const canPublish = !busy && !locked && (!isLive || hasPendingChanges);
  const conflictIsMine = conflict?.updatedBy?.id === me.user.id;
  const conflictName = conflict?.updatedBy?.name ?? intl.formatMessage({ id: "editor.someone" });
  // The same as the server's rule: the start of the first paragraph.
  const reviewSummary = fields.summary.trim() || leadText(session.current.doc).slice(0, 160);
  const problemText = problem ? errorText(problem, offlineText) : null;

  return (
    <AdminLayout
      me={me}
      screen={type === "post" ? "editor.post" : "editor.page"}
      focusHeading={entry.title !== ""}
      currentEntryId={entry.id}
      writing
    >
      <div className="mt-2">
        <Link href={listPath} className={textLinkClass}>
          <FormattedMessage id={type === "post" ? "editor.backToPosts" : "editor.backToPages"} />
        </Link>
      </div>

      {/* Always mounted: screen readers can miss a live region added along with its text. */}
      <p role="status" className="sr-only">
        {announcement}
      </p>

      <div className="tend-sticky sticky top-0 z-10 -mx-4 mt-2 grid gap-1 border-b border-ink/10 bg-paper px-4 py-2 max-md:static">
        <p
          ref={statusRef}
          tabIndex={-1}
          data-testid="save-status"
          className="flex flex-wrap items-center gap-x-3 text-muted outline-none"
        >
          <span>
            <FormattedMessage id={statusId} />
          </span>
          {pictures.going > 0 && (
            <span>
              <FormattedMessage id="editor.uploadingPictures" values={{ count: pictures.going }} />
            </span>
          )}
          {pictures.failed > 0 && (
            <span className="font-medium text-danger">
              <FormattedMessage id="editor.picturesFailed" values={{ count: pictures.failed }} />
            </span>
          )}
          {isLive && !unsaved && !busy && current.url && (
            <a href={current.url} target="_blank" rel="noopener" className={textLinkClass}>
              <FormattedMessage id="editor.view" />
            </a>
          )}
          {trouble === "offline" && !busy && (
            <button
              type="button"
              className={textLinkClass}
              onClick={() => {
                session.current.retryDelay = RETRY_MIN_MS;
                session.current.announceNextSave = true;
                void autosave();
                // The button goes as soon as this works, and focus shouldn't go with it.
                statusRef.current?.focus();
              }}
            >
              <FormattedMessage id="common.tryAgain" />
            </button>
          )}
          {trouble === "signedOut" && (
            <Link href="/login" className={textLinkClass}>
              <FormattedMessage id="login.submit" />
            </Link>
          )}
        </p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {inTrash ? (
            <button
              type="button"
              disabled={busy}
              onClick={onRestore}
              className={primaryButtonClass}
            >
              <FormattedMessage id="list.restore" />
            </button>
          ) : (
            <>
              {canPublishRole && (
                <button
                  type="button"
                  // aria-disabled, so a button that's just been used keeps keyboard focus.
                  aria-disabled={!canPublish}
                  onClick={onPublish}
                  className={`${primaryButtonClass} aria-disabled:opacity-60`}
                >
                  <FormattedMessage id={publishId} />
                </button>
              )}
              {canPublishRole && hasPendingChanges && (
                <button
                  type="button"
                  aria-disabled={busy || locked}
                  onClick={() => {
                    if (!busy && !session.current.locked) onDiscard();
                  }}
                  className={actionButtonClass}
                >
                  <FormattedMessage id="editor.discard" />
                </button>
              )}
              <button
                type="button"
                // Not while a copy from this device is waiting to be decided about.
                aria-disabled={busy || locked || (restoredHeld && unsaved)}
                onClick={() => {
                  if (!busy && !session.current.locked) onPreview();
                }}
                className={actionButtonClass}
              >
                <FormattedMessage id="editor.preview" />
              </button>
              <button
                type="button"
                aria-disabled={locked}
                onClick={() => {
                  if (session.current.locked) return;
                  setProblem(null);
                  setHistoryOpen(true);
                }}
                className={actionButtonClass}
              >
                <FormattedMessage id="editor.history" />
              </button>
            </>
          )}
        </div>
      </div>

      {restoredHeld && unsaved && !inTrash && (
        <div className="mt-4 grid gap-3 rounded-lg border border-muted p-4">
          <p>
            <FormattedMessage id="editor.heldBack" />
          </p>
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => {
                saveNowByHand();
                statusRef.current?.focus();
              }}
              className={secondaryButtonClass}
            >
              <FormattedMessage id="editor.keepHeld" />
            </button>
            <button type="button" onClick={discardHeld} className={secondaryButtonClass}>
              <FormattedMessage id="editor.discardHeld" />
            </button>
          </div>
        </div>
      )}

      {/* Always mounted: screen readers can miss a live region added along with its text. */}
      <p role="alert" className="mt-2 font-medium text-danger empty:sr-only">
        {review || historyOpen ? null : problemText}
      </p>

      {conflict && (
        <div
          ref={conflictRef}
          tabIndex={-1}
          role="alert"
          className="mt-4 grid gap-3 rounded-lg border border-danger p-4 outline-none"
        >
          <p className="font-medium">
            {conflictIsMine ? (
              <FormattedMessage id="editor.conflictYou" />
            ) : (
              <FormattedMessage
                id="editor.conflictThem"
                values={{ name: conflictName, when: timeAgo(intl, conflict.updatedAt) }}
              />
            )}{" "}
            <FormattedMessage id="editor.conflictKept" />
          </p>
          <div className="rounded border border-muted/50 p-3 text-sm">
            <p className="font-medium">
              <FormattedMessage id="editor.conflictTheirs" />
            </p>
            <p className="mt-1 break-words">{conflict.title}</p>
            <p className="mt-1 line-clamp-4 break-words whitespace-pre-wrap text-muted">
              {docToText(cleanDoc(conflict.data.doc))}
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              disabled={busy}
              onClick={takeNewest}
              className={secondaryButtonClass}
            >
              {conflictIsMine ? (
                <FormattedMessage id="editor.useNewest" />
              ) : (
                <FormattedMessage id="editor.useTheirs" values={{ name: conflictName }} />
              )}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={keepMine}
              className={secondaryButtonClass}
            >
              <FormattedMessage id={conflictIsMine ? "editor.useThis" : "editor.keepMine"} />
            </button>
          </div>
        </div>
      )}

      <div className="mt-4 grid grid-cols-1 gap-6">
        <Field
          ref={titleRef}
          label={intl.formatMessage({ id: "editor.titleLabel" })}
          value={fields.title}
          onChange={(event) => changeField("title", event.target.value)}
          onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
            // Enter moves on to the writing, the same as a word processor's title.
            if (event.key === "Enter") {
              event.preventDefault();
              bodyRef.current?.focusStart();
            }
          }}
          error={fieldError?.field === "title" ? fieldError.message : undefined}
          maxLength={200}
          readOnly={readOnly}
          autoFocus={entry.title === ""}
        />

        <div className="grid min-w-0 grid-cols-1 gap-2">
          <span id={bodyLabelId} className="font-medium">
            <FormattedMessage id="editor.bodyLabel" />
          </span>
          <BodyEditor
            ref={bodyRef}
            initial={startingDraft.doc}
            type={type}
            editable={!readOnly}
            canEditBusiness={me.user.role === "admin"}
            labelledBy={bodyLabelId}
            onReady={(doc) => {
              session.current.pmDoc = doc;
              // What the editor made of this is the starting point. It isn't a change.
              session.current.doc = cleanDoc(doc.toJSON());
              session.current.readFrom = doc;
            }}
            onDocChange={(doc) => {
              session.current.pmDoc = doc;
              noteChange();
            }}
          />
        </div>

        <details
          open={settingsOpen}
          onToggle={(event) => setSettingsOpen(event.currentTarget.open)}
          className="rounded-lg border border-muted"
        >
          <summary className="flex min-h-11 cursor-pointer items-center px-3 font-medium focus-visible:outline-3 focus-visible:outline-brand">
            <FormattedMessage id="editor.settings" />
          </summary>
          <div className="grid gap-6 border-t border-muted p-3">
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
                value={fields.slug}
                onChange={(event) => changeField("slug", event.target.value)}
                error={
                  fieldError?.field === "slug"
                    ? fieldError.message
                    : current.address.problem
                      ? `${current.address.problem.message} ${current.address.problem.fix ?? ""}`.trim()
                      : undefined
                }
                placeholder={toAddress(fields.title, type, "title")}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                maxLength={200}
                readOnly={readOnly}
              />
            )}
            <Field
              label={intl.formatMessage({ id: "editor.summaryLabel" })}
              hint={intl.formatMessage({ id: "editor.summaryHint" })}
              value={fields.summary}
              onChange={(event) => changeField("summary", event.target.value)}
              maxLength={300}
              readOnly={readOnly}
            />
            <FeaturedImageField
              value={fields.featuredImageId}
              onChange={(id) => changeField("featuredImageId", id)}
              readOnly={readOnly}
            />
            {type === "post" && (
              <TagsField
                value={fields.tagIds}
                onChange={(ids) => changeField("tagIds", ids)}
                readOnly={readOnly}
              />
            )}
            <SearchFields
              title={fields.seoTitle}
              description={fields.seoDescription}
              noindex={fields.noindex}
              automaticTitle={fields.title}
              automaticDescription={reviewSummary}
              readOnly={readOnly}
              onChange={(change) => {
                if (change.seoTitle !== undefined) changeField("seoTitle", change.seoTitle);
                if (change.seoDescription !== undefined) {
                  changeField("seoDescription", change.seoDescription);
                }
                if (change.noindex !== undefined) changeField("noindex", change.noindex);
              }}
            />
            {!inTrash && (
              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  aria-disabled={busy || locked}
                  onClick={() => {
                    if (!busy && !session.current.locked) onDuplicate();
                  }}
                  className={actionButtonClass}
                >
                  <FormattedMessage id="editor.duplicate" />
                </button>
                {canPublishRole && isLive && !current.isHome && (
                  <button
                    type="button"
                    aria-disabled={busy || locked}
                    onClick={() => {
                      if (!busy && !session.current.locked) onUnpublish();
                    }}
                    className={actionButtonClass}
                  >
                    <FormattedMessage id="editor.unpublish" />
                  </button>
                )}
                {canPublishRole && !current.isHome && (
                  <button
                    type="button"
                    aria-disabled={busy || locked}
                    onClick={() => {
                      if (!busy && !session.current.locked) onTrash();
                    }}
                    className={actionButtonClass}
                  >
                    <FormattedMessage id="editor.trash" />
                  </button>
                )}
              </div>
            )}
          </div>
        </details>
      </div>

      {review && (
        <PublishDialog
          me={me}
          entry={session.current.entry}
          type={type}
          checks={review.checks}
          summary={fields.seoDescription.trim() || reviewSummary}
          shareTitle={fields.seoTitle.trim()}
          sharePicture={fields.featuredImageId ?? imageIds(session.current.saved.doc)[0] ?? null}
          done={review.done}
          busy={busy}
          problem={problemText}
          canEditMenu={me.user.role === "admin" || me.user.role === "editor"}
          onPublish={onConfirmPublish}
          onFix={(field) => {
            setReview(null);
            goToField(field);
          }}
          onGoTo={goToCheck}
          onClose={() => setReview(null)}
          onWriteAnother={onWriteAnother}
        />
      )}
      {previewHtml !== null && (
        <PreviewDialog html={previewHtml} onClose={() => setPreviewHtml(null)} />
      )}
      {historyOpen && (
        <HistoryDialog
          entryId={entry.id}
          busy={busy}
          problem={problemText}
          onRestore={(revisionId) =>
            bringBack(revisionId, (version) =>
              !version.url
                ? "editor.versionRestoredDraft"
                : version.dirty
                  ? "editor.versionRestored"
                  : "editor.versionRestoredLive",
            )
          }
          onClose={() => setHistoryOpen(false)}
        />
      )}
    </AdminLayout>
  );
}

/** No answer came back, so whatever was asked for may have happened, or may not. */
function mayHaveArrived(error: unknown): boolean {
  // Tend's own errors undo whatever was underway. A proxy giving up on Tend is another
  // matter: Tend may have finished the job after it stopped waiting.
  return (
    error instanceof ApiError &&
    (error.code === OFFLINE || error.status === 502 || error.status === 504)
  );
}

/** Thrown once a conflict's on screen, so whatever was waiting on the save doesn't go ahead. */
class StoppedForConflict extends Error {}

/**
 * Words kept on this device for something that's since been deleted. There's nowhere for them
 * to be saved, so without this they could only sit there. They can be read and kept, or let go.
 */
function DeletedEntryRecovery({ me, held }: { me: Me; held: HeldDraft }) {
  const intl = useIntl();
  const [, navigate] = useLocation();
  const [problem, setProblem] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const words = docToText(cleanDoc(held.draft.doc));
  const listPath = held.type === "post" ? "/posts" : "/pages";
  return (
    <AdminLayout
      me={me}
      screen={held.type === "post" ? "editor.post" : "editor.page"}
      currentEntryId={held.id}
    >
      <p className="mt-6 text-lg">
        <FormattedMessage id="editor.deletedHeld" />
      </p>
      <div className="mt-4 rounded-lg border border-muted p-4">
        <p className="font-medium [overflow-wrap:anywhere]">
          {held.draft.title || intl.formatMessage({ id: "list.untitled" })}
        </p>
        <p className="mt-2 whitespace-pre-wrap [overflow-wrap:anywhere]">{words}</p>
      </div>
      <p role="alert" className="mt-4 font-medium text-danger empty:sr-only">
        {problem ? <Problem error={problem} /> : null}
      </p>
      <div className="mt-4 flex flex-wrap gap-3">
        <button
          type="button"
          disabled={busy}
          className={primaryButtonClass}
          onClick={() => {
            setBusy(true);
            setProblem(null);
            void (async () => {
              const created = await api<EntryFull>("/admin/entries", {
                method: "POST",
                body: { type: held.type },
              });
              await saveRequest(
                created.id,
                created.rev,
                { ...held.draft, slug: "" },
                { editSession: newEditSession(), editSeq: 1 },
              );
              releaseHeld(held.key);
              navigate(`${listPath}/${created.id}`);
            })().catch((error) => {
              setProblem(error);
              setBusy(false);
            });
          }}
        >
          <FormattedMessage id="editor.deletedKeep" />
        </button>
        <button
          type="button"
          disabled={busy}
          className={secondaryButtonClass}
          onClick={() => {
            releaseHeld(held.key);
            navigate(listPath);
            showToast({
              message: intl.formatMessage({ id: "editor.heldDiscarded" }),
              action: {
                label: intl.formatMessage({ id: "list.undo" }),
                run: () => holdDraft(held),
              },
            });
          }}
        >
          <FormattedMessage id="editor.deletedDiscard" />
        </button>
      </div>
    </AdminLayout>
  );
}

function LoadedEditor({ me, id, type }: { me: Me; id: string; type: EntryType }) {
  const entry = useQuery({
    queryKey: entryKey(id),
    queryFn: async () => {
      // A save from leaving this entry a moment ago might still be on its way, and this
      // mustn't overtake it and show the old text. What's kept on this device has to be
      // read first too, or it wouldn't be offered back.
      await waitForSave(id);
      await draftsLoaded();
      return api<EntryFull>(`/admin/entries/${id}`);
    },
    // The editor keeps its own copy once open, so nothing here may disturb it, and every
    // opening starts from what's really on the server.
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  // Re-renders this if a copy is dealt with, so the next one left behind can be offered.
  useHeldDrafts(me.user.id);

  if (entry.isPending) return <Loading />;
  if (entry.isLoadingError) {
    const gone = entry.error instanceof ApiError && entry.error.status === 404;
    const left = gone ? getHeldDrafts(id, me.user.id)[0] : undefined;
    if (left) return <DeletedEntryRecovery key={left.key} me={me} held={left} />;
    return (
      <AdminLayout me={me} screen={type === "post" ? "editor.post" : "editor.page"}>
        <p role="alert" className="mt-6 text-lg text-muted">
          {<Problem error={entry.error} />}
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
  // A page has things a post can't, so editing one at the wrong address would lose them.
  if (entry.data.type !== type) {
    return <Redirect to={`/${entry.data.type === "post" ? "posts" : "pages"}/${id}`} replace />;
  }

  return <OpenedEditor key={entry.data.id} me={me} entry={entry.data} type={type} />;
}

/** Decides once, on opening, whether there's something kept on this device to offer back. */
function OpenedEditor({ me, entry, type }: { me: Me; entry: EntryFull; type: EntryType }) {
  const [held] = useState(() => {
    const server = draftFrom(entry);
    // The save got there and only the answer was lost, so these have nothing to offer.
    const differing = getHeldDrafts(entry.id, me.user.id).filter((kept) => {
      if (!sameOnceTidied(kept.draft, server, type)) return true;
      releaseHeld(kept.key);
      return false;
    });
    return differing[0];
  });
  return <EditorScreen me={me} entry={entry} type={type} held={held} />;
}

export function PostEditor({ params }: { params: { id: string } }) {
  return <SignedIn>{(me) => <LoadedEditor me={me} id={params.id} type="post" />}</SignedIn>;
}

export function PageEditor({ params }: { params: { id: string } }) {
  return <SignedIn>{(me) => <LoadedEditor me={me} id={params.id} type="page" />}</SignedIn>;
}
