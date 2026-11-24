import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { Link, Redirect, useLocation } from "wouter";
import { api, errorText } from "../lib/api.ts";
import { runBeforeSignOut, useHeldDrafts, useKeptOnDevice } from "../lib/held-drafts.ts";
import { ME_KEY, type Me, SETUP_STATUS_KEY, useMe, useSetupStatus } from "../lib/queries.ts";
import { CannotReachTend, Loading } from "./AuthLayout.tsx";
import { useNavigationFocus } from "./focus.ts";

/**
 * Only shows its children to someone who's signed in, and has one of the roles if the screen is
 * for some, and sends everyone else on their way. The server checks again.
 */
export function SignedIn({
  roles,
  children,
}: {
  roles?: string[];
  children: (me: Me) => ReactNode;
}) {
  const me = useMe();
  const status = useSetupStatus();

  if (me.isPending || status.isPending) return <Loading />;
  // A background check failing, on a phone that lost signal for a moment, say, is no
  // reason to replace a page that's working. Only a first answer is worth blocking on.
  if ((me.isError && me.data === undefined) || (status.isError && !status.data)) {
    return (
      <CannotReachTend
        error={me.error ?? status.error}
        retrying={me.isFetching || status.isFetching}
        onRetry={() => {
          void me.refetch();
          void status.refetch();
        }}
      />
    );
  }
  if (!me.data) return <Redirect to={status.data?.needsSetup ? "/setup" : "/login"} replace />;
  if (roles && !roles.includes(me.data.user.role)) return <Redirect to="/" replace />;
  return children(me.data);
}

const EDITOR_PRELOAD_MS = 1500;

/**
 * Each item says who sees it, as PLAN.md §6 sets out: a Writer writes posts, so has no Pages.
 * The server checks again, whatever the screen shows.
 */
const NAV: { href: string; id: string; roles?: string[] }[] = [
  { href: "/", id: "nav.overview" },
  { href: "/posts", id: "nav.posts" },
  { href: "/pages", id: "nav.pages", roles: ["admin", "editor"] },
  { href: "/media", id: "nav.media" },
  { href: "/menu", id: "nav.menu", roles: ["admin", "editor"] },
  { href: "/design", id: "nav.design", roles: ["admin"] },
  { href: "/people", id: "nav.people", roles: ["admin"] },
  { href: "/settings", id: "nav.settings", roles: ["admin"] },
];

const navLinkClass =
  "inline-flex min-h-11 items-center rounded px-2 hover:underline focus-visible:outline-3 focus-visible:outline-brand";

/**
 * Says, on every screen, that the site would be lost with its container (PLAN.md §13), and
 * what to do, in order: the backup comes first, because a new volume starts empty.
 */
function DataRiskNotice({
  risk,
  isOwner,
}: {
  risk: NonNullable<Me["dataRisk"]>;
  isOwner: boolean;
}) {
  const values = { path: risk.path };
  const fix = risk.platform === "railway" || risk.platform === "docker" ? risk.platform : "other";
  return (
    <section
      aria-labelledby="data-risk"
      className="mt-4 rounded-lg border-2 border-danger p-4 [overflow-wrap:anywhere] print:hidden"
    >
      <h2 id="data-risk" className="text-lg font-semibold text-danger">
        <FormattedMessage id="risk.heading" />
      </h2>
      <p className="mt-1">
        <FormattedMessage id={`risk.${risk.why}`} values={values} />
      </p>
      <ol className="mt-2 grid list-decimal gap-1 pl-6">
        <li>
          {isOwner ? (
            <Link href="/settings/backups" className={`${navLinkClass} -ml-2 text-brand underline`}>
              <FormattedMessage id="risk.backup" />
            </Link>
          ) : (
            <FormattedMessage id="risk.backupAsk" />
          )}
        </li>
        <li>
          <FormattedMessage id={`risk.fix.${fix}`} values={values} />
        </li>
        <li>
          <FormattedMessage id="risk.restore" />
        </li>
      </ol>
    </section>
  );
}

export function AdminLayout({
  me,
  screen,
  title,
  focusHeading = true,
  currentEntryId,
  children,
}: {
  me: Me;
  screen: string;
  /** Replaces the `<screen>.title` message, for headings with a name in them. */
  title?: string;
  focusHeading?: boolean;
  /** The entry open on this screen, whose unsaved text doesn't need a notice. */
  currentEntryId?: string;
  children: ReactNode;
}) {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const [location] = useLocation();
  const headingRef = useRef<HTMLHeadingElement>(null);
  useNavigationFocus(headingRef, { enabled: focusHeading });

  const heldDrafts = useHeldDrafts(me.user.id, currentEntryId);
  const onDevice = useKeptOnDevice();

  // Fetched ahead of time, so opening something is quick, and still possible if the
  // connection drops or Tend stops in the meantime.
  useEffect(() => {
    const timer = setTimeout(() => {
      import("../routes/Editor.tsx").catch(() => {});
    }, EDITOR_PRELOAD_MS);
    return () => clearTimeout(timer);
  }, []);

  const signOut = useMutation({
    mutationFn: async () => {
      // Anything being edited is saved first. If that fails, this stops here and says so,
      // with the person still signed in and their text still on the screen.
      await runBeforeSignOut();
      await api("/auth/logout", { method: "POST" });
    },
    onSuccess: () => {
      // Lists and titles shouldn't still be here for whoever signs in next on this computer.
      queryClient.removeQueries({
        predicate: ({ queryKey }) =>
          queryKey[0] !== ME_KEY[0] && queryKey[0] !== SETUP_STATUS_KEY[0],
      });
      queryClient.setQueryData(ME_KEY, null);
    },
  });

  return (
    <div className="min-h-dvh">
      <title>{intl.formatMessage({ id: `${screen}.pageTitle` })}</title>
      <header className="border-b border-ink/10 print:hidden">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2">
          <nav aria-label={intl.formatMessage({ id: "nav.label" })}>
            <ul className="-ml-2 flex flex-wrap items-center">
              {NAV.filter((item) => !item.roles || item.roles.includes(me.user.role)).map(
                (item) => {
                  const current =
                    item.href === "/" ? location === "/" : location.startsWith(item.href);
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        aria-current={current ? "page" : undefined}
                        className={`${navLinkClass} ${current ? "font-semibold" : "text-muted"}`}
                      >
                        <FormattedMessage id={item.id} />
                      </Link>
                    </li>
                  );
                },
              )}
            </ul>
          </nav>
          <div className="-mr-2 flex flex-wrap items-center gap-x-1">
            <span className="px-2 text-sm text-muted">
              <FormattedMessage id="nav.signedInAs" values={{ name: me.user.name }} />
            </span>
            <Link
              href="/account"
              aria-current={location === "/account" ? "page" : undefined}
              className={`${navLinkClass} ${location === "/account" ? "font-semibold" : "text-muted"}`}
            >
              <FormattedMessage id="nav.account" />
            </Link>
            <a href="/" target="_blank" rel="noopener" className={`${navLinkClass} text-brand`}>
              <FormattedMessage id="nav.viewSite" />
            </a>
            <button
              type="button"
              disabled={signOut.isPending}
              onClick={() => signOut.mutate()}
              className={`${navLinkClass} text-muted`}
            >
              <FormattedMessage id="nav.signOut" />
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-8">
        <h1
          ref={headingRef}
          tabIndex={-1}
          className="text-3xl font-semibold tracking-tight break-words outline-none"
        >
          {title ?? <FormattedMessage id={`${screen}.title`} />}
        </h1>
        {/* Always mounted: screen readers can miss a live region added along with its text. */}
        <p role="alert" className="mt-2 font-medium text-danger empty:sr-only">
          {signOut.isError && errorText(signOut.error, intl.formatMessage({ id: "offline.body" }))}
        </p>
        {me.dataRisk && <DataRiskNotice risk={me.dataRisk} isOwner={me.user.isOwner} />}
        {heldDrafts.length > 0 && (
          <ul className="mt-4 grid gap-2">
            {heldDrafts.map((held) => (
              <li
                key={held.key}
                className="flex flex-wrap items-center justify-between gap-x-4 rounded-lg border border-danger px-3 py-1"
              >
                <span className="[overflow-wrap:anywhere]">
                  <FormattedMessage
                    id={onDevice ? "held.notice" : "held.noticeTab"}
                    values={{
                      title: held.draft.title || intl.formatMessage({ id: "list.untitled" }),
                    }}
                  />
                </span>
                <Link
                  href={`/${held.type === "post" ? "posts" : "pages"}/${held.id}`}
                  className={`${navLinkClass} text-brand underline`}
                >
                  <FormattedMessage id="held.open" />
                </Link>
              </li>
            ))}
          </ul>
        )}
        {children}
      </main>
    </div>
  );
}
