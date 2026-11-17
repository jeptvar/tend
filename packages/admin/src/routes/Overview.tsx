import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { FormattedDate, FormattedMessage, useIntl } from "react-intl";
import { Link, useLocation } from "wouter";
import { AdminLayout, SignedIn } from "../components/AdminLayout.tsx";
import {
  primaryButtonClass,
  secondaryButtonClass,
  textLinkClass,
} from "../components/AuthLayout.tsx";
import { api, errorText } from "../lib/api.ts";
import { type EntrySummary, entriesKey, ME_KEY, type Me } from "../lib/queries.ts";
import { BACKUPS_KEY, type BackupsInfo } from "../lib/site.ts";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** How often the Owner is reminded to download a backup (PLAN.md §13): once a month. */
const BACKUP_REMINDER_MS = 30 * 24 * 60 * 60 * 1000;

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
  const intl = useIntl();
  const queryClient = useQueryClient();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const address = window.location.origin;
  const confirm = useMutation({
    mutationFn: () =>
      api<{ address: string }>("/admin/address", { method: "POST", body: { address } }),
    onSuccess: () => {
      // The button goes, so the keyboard needs somewhere to be.
      headingRef.current?.focus();
      void queryClient.invalidateQueries({ queryKey: ME_KEY });
    },
  });
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
        {confirm.isError && errorText(confirm.error, intl.formatMessage({ id: "offline.body" }))}
      </p>
    </section>
  );
}

/** Says only what's true about who can see the site (PLAN.md P15). */
function siteStatusId(me: Me): string {
  if (LOCAL_HOSTS.has(window.location.hostname)) return "overview.local";
  return me.siteIsPublic ? "overview.online" : "overview.noAddress";
}

function OverviewScreen({ me }: { me: Me }) {
  const intl = useIntl();
  const [, navigate] = useLocation();
  // Asked once per visit, so the answer stays on screen after the address becomes known.
  const [askAddress] = useState(
    () =>
      !me.addressKnown && me.user.role === "admin" && !LOCAL_HOSTS.has(window.location.hostname),
  );

  const pages = useQuery({
    queryKey: entriesKey("page", false),
    queryFn: () => api<{ entries: EntrySummary[] }>("/admin/entries?type=page"),
  });
  const home = pages.data?.entries.find((entry) => entry.isHome);

  const newPost = useMutation({
    mutationFn: () =>
      api<EntrySummary>("/admin/entries", { method: "POST", body: { type: "post" } }),
  });

  function writePost() {
    // Passed here, not to useMutation, so it only runs if this screen is still open.
    newPost.mutate(undefined, {
      onSuccess: (entry) => navigate(`/posts/${entry.id}`),
    });
  }

  const error = newPost.error ?? pages.error;

  return (
    <AdminLayout me={me} screen="overview" title={me.site.name}>
      {me.site.tagline && <p className="mt-2 text-lg break-words text-muted">{me.site.tagline}</p>}
      <p className="mt-6 text-lg">
        <FormattedMessage id={siteStatusId(me)} />
      </p>
      {askAddress && <AddressCheck />}
      <div className="mt-6 flex flex-wrap gap-3">
        {home && (
          <Link
            href={`/pages/${home.id}`}
            className={`${primaryButtonClass} inline-flex items-center`}
          >
            <FormattedMessage id="overview.editHome" />
          </Link>
        )}
        <button
          type="button"
          disabled={newPost.isPending}
          onClick={writePost}
          className={home ? secondaryButtonClass : primaryButtonClass}
        >
          <FormattedMessage id="overview.writePost" />
        </button>
      </div>
      {/* Always mounted: screen readers can miss a live region added along with its text. */}
      <p role="alert" className="mt-4 font-medium text-danger empty:sr-only">
        {error && errorText(error, intl.formatMessage({ id: "offline.body" }))}
      </p>
      {me.user.isOwner && <BackupReminder />}
      <section aria-labelledby="overview-next" className="mt-10">
        <h2 id="overview-next" className="text-xl font-semibold">
          <FormattedMessage id="overview.nextHeading" />
        </h2>
        <ul className="mt-2 grid gap-1">
          {me.user.role === "admin" && me.starter === "business" && (
            <li>
              <Link href="/settings/business" className={textLinkClass}>
                <FormattedMessage id="overview.business" />
              </Link>
            </li>
          )}
          {me.user.role === "admin" && (
            <li>
              <Link href="/design" className={textLinkClass}>
                <FormattedMessage id="overview.logo" />
              </Link>
            </li>
          )}
          <li>
            <Link href="/media" className={textLinkClass}>
              <FormattedMessage id="overview.photos" />
            </Link>
          </li>
          {(me.user.role === "admin" || me.user.role === "editor") && (
            <li>
              <Link href="/menu" className={textLinkClass}>
                <FormattedMessage id="overview.menu" />
              </Link>
            </li>
          )}
        </ul>
      </section>
    </AdminLayout>
  );
}

/** Where people land after setup and sign-in. The real checklist arrives later. */
export function Overview() {
  return <SignedIn>{(me) => <OverviewScreen me={me} />}</SignedIn>;
}
