import { useMutation, useQuery } from "@tanstack/react-query";
import { type ReactNode, useId, useRef, useState } from "react";
import { FormattedDate, FormattedMessage, useIntl } from "react-intl";
import { Link, useLocation } from "wouter";
import { useConfirmAddress } from "../components/AddressChoice.tsx";
import { AdminLayout, SignedIn } from "../components/AdminLayout.tsx";
import {
  primaryButtonClass,
  secondaryButtonClass,
  textLinkClass,
} from "../components/AuthLayout.tsx";
import { Icon } from "../components/icons.tsx";
import { OutLink } from "../components/OutLink.tsx";
import { PicturesNotice } from "../components/PicturesNotice.tsx";
import { Problem } from "../components/Problem.tsx";
import { Waiting } from "../components/Waiting.tsx";
import { api } from "../lib/api.ts";
import { bytesText } from "../lib/bytes.ts";
import { onThisComputer } from "../lib/hosts.ts";
import type { EntrySummary, Me } from "../lib/queries.ts";
import { BACKUPS_KEY, type BackupsInfo } from "../lib/site.ts";

type StepId = "home" | "business" | "post" | "logo" | "photo" | "kit" | "online" | "domain";

interface Activity {
  id: string;
  kind: "published" | "changed" | "added" | "setting" | "joined";
  at: number;
  by: string | null;
  entry?: { id: string; type: "post" | "page"; title: string };
  count?: number;
  setting?: string;
}

interface Part {
  entries: EntrySummary[];
  count: number;
}

interface OverviewInfo {
  homeId: string | null;
  /** On the site, with newer edits that aren't. */
  changes: Part;
  drafts: Part;
  steps: { id: StepId; done: boolean }[];
  activity: Activity[];
  disk: { total: number; free: number; low: boolean } | null;
  lastCopyAt: number | null;
}

const OVERVIEW_KEY = ["overview"];

/** How often the Owner is reminded to download a backup (PLAN.md §13): once a month. */
const BACKUP_REMINDER_MS = 30 * 24 * 60 * 60 * 1000;

const STEPS_KEY = "tend-steps";

function entryHref(entry: { id: string; type: "post" | "page" }): string {
  return `/${entry.type === "post" ? "posts" : "pages"}/${entry.id}`;
}

function Section({
  heading,
  children,
  className = "",
}: {
  heading: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={`mt-10 ${className}`}>
      <h2 id={id} className="text-xl font-semibold">
        {heading}
      </h2>
      {children}
    </section>
  );
}

/**
 * A reminder to download a backup, for the Owner, who alone can: a month after the last
 * one, or a month after setup if there hasn't been one.
 */
function BackupReminder() {
  const backups = useQuery({
    queryKey: BACKUPS_KEY,
    queryFn: () => api<BackupsInfo>("/admin/backups"),
  });
  const info = backups.data;
  const since = info?.lastDownloadAt ?? info?.setUpAt;
  if (!info || since == null || Date.now() - since < BACKUP_REMINDER_MS) return null;
  return (
    <section aria-labelledby="overview-backup" className="mt-8 rounded-lg border border-muted p-4">
      <h2 id="overview-backup" className="text-lg font-semibold">
        <FormattedMessage id="overview.backup.heading" />
      </h2>
      <p className="mt-1">
        {info.lastDownloadAt === null ? (
          <FormattedMessage id="overview.backup.never" />
        ) : (
          <FormattedMessage
            id="overview.backup.since"
            values={{ date: <FormattedDate value={info.lastDownloadAt} dateStyle="long" /> }}
          />
        )}
      </p>
      <Link href="/settings/backups" className={textLinkClass}>
        <FormattedMessage id="overview.backup.link" />
      </Link>
    </section>
  );
}

/**
 * Asks whether the address the admin is open at is the site's (PLAN.md J10). Until someone
 * says yes, links follow the address each page is asked for, so an old address, or
 * localhost, never reaches a moved site's links, sitemap or social previews.
 */
function AddressCheck() {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const address = window.location.origin;
  // The button goes, so the keyboard needs somewhere to be.
  const confirm = useConfirmAddress(() => headingRef.current?.focus());
  return (
    <section aria-labelledby="overview-address" className="mt-8 rounded-lg border border-brand p-4">
      <h2
        ref={headingRef}
        id="overview-address"
        tabIndex={-1}
        className="text-lg font-semibold outline-none"
      >
        <FormattedMessage id="overview.address.heading" />
      </h2>
      {!confirm.isSuccess && (
        <>
          <p className="mt-1">
            <FormattedMessage
              id="overview.address.body"
              values={{ address: <strong className="break-all">{address}</strong> }}
            />
          </p>
          <p className="mt-1 text-sm text-muted">
            <FormattedMessage id="overview.address.hint" />
          </p>
          <div className="mt-3">
            <button
              type="button"
              disabled={confirm.isPending}
              onClick={() => confirm.mutate()}
              className={primaryButtonClass}
            >
              <FormattedMessage id="overview.address.confirm" />
            </button>
          </div>
        </>
      )}
      {/* Always mounted: screen readers can miss a live region added along with its text. */}
      <p role="status" className="mt-1 empty:sr-only">
        {confirm.isSuccess && (
          <FormattedMessage id="overview.address.done" values={{ address: confirm.data.address }} />
        )}
      </p>
      <p role="alert" className="mt-2 font-medium text-danger empty:sr-only">
        {confirm.isError && <Problem error={confirm.error} />}
      </p>
    </section>
  );
}

/**
 * Whether to ask about the address the admin is open at: when the site has none of its own,
 * or has only the one its host gave it and this is another, as once a domain is connected.
 */
function shouldAskAddress(me: Me): boolean {
  if (me.user.role !== "admin" || onThisComputer()) return false;
  const { address, addressFrom } = me.site;
  if (address === null) return true;
  return addressFrom === "platform" && address !== window.location.origin;
}

/** Says only what's true about who can see the site (PLAN.md P15). */
function SiteStatus({ me }: { me: Me }) {
  const { address, addressIsPublic, visibility } = me.site;
  const link = address && (
    <a
      href={address}
      target="_blank"
      rel="noopener"
      className="inline-flex min-h-11 items-center font-medium break-all text-brand underline underline-offset-4 focus-visible:outline-3 focus-visible:outline-brand"
    >
      {address}
    </a>
  );
  if (onThisComputer()) return <FormattedMessage id="overview.local" />;
  if (!address) return <FormattedMessage id="overview.noAddress" />;
  const values = { address: link };
  if (visibility !== "public") {
    return (
      <>
        <FormattedMessage id={`overview.${visibility}`} values={values} />{" "}
        {me.user.role === "admin" && (
          <Link
            href="/settings/general"
            className="inline-flex min-h-11 items-center text-brand underline underline-offset-4 focus-visible:outline-3 focus-visible:outline-brand"
          >
            <FormattedMessage id="overview.whoSees" />
          </Link>
        )}
      </>
    );
  }
  return (
    <FormattedMessage id={addressIsPublic ? "overview.live" : "overview.network"} values={values} />
  );
}

function EntryLinks({ part, more }: { part: Part; more?: ReactNode }) {
  return (
    <>
      <ul className="mt-2 divide-y divide-ink/10 border-y border-ink/10">
        {part.entries.map((entry) => (
          <li key={entry.id} className="flex flex-wrap items-center justify-between gap-x-4 py-1">
            <Link
              href={entryHref(entry)}
              className="inline-flex min-h-11 min-w-0 items-center font-medium [overflow-wrap:anywhere] underline-offset-4 hover:underline focus-visible:outline-3 focus-visible:outline-brand"
            >
              {entry.title || <FormattedMessage id="list.untitled" />}
            </Link>
            <span className="text-sm text-muted">
              <FormattedMessage id={`overview.kind.${entry.type}`} />
              {" · "}
              <FormattedDate value={entry.updatedAt} dateStyle="medium" />
            </span>
          </li>
        ))}
      </ul>
      {more}
    </>
  );
}

function keptOpen(): boolean {
  try {
    return localStorage.getItem(STEPS_KEY) !== "closed";
  } catch {
    return true;
  }
}

/** The first steps. Each ticks itself off, and the list goes once they're all done. */
function Steps({
  steps,
  homeId,
  onWritePost,
  invited,
}: {
  steps: OverviewInfo["steps"];
  homeId: string | null;
  onWritePost: () => void;
  /** For someone who joined a site that was there already. */
  invited: boolean;
}) {
  const [open] = useState(keptOpen);
  const done = steps.filter((step) => step.done).length;
  if (done === steps.length) return null;

  const hrefs: Record<StepId, string | null> = {
    home: homeId === null ? "/pages" : `/pages/${homeId}`,
    business: "/settings/business",
    post: null,
    logo: "/design",
    photo: "/media",
    kit: "/account",
    online: "/online",
    domain: "/domain",
  };
  const stepClass =
    "min-h-11 rounded text-left text-brand underline-offset-4 hover:underline focus-visible:outline-3 focus-visible:outline-brand";

  return (
    <details open={open} className="group mt-10 rounded-lg border border-muted">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a summary is a button already */}
      <summary
        onClick={(event) => {
          // It's about to become the other way, which its toggle event says only later.
          const opening = !(event.currentTarget.parentElement as HTMLDetailsElement).open;
          try {
            if (opening) localStorage.removeItem(STEPS_KEY);
            else localStorage.setItem(STEPS_KEY, "closed");
          } catch {
            // It's open again next time.
          }
        }}
        className="flex min-h-11 cursor-pointer flex-wrap items-center gap-x-3 px-4 py-2 focus-visible:outline-3 focus-visible:outline-brand"
      >
        <h2 className="text-xl font-semibold">
          <FormattedMessage id={invited ? "steps.headingInvited" : "steps.heading"} />
        </h2>
        <span className="text-muted">
          <FormattedMessage id="steps.count" values={{ done, total: steps.length }} />
        </span>
        <Icon name="down" className="ml-auto size-5 group-open:rotate-180" />
      </summary>
      <ul className="grid gap-1 border-t border-muted px-4 py-2">
        {steps.map((step) => {
          const name = <FormattedMessage id={`steps.${step.id}`} />;
          const href = hrefs[step.id];
          return (
            <li key={step.id} className="flex items-center gap-3">
              <span
                className={`flex size-6 shrink-0 items-center justify-center rounded-full border ${
                  step.done ? "border-brand bg-brand text-paper" : "border-muted"
                }`}
              >
                {step.done && <Icon name="done" className="size-4" />}
              </span>
              {step.done ? (
                <span className="flex min-h-11 items-center text-muted">
                  <span className="sr-only">
                    <FormattedMessage id="steps.done" />{" "}
                  </span>
                  <span>{name}</span>
                </span>
              ) : href === null ? (
                <button type="button" onClick={onWritePost} className={stepClass}>
                  {name}
                </button>
              ) : (
                <Link href={href} className={`${stepClass} inline-flex items-center`}>
                  {name}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </details>
  );
}

function ActivityText({ activity }: { activity: Activity }) {
  const intl = useIntl();
  const by = activity.by ?? intl.formatMessage({ id: "editor.someone" });
  if (activity.entry) {
    return (
      <FormattedMessage
        id={`activity.${activity.kind}`}
        values={{
          by,
          title: (
            <Link
              href={entryHref(activity.entry)}
              className="inline-flex min-h-11 min-w-11 items-center font-medium text-brand underline underline-offset-4 focus-visible:outline-3 focus-visible:outline-brand"
            >
              {activity.entry.title}
            </Link>
          ),
        }}
      />
    );
  }
  if (activity.kind === "setting") {
    return <FormattedMessage id={`activity.setting.${activity.setting}`} values={{ by }} />;
  }
  return (
    <FormattedMessage id={`activity.${activity.kind}`} values={{ by, count: activity.count }} />
  );
}

function ThisServer({ info }: { info: OverviewInfo }) {
  const intl = useIntl();
  const { disk, lastCopyAt } = info;
  if (!disk) return null;
  return (
    <Section heading={<FormattedMessage id="overview.server" />}>
      <p className={`mt-2 ${disk.low ? "font-medium text-danger" : ""}`}>
        <FormattedMessage
          id={disk.low ? "overview.diskLow" : "overview.disk"}
          values={{
            used: bytesText(intl, Math.max(0, disk.total - disk.free)),
            total: bytesText(intl, disk.total),
          }}
        />
      </p>
      <p className="mt-1">
        {lastCopyAt === null ? (
          <FormattedMessage id="overview.noCopy" />
        ) : (
          <FormattedMessage
            id="overview.lastCopy"
            values={{
              date: <FormattedDate value={lastCopyAt} dateStyle="medium" timeStyle="short" />,
            }}
          />
        )}
      </p>
      <Link href="/settings/backups" className={textLinkClass}>
        <FormattedMessage id="overview.backup.link" />
      </Link>
    </Section>
  );
}

function OverviewScreen({ me }: { me: Me }) {
  const [, navigate] = useLocation();
  // Asked once per visit, so the answer stays on screen after the address becomes known.
  const [askAddress] = useState(() => shouldAskAddress(me));

  const overview = useQuery({
    queryKey: OVERVIEW_KEY,
    queryFn: () => api<OverviewInfo>("/admin/overview"),
  });
  const info = overview.data;
  const canEditPages = me.user.role === "admin" || me.user.role === "editor";
  const homeId = canEditPages ? (info?.homeId ?? null) : null;

  const newPost = useMutation({
    mutationFn: () =>
      api<EntrySummary>("/admin/entries", { method: "POST", body: { type: "post" } }),
  });

  function writePost() {
    if (newPost.isPending) return;
    // Passed here, not to useMutation, so it only runs if this screen is still open.
    newPost.mutate(undefined, {
      onSuccess: (entry) => navigate(`/posts/${entry.id}`),
    });
  }

  return (
    <AdminLayout me={me} screen="overview" title={me.site.name}>
      {me.site.tagline && <p className="mt-2 text-lg break-words text-muted">{me.site.tagline}</p>}
      <p className="mt-6 text-lg">
        <SiteStatus me={me} />
      </p>
      {me.user.role === "admin" && <PicturesNotice me={me} />}
      {askAddress && <AddressCheck />}
      {info && info.changes.count > 0 && (
        <Section
          heading={
            <FormattedMessage id="overview.changes" values={{ count: info.changes.count }} />
          }
          className="rounded-lg border border-brand p-4"
        >
          <p className="mt-1 text-muted">
            <FormattedMessage id="overview.changesHint" values={{ count: info.changes.count }} />
          </p>
          <EntryLinks
            part={info.changes}
            more={
              info.changes.count > info.changes.entries.length && (
                <p className="mt-2 text-muted">
                  <FormattedMessage
                    id="overview.more"
                    values={{ count: info.changes.count - info.changes.entries.length }}
                  />
                </p>
              )
            }
          />
        </Section>
      )}
      <div className="mt-6 flex flex-wrap gap-3">
        {homeId && (
          <Link
            href={`/pages/${homeId}`}
            className={`${primaryButtonClass} inline-flex items-center`}
          >
            <FormattedMessage id="overview.editHome" />
          </Link>
        )}
        <button
          type="button"
          disabled={newPost.isPending}
          onClick={writePost}
          className={homeId ? secondaryButtonClass : primaryButtonClass}
        >
          <FormattedMessage id="overview.writePost" />
        </button>
        <OutLink href="/" className={`${textLinkClass} ml-2`}>
          <FormattedMessage id="nav.viewSite" />
        </OutLink>
      </div>
      {/* Always mounted: screen readers can miss a live region added along with its text. */}
      <p role="alert" className="mt-4 font-medium text-danger empty:sr-only">
        {newPost.error && <Problem error={newPost.error} />}
      </p>
      {info ? (
        <>
          <Steps
            steps={info.steps}
            homeId={homeId}
            onWritePost={writePost}
            invited={!me.user.isOwner}
          />
          {me.user.isOwner && <BackupReminder />}
          {info.drafts.count > 0 && (
            <Section heading={<FormattedMessage id="overview.drafts" />}>
              <EntryLinks
                part={info.drafts}
                more={
                  info.drafts.count > info.drafts.entries.length && (
                    <p className="mt-2 flex flex-wrap items-center gap-x-4 text-muted">
                      <FormattedMessage
                        id="overview.more"
                        values={{ count: info.drafts.count - info.drafts.entries.length }}
                      />
                      <Link href="/posts?show=drafts" className={textLinkClass}>
                        <FormattedMessage id="overview.draftPosts" />
                      </Link>
                      {canEditPages && (
                        <Link href="/pages?show=drafts" className={textLinkClass}>
                          <FormattedMessage id="overview.draftPages" />
                        </Link>
                      )}
                    </p>
                  )
                }
              />
            </Section>
          )}
          {info.activity.length > 0 && (
            <Section heading={<FormattedMessage id="overview.activity" />}>
              <ul className="mt-2 grid gap-2">
                {info.activity.map((activity) => (
                  <li
                    key={`${activity.kind}-${activity.id}`}
                    className="flex flex-wrap items-baseline justify-between gap-x-4 [overflow-wrap:anywhere]"
                  >
                    <span className="min-w-0">
                      <ActivityText activity={activity} />
                    </span>
                    <span className="text-sm text-muted">
                      <FormattedDate value={activity.at} dateStyle="medium" timeStyle="short" />
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          )}
          <ThisServer info={info} />
        </>
      ) : (
        <Waiting query={overview} />
      )}
    </AdminLayout>
  );
}

/** Where people land after setup and sign-in: what's waiting, and what to do next. */
export function Overview() {
  return <SignedIn>{(me) => <OverviewScreen me={me} />}</SignedIn>;
}
