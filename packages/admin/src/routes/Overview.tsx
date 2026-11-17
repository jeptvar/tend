import { useMutation, useQuery } from "@tanstack/react-query";
import { FormattedDate, FormattedMessage, useIntl } from "react-intl";
import { Link, useLocation } from "wouter";
import { AdminLayout, SignedIn } from "../components/AdminLayout.tsx";
import {
  primaryButtonClass,
  secondaryButtonClass,
  textLinkClass,
} from "../components/AuthLayout.tsx";
import { api, errorText } from "../lib/api.ts";
import { type EntrySummary, entriesKey, type Me } from "../lib/queries.ts";
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

/** Says only what's true about who can see the site (PLAN.md P15). */
function siteStatusId(me: Me): string {
  if (LOCAL_HOSTS.has(window.location.hostname)) return "overview.local";
  return me.siteIsPublic ? "overview.online" : "overview.noAddress";
}

function OverviewScreen({ me }: { me: Me }) {
  const intl = useIntl();
  const [, navigate] = useLocation();

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
