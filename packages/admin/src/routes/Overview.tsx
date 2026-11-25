import { useMutation, useQuery } from "@tanstack/react-query";
import { type ReactNode, useId, useRef, useState } from "react";
import { FormattedDate, FormattedMessage, useIntl } from "react-intl";
import { Link, useLocation } from "wouter";
import { useConfirmAddress } from "../components/AddressChoice.tsx";
import { AdminLayout, initials, SignedIn } from "../components/AdminLayout.tsx";
import {
  primaryButtonClass,
  secondaryButtonClass,
  textLinkClass,
} from "../components/AuthLayout.tsx";
import { BrowserFrame } from "../components/BrowserFrame.tsx";
import { EntryPicture } from "../components/EntryRow.tsx";
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

function Card({
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
    <section aria-labelledby={id} className={`card min-w-0 p-5 sm:px-6 ${className}`}>
      <h2 id={id} className="text-lg font-bold">
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
    <section aria-labelledby="overview-backup" className="card min-w-0 p-5 sm:px-6">
      <h2 id="overview-backup" className="text-lg font-bold">
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
    <section
      aria-labelledby="overview-address"
      className="card mt-6 border-brand bg-mint p-5 sm:px-6"
    >
      <h2
        ref={headingRef}
        id="overview-address"
        tabIndex={-1}
        className="text-lg font-bold outline-none"
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

/**
 * The homepage as it is now, small: a picture of the site, not a way around it. It's the page
 * itself in a frame with nothing allowed in it, twice as wide as its place and half the size.
 */
function SitePicture({ name }: { name: string }) {
  const intl = useIntl();
  return (
    <div aria-hidden="true" className="hidden sm:block">
      <BrowserFrame name={name}>
        <div className="relative h-80 overflow-hidden">
          <iframe
            title={intl.formatMessage({ id: "overview.picture" })}
            src="/"
            sandbox=""
            loading="lazy"
            tabIndex={-1}
            inert
            className="pointer-events-none h-[200%] w-[200%] origin-top-left scale-50"
          />
        </div>
      </BrowserFrame>
    </div>
  );
}

function EntryLinks({ part, more }: { part: Part; more?: ReactNode }) {
  return (
    <>
      <ul className="mt-2 divide-y divide-line">
        {part.entries.map((entry) => (
          <li key={entry.id} className="relative flex items-center gap-3.5 py-2.5">
            <EntryPicture entry={entry} />
            <div className="min-w-0 flex-1">
              <Link
                href={entryHref(entry)}
                className="font-semibold [overflow-wrap:anywhere] underline-offset-4 after:absolute after:inset-0 after:rounded-lg hover:underline focus-visible:outline-none focus-visible:after:outline-3 focus-visible:after:outline-brand"
              >
                {entry.title || <FormattedMessage id="list.untitled" />}
              </Link>
              <p className="text-sm text-muted">
                <FormattedMessage id={`overview.kind.${entry.type}`} />
                {" · "}
                <FormattedDate value={entry.updatedAt} dateStyle="medium" />
              </p>
            </div>
            <Icon name="right" className="size-4 text-muted" />
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

/** How far along the first steps are, as a ring. The words beside it say the same. */
function StepsRing({ done, total }: { done: number; total: number }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 52 52" className="size-13 shrink-0">
      <circle cx="26" cy="26" r="21" className="fill-none stroke-mint" strokeWidth="7" />
      <circle
        cx="26"
        cy="26"
        r="21"
        pathLength={total}
        strokeDasharray={`${done} ${total}`}
        strokeLinecap="round"
        strokeWidth="7"
        transform="rotate(-90 26 26)"
        className={done === 0 ? "hidden" : "fill-none stroke-brand"}
      />
      <text x="26" y="31" textAnchor="middle" className="fill-ink text-sm font-bold">
        {done}/{total}
      </text>
    </svg>
  );
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
  // The whole row can be pressed.
  const stepClass =
    "min-h-11 py-2 text-left font-medium underline-offset-4 after:absolute after:inset-0 after:rounded-lg hover:underline focus-visible:outline-none focus-visible:after:outline-3 focus-visible:after:outline-brand";

  return (
    <details open={open} className="card group min-w-0 self-start">
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
        className="flex min-h-11 cursor-pointer list-none items-center gap-4 rounded-2xl px-5 py-4 focus-visible:outline-3 focus-visible:outline-brand sm:px-6 [&::-webkit-details-marker]:hidden"
      >
        <StepsRing done={done} total={steps.length} />
        <span className="min-w-0">
          <h2 className="text-lg font-bold">
            <FormattedMessage id={invited ? "steps.headingInvited" : "steps.heading"} />
          </h2>
          <span className="text-sm text-muted">
            <FormattedMessage id="steps.count" values={{ done, total: steps.length }} />
          </span>
        </span>
        <Icon name="down" className="ml-auto size-5 text-muted group-open:rotate-180" />
      </summary>
      <ul className="grid divide-y divide-line px-5 pb-3 sm:px-6">
        {steps.map((step) => {
          const name = <FormattedMessage id={`steps.${step.id}`} />;
          const href = hrefs[step.id];
          return (
            <li key={step.id} className="relative flex min-h-13 items-center gap-3.5">
              <span
                className={`grid size-6 shrink-0 place-items-center rounded-full border-2 ${
                  step.done ? "border-brand bg-brand text-on-brand" : "border-edge"
                }`}
              >
                {step.done && <Icon name="done" className="size-4" />}
              </span>
              {step.done ? (
                <span className="text-muted">
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
                <Link href={href} className={stepClass}>
                  {name}
                </Link>
              )}
              {!step.done && <Icon name="right" className="ml-auto size-4 text-muted" />}
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
    <Card heading={<FormattedMessage id="overview.server" />}>
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
    </Card>
  );
}

/** "Good morning, Sam", by this computer's clock. */
function useHello(name: string): string {
  const intl = useIntl();
  const hour = new Date().getHours();
  const time = hour < 5 || hour >= 18 ? "evening" : hour < 12 ? "morning" : "afternoon";
  return intl.formatMessage(
    { id: `overview.hello.${time}` },
    { name: name.split(/\s+/)[0] ?? name },
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
  const hello = useHello(me.user.name);
  const hasSteps = info?.steps.some((step) => !step.done) ?? false;

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

  const waiting = info && info.changes.count > 0 && (
    <Card
      heading={<FormattedMessage id="overview.changes" values={{ count: info.changes.count }} />}
      className="mt-7 border-wait-line bg-linear-to-b from-wait-soft to-surface to-60%"
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
    </Card>
  );

  return (
    <AdminLayout
      me={me}
      screen="overview"
      title={hello}
      intro={me.site.tagline && <p className="text-lg break-words">{me.site.tagline}</p>}
      width="wide"
      actions={
        <>
          <button
            type="button"
            disabled={newPost.isPending}
            onClick={writePost}
            className={homeId ? secondaryButtonClass : primaryButtonClass}
          >
            <Icon name="add" className="size-4.5" />
            <FormattedMessage id="overview.writePost" />
          </button>
          {homeId && (
            <Link href={`/pages/${homeId}`} className={primaryButtonClass}>
              <FormattedMessage id="overview.editHome" />
            </Link>
          )}
        </>
      }
    >
      {/* Always mounted: screen readers can miss a live region added along with its text. */}
      <p role="alert" className="mt-4 font-medium text-danger empty:sr-only">
        {newPost.error && <Problem error={newPost.error} />}
      </p>
      {me.user.role === "admin" && <PicturesNotice me={me} />}
      {askAddress && <AddressCheck />}
      {waiting}
      <div className={`mt-6 grid gap-5 ${hasSteps ? "xl:grid-cols-[1.6fr_1fr]" : ""}`}>
        <section aria-labelledby="overview-site" className="card min-w-0 p-4">
          <h2 id="overview-site" className="sr-only">
            <FormattedMessage id="overview.site" />
          </h2>
          <SitePicture name={me.site.name} />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-1.5 pt-3.5">
            <p className="min-w-0 flex-1 basis-64">
              <SiteStatus me={me} />
            </p>
            <OutLink href="/" className={secondaryButtonClass}>
              <FormattedMessage id="nav.viewSite" />
            </OutLink>
          </div>
        </section>
        {info && hasSteps && (
          <Steps
            steps={info.steps}
            homeId={homeId}
            onWritePost={writePost}
            invited={!me.user.isOwner}
          />
        )}
      </div>
      {info ? (
        <div className="mt-5 grid items-start gap-5 md:grid-cols-2">
          {me.user.isOwner && <BackupReminder />}
          {info.drafts.count > 0 && (
            <Card heading={<FormattedMessage id="overview.drafts" />}>
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
            </Card>
          )}
          {info.activity.length > 0 && (
            <Card heading={<FormattedMessage id="overview.activity" />}>
              <ul className="mt-2 divide-y divide-line">
                {info.activity.map((activity) => (
                  <li
                    key={`${activity.kind}-${activity.id}`}
                    className="flex items-start gap-3.5 py-2.5 [overflow-wrap:anywhere]"
                  >
                    <span
                      aria-hidden="true"
                      className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-full bg-mint text-xs font-bold text-brand-strong"
                    >
                      {activity.by ? initials(activity.by) : "?"}
                    </span>
                    <span className="min-w-0">
                      <span className="block">
                        <ActivityText activity={activity} />
                      </span>
                      <span className="block text-sm text-muted">
                        <FormattedDate value={activity.at} dateStyle="medium" timeStyle="short" />
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <ThisServer info={info} />
        </div>
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
