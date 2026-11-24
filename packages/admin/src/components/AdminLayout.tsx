import { useMutation } from "@tanstack/react-query";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { Link, Redirect, useLocation } from "wouter";
import { api, errorText } from "../lib/api.ts";
import { useHeldDrafts, useKeptOnDevice } from "../lib/held-drafts.ts";
import { type EntrySummary, type Me, useMe, useSetupStatus } from "../lib/queries.ts";
import { useSignOut } from "../lib/sign-out.ts";
import { CannotReachTend, Leaf, Loading } from "./AuthLayout.tsx";
import { Dialog } from "./Dialog.tsx";
import { useNavigationFocus } from "./focus.ts";
import { Icon, type IconName } from "./icons.tsx";
import { OpenConnection } from "./OpenConnection.tsx";
import { Problem } from "./Problem.tsx";
import { showToast } from "./Toast.tsx";

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
const RAIL_KEY = "tend-rail";

interface Place {
  href: string;
  id: string;
  icon: IconName;
  /** Who sees it, as PLAN.md §6 sets out: a Writer writes posts, so has no Pages. */
  roles?: string[];
}

/** The server checks again who may do what, whatever the menu shows. */
const PLACES: Place[] = [
  { href: "/", id: "nav.overview", icon: "overview" },
  { href: "/posts", id: "nav.posts", icon: "posts" },
  { href: "/pages", id: "nav.pages", icon: "pages", roles: ["admin", "editor"] },
  { href: "/media", id: "nav.media", icon: "media" },
  { href: "/menu", id: "nav.menu", icon: "menu", roles: ["admin", "editor"] },
  { href: "/design", id: "nav.design", icon: "design", roles: ["admin"] },
  { href: "/people", id: "nav.people", icon: "people", roles: ["admin"] },
  { href: "/settings", id: "nav.settings", icon: "settings", roles: ["admin"] },
];

const navLinkClass =
  "inline-flex min-h-11 items-center rounded px-2 hover:underline focus-visible:outline-3 focus-visible:outline-brand";
const menuItemClass =
  "flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left hover:bg-ink/5 focus-visible:outline-3 focus-visible:-outline-offset-3 focus-visible:outline-brand";

function isHere(location: string, href: string): boolean {
  return href === "/" ? location === "/" : location === href || location.startsWith(`${href}/`);
}

/**
 * Everywhere in the admin, then View site, Help, Account and Sign out, in the same order on
 * every screen. As a rail it's only the drawings, with their names for screen readers and
 * when pointed at.
 */
function Menu({
  me,
  rail = false,
  onGo,
}: {
  me: Me;
  rail?: boolean;
  /** Called when somewhere is chosen, so the menu on a phone can close. */
  onGo?: () => void;
}) {
  const intl = useIntl();
  const [location] = useLocation();
  const signOut = useSignOut();

  const label = (id: string) => (
    <span className={rail ? "sr-only" : "min-w-0 [overflow-wrap:anywhere]"}>
      <FormattedMessage id={id} />
    </span>
  );
  const hint = (id: string) => (rail ? { title: intl.formatMessage({ id }) } : {});

  function link({ href, id, icon }: Place) {
    const here = isHere(location, href);
    return (
      <li key={href}>
        <Link
          href={href}
          aria-current={here ? "page" : undefined}
          onClick={onGo}
          className={`${menuItemClass} ${here ? "bg-brand/10 font-semibold" : ""} ${rail ? "justify-center px-0" : ""}`}
          {...hint(id)}
        >
          <Icon name={icon} />
          {label(id)}
        </Link>
      </li>
    );
  }

  return (
    <>
      <nav aria-label={intl.formatMessage({ id: "nav.label" })} className="px-2">
        <ul className="grid gap-0.5">
          {PLACES.filter((place) => !place.roles || place.roles.includes(me.user.role)).map(link)}
        </ul>
      </nav>
      <div className="mt-auto border-t border-ink/10 px-2 pt-2">
        <ul className="grid gap-0.5">
          <li>
            <a
              href="/"
              target="_blank"
              rel="noopener"
              className={`${menuItemClass} ${rail ? "justify-center px-0" : ""}`}
              {...hint("nav.viewSite")}
            >
              <Icon name="view" />
              {label("nav.viewSite")}
            </a>
          </li>
          {link({ href: "/help", id: "nav.help", icon: "help" })}
          {link({ href: "/account", id: "nav.account", icon: "account" })}
          <li>
            <button
              type="button"
              disabled={signOut.isPending}
              onClick={() => signOut.mutate()}
              className={`${menuItemClass} ${rail ? "justify-center px-0" : ""}`}
              {...hint("nav.signOut")}
            >
              <Icon name="signOut" />
              {label("nav.signOut")}
            </button>
          </li>
        </ul>
        {/* Always mounted: screen readers can miss a live region added along with its text. */}
        <p role="alert" className="px-3 py-1 text-sm font-medium text-danger empty:sr-only">
          {signOut.isError && <Problem error={signOut.error} />}
        </p>
        {!rail && (
          <p className="px-3 py-1 text-sm [overflow-wrap:anywhere] text-muted">
            <FormattedMessage id="nav.signedInAs" values={{ name: me.user.name }} />
          </p>
        )}
      </div>
    </>
  );
}

function keptRail(): boolean {
  try {
    return localStorage.getItem(RAIL_KEY) === "narrow";
  } catch {
    return false;
  }
}

/** The menu down the side of a wide screen. Someone can make it narrow, and this device remembers. */
function SideMenu({ me }: { me: Me }) {
  const [rail, setRail] = useState(keptRail);

  function toggle() {
    setRail(!rail);
    try {
      if (rail) localStorage.removeItem(RAIL_KEY);
      else localStorage.setItem(RAIL_KEY, "narrow");
    } catch {
      // It stays as it is until this screen is left.
    }
  }

  return (
    <header
      className={`sticky top-0 hidden h-dvh shrink-0 flex-col gap-2 overflow-y-auto border-r border-ink/10 py-3 lg:flex print:hidden ${rail ? "w-18" : "w-60"}`}
    >
      <p
        className={`flex min-h-11 items-center gap-3 px-5 font-semibold ${rail ? "justify-center px-0" : ""}`}
      >
        <Leaf className="size-6" />
        <span className={rail ? "sr-only" : "min-w-0 [overflow-wrap:anywhere]"}>
          {me.site.name}
        </span>
      </p>
      <Menu me={me} rail={rail} />
      <div className="px-2">
        <button
          type="button"
          onClick={toggle}
          className={`${menuItemClass} text-muted ${rail ? "justify-center px-0" : ""}`}
        >
          <Icon name={rail ? "widen" : "narrow"} />
          <span className={rail ? "sr-only" : ""}>
            <FormattedMessage id={rail ? "nav.widen" : "nav.narrow"} />
          </span>
        </button>
      </div>
    </header>
  );
}

/** The top of a phone's or tablet's screen: the site's name, and the menu behind a button. */
function TopBar({ me }: { me: Me }) {
  const intl = useIntl();
  const headingId = useId();
  const [open, setOpen] = useState(false);
  return (
    <header className="flex items-center justify-between gap-3 border-b border-ink/10 px-4 py-1 lg:hidden print:hidden">
      <span className="flex min-w-0 items-center gap-2 font-semibold">
        <Leaf className="size-6" />
        <span className="min-w-0 truncate">{me.site.name}</span>
      </span>
      <button
        type="button"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        className={`${navLinkClass} -mr-2 gap-2`}
      >
        <Icon name="open" />
        <FormattedMessage id="nav.open" />
      </button>
      {open && (
        <Dialog labelledBy={headingId} size="side" onClose={() => setOpen(false)}>
          <div className="flex min-h-full flex-col gap-2 py-3">
            <div className="flex items-center justify-between gap-2 px-5">
              <h2 id={headingId} className="font-semibold">
                <FormattedMessage id="nav.open" />
              </h2>
              <button
                type="button"
                aria-label={intl.formatMessage({ id: "nav.close" })}
                onClick={() => setOpen(false)}
                className={`${navLinkClass} -mr-2 min-w-11 justify-center`}
              >
                <Icon name="close" />
              </button>
            </div>
            <Menu me={me} onGo={() => setOpen(false)} />
          </div>
        </Dialog>
      )}
    </header>
  );
}

const barItemClass =
  "flex min-h-16 w-full flex-col items-center justify-center gap-0.5 px-1 text-xs focus-visible:outline-3 focus-visible:-outline-offset-3 focus-visible:outline-brand";

/**
 * What a phone has within reach of a thumb, which follows how the site began (PLAN.md §6): a
 * Blog is mostly posts, and any other site mostly pages. A Writer only has posts.
 */
function BottomBar({ me }: { me: Me }) {
  const intl = useIntl();
  const [location, navigate] = useLocation();
  const posts = me.starter === "blog" || me.user.role === "writer";
  const list = posts ? "/posts" : "/pages";
  const create = useMutation({
    mutationFn: () =>
      api<EntrySummary>("/admin/entries", {
        method: "POST",
        body: { type: posts ? "post" : "page" },
      }),
    onError: (error) =>
      showToast({
        message: errorText(error, intl.formatMessage({ id: "offline.body" })),
        sticky: true,
      }),
  });

  function link(href: string, id: string, icon: IconName) {
    const here = isHere(location, href);
    return (
      <li>
        <Link
          href={href}
          aria-current={here ? "page" : undefined}
          className={`${barItemClass} ${here ? "font-semibold text-brand" : ""}`}
        >
          <Icon name={icon} />
          <FormattedMessage id={id} />
        </Link>
      </li>
    );
  }

  return (
    <nav
      aria-label={intl.formatMessage({ id: "nav.quick" })}
      className="tend-bar fixed inset-x-0 bottom-0 z-30 border-t border-ink/10 bg-paper lg:hidden print:hidden"
    >
      <ul className="mx-auto grid max-w-lg grid-cols-4">
        {link("/", "nav.overview", "overview")}
        {posts ? link("/posts", "nav.posts", "posts") : link("/pages", "nav.pages", "pages")}
        <li>
          <button
            type="button"
            aria-label={intl.formatMessage({ id: posts ? "list.newPost" : "list.newPage" })}
            aria-disabled={create.isPending}
            onClick={() => {
              if (create.isPending) return;
              // Passed here, so it only runs if this screen is still open.
              create.mutate(undefined, {
                onSuccess: (entry) => navigate(`${list}/${entry.id}`),
              });
            }}
            className={barItemClass}
          >
            <Icon name="add" />
            <FormattedMessage id="nav.new" />
          </button>
        </li>
        {link("/media", "nav.media", "media")}
      </ul>
    </nav>
  );
}

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
  writing = false,
  children,
}: {
  me: Me;
  screen: string;
  /** Replaces the `<screen>.title` message, for headings with a name in them. */
  title?: string;
  focusHeading?: boolean;
  /** The entry open on this screen, whose unsaved text doesn't need a notice. */
  currentEntryId?: string;
  /** Leaves out the bar at the bottom of phones, where there's little enough room to write. */
  writing?: boolean;
  children: ReactNode;
}) {
  const intl = useIntl();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const contentId = useId();
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

  return (
    <div className="min-h-dvh lg:flex">
      <title>{intl.formatMessage({ id: `${screen}.pageTitle` })}</title>
      <a
        href={`#${contentId}`}
        onClick={(event) => {
          // The address isn't to change: it's the admin's own, and reloading should come back.
          event.preventDefault();
          headingRef.current?.focus();
        }}
        className="absolute top-2 left-2 z-40 inline-flex min-h-11 -translate-y-20 items-center rounded-lg bg-brand px-4 font-medium text-paper focus:translate-y-0 print:hidden"
      >
        <FormattedMessage id="nav.skip" />
      </a>
      <SideMenu me={me} />
      <div className="min-w-0 flex-1">
        <TopBar me={me} />
        <main
          id={contentId}
          className={`mx-auto max-w-3xl px-4 py-8 ${writing ? "" : "max-lg:pb-24"}`}
        >
          <OpenConnection address={me.site.address} />
          <h1
            ref={headingRef}
            tabIndex={-1}
            className="text-3xl font-semibold tracking-tight break-words outline-none"
          >
            {title ?? <FormattedMessage id={`${screen}.title`} />}
          </h1>
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
      {!writing && <BottomBar me={me} />}
    </div>
  );
}
