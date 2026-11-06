import { useMutation, useQuery } from "@tanstack/react-query";
import { FormattedMessage, useIntl } from "react-intl";
import { Link, useLocation } from "wouter";
import { AdminLayout, SignedIn } from "../components/AdminLayout.tsx";
import { primaryButtonClass, secondaryButtonClass } from "../components/AuthLayout.tsx";
import { api, errorText } from "../lib/api.ts";
import { type EntrySummary, entriesKey, type Me } from "../lib/queries.ts";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

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
      <p className="mt-8 text-muted">
        <FormattedMessage id="overview.next" />
      </p>
    </AdminLayout>
  );
}

/** Where people land after setup and sign-in. The real checklist arrives later. */
export function Overview() {
  return <SignedIn>{(me) => <OverviewScreen me={me} />}</SignedIn>;
}
