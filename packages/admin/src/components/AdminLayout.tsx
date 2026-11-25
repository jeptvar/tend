import { useMutation } from "@tanstack/react-query";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { Link, Redirect, useLocation } from "wouter";
import { api, errorText } from "../lib/api.ts";
import { useHeldDrafts, useKeptOnDevice } from "../lib/held-drafts.ts";
import { onThisComputer } from "../lib/hosts.ts";
import { type EntrySummary, type Me, useMe, useSetupStatus } from "../lib/queries.ts";
import { useSignOut } from "../lib/sign-out.ts";
import { CannotReachTend, Loading, textLinkClass } from "./AuthLayout.tsx";
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
  /** Starts a new group, under a line. */
  apart?: boolean;
}

/** The server checks again who may do what, whatever the menu shows. */
const PLACES: Place[] = [
  { href: "/", id: "nav.overview", icon: "overview" },
  { href: "/posts", id: "nav.posts", icon: "posts" },
  { href: "/pages", id: "nav.pages", icon: "pages", roles: ["admin", "editor"] },
  { href: "/media", id: "nav.media", icon: "media" },
  { href: "/menu", id: "nav.menu", icon: "menu", roles: ["admin", "editor"], apart: true },
  { href: "/design", id: "nav.design", icon: "design", roles: ["admin"] },
  { href: "/people", id: "nav.people", icon: "people", roles: ["admin"] },
  { href: "/settings", id: "nav.settings", icon: "settings", roles: ["admin"] },
];

const menuItemClass =
  "flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left hover:bg-white/8 focus-visible:outline-3 focus-visible:-outline-offset-3 focus-visible:outline-white";

function isHere(location: string, href: string): boolean {
  return href === "/" ? location === "/" : location === href || location.startsWith(`${href}/`);
}

/** The first letter of a name, or of its first two words, for a picture of someone or something. */
export function initials(name: string, most = 2): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, most)
    .map((word) => [...word][0] ?? "")
    .join("")
    .toLocaleUpperCase();
}

/** Who can see the site, in a couple of words, and only what's true (PLAN.md P15). */
function siteState(me: Me): { id: string; color: string } {
  const { address, addressIsPublic, visibility } = me.site;
  const waiting = "bg-[#e8b04b]";
  if (onThisComputer()) return { id: "nav.state.local", color: waiting };
  if (!address) return { id: "nav.state.noAddress", color: waiting };
  if (visibility !== "public") return { id: `nav.state.${visibility}`, color: waiting };
  return addressIsPublic
    ? { id: "nav.state.live", color: "bg-[#5fce93]" }
    : { id: "nav.state.network", color: waiting };
}

function SiteName({ me, rail = false }: { me: Me; rail?: boolean }) {
  const { id, color } = siteState(me);
  return (
    <p className={`flex min-w-0 items-center gap-2.5 ${rail ? "justify-center" : "flex-1"}`}>
      <span
        aria-hidden="true"
        className="grid size-10 shrink-0 place-items-center rounded-xl bg-white text-lg font-bold text-[#1f6f4a] shadow-md"
      >
        {initials(me.site.name, 1)}
      </span>
      <span className={rail ? "sr-only" : "min-w-0"}>
        <span className="line-clamp-2 font-semibold [overflow-wrap:anywhere] text-white">
          {me.site.name}
        </span>
        <span className="flex items-baseline gap-1.5 text-[0.8125rem] leading-tight text-side-muted">
          <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${color}`} />
          <FormattedMessage id={id} />
        </span>
      </span>
    </p>
  );
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
  const itemClass = `${menuItemClass} ${rail ? "justify-center px-0" : ""}`;

  function link({ href, id, icon, apart }: Place) {
    const here = isHere(location, href);
    return (
      <li key={href} className={apart ? "mt-2 border-t border-white/10 pt-2" : ""}>
        <Link
          href={href}
          aria-current={here ? "page" : undefined}
          onClick={onGo}
          className={`${itemClass} ${here ? "bg-white/14 font-semibold text-white" : ""}`}
          {...hint(id)}
        >
          <Icon name={icon} className={`size-5 ${here ? "text-leaf" : ""}`} />
          {label(id)}
        </Link>
      </li>
    );
  }

  return (
    <>
      <nav aria-label={intl.formatMessage({ id: "nav.label" })} className="px-3">
        <ul className="grid gap-0.5">
          {PLACES.filter((place) => !place.roles || place.roles.includes(me.user.role)).map(link)}
        </ul>
      </nav>
      <div className="mt-auto px-3 pt-4">
        <ul className="grid gap-0.5">
          <li>
            <a
              href="/"
              target="_blank"
              rel="noopener"
              className={itemClass}
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
              className={itemClass}
              {...hint("nav.signOut")}
            >
              <Icon name="signOut" />
              {label("nav.signOut")}
            </button>
          </li>
        </ul>
        {/* Always mounted: screen readers can miss a live region added along with its text. */}
        <p role="alert" className="px-3 py-1 text-sm font-medium text-[#f7c4b9] empty:sr-only">
          {signOut.isError && <Problem error={signOut.error} />}
        </p>
        <p
          className={`mt-2 flex items-center gap-3 rounded-xl ${rail ? "justify-center py-1" : "bg-white/7 p-2.5"}`}
        >
          <span
            aria-hidden="true"
            className="grid size-9 shrink-0 place-items-center rounded-full bg-linear-to-br from-[#f3cc98] to-[#dd9757] text-xs font-bold text-[#4b2708]"
          >
            {initials(me.user.name)}
          </span>
          <span
            className={
              rail ? "sr-only" : "min-w-0 text-sm [overflow-wrap:anywhere] text-side-muted"
            }
          >
            <FormattedMessage
              id="nav.signedInAs"
              values={{
                name: <span className="block font-semibold text-white">{me.user.name}</span>,
              }}
            />
          </span>
        </p>
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
function SideMenu({ me, narrow }: { me: Me; narrow: boolean }) {
  const intl = useIntl();
  const [kept, setRail] = useState(keptRail);
  const rail = narrow || kept;

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
      className={`side sticky top-0 hidden h-dvh shrink-0 flex-col gap-3 overflow-y-auto py-4 lg:flex print:hidden ${rail ? "w-19" : "w-66"}`}
    >
      <div className={`flex items-center gap-0.5 ${rail ? "flex-col px-3" : "pr-1.5 pl-4.5"}`}>
        <SiteName me={me} rail={rail} />
        {!narrow && (
          <button
            type="button"
            onClick={toggle}
            title={intl.formatMessage({ id: rail ? "nav.widen" : "nav.narrow" })}
            className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl text-side-muted hover:bg-white/8 hover:text-white focus-visible:outline-3 focus-visible:-outline-offset-3 focus-visible:outline-white"
          >
            <Icon name={rail ? "widen" : "narrow"} />
            <span className="sr-only">
              <FormattedMessage id={rail ? "nav.widen" : "nav.narrow"} />
            </span>
          </button>
        )}
      </div>
      <Menu me={me} rail={rail} />
    </header>
  );
}

/** The top of a phone's or tablet's screen: the site's name, and the menu behind a button. */
function TopBar({ me }: { me: Me }) {
  const intl = useIntl();
  const headingId = useId();
  const [open, setOpen] = useState(false);
  return (
    <header className="side flex items-center justify-between gap-3 px-4 py-2 lg:hidden print:hidden">
      <SiteName me={me} />
      <button
        type="button"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        className="-mr-2 inline-flex min-h-11 shrink-0 items-center gap-2 rounded-xl px-3 font-medium text-white hover:bg-white/8 focus-visible:outline-3 focus-visible:outline-white"
      >
        <Icon name="open" />
        <FormattedMessage id="nav.open" />
      </button>
      {open && (
        <Dialog labelledBy={headingId} size="side" onClose={() => setOpen(false)}>
          <div className="flex min-h-full flex-col gap-2 py-3">
            <div className="flex items-center justify-between gap-2 pr-3 pl-6">
              <h2 id={headingId} className="font-semibold text-white">
                <FormattedMessage id="nav.open" />
              </h2>
              <button
                type="button"
                aria-label={intl.formatMessage({ id: "nav.close" })}
                onClick={() => setOpen(false)}
                className="inline-flex size-11 items-center justify-center rounded-xl hover:bg-white/8 focus-visible:outline-3 focus-visible:outline-white"
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
  "flex min-h-16 w-full flex-col items-center justify-center gap-0.5 px-1 text-xs font-medium focus-visible:outline-3 focus-visible:-outline-offset-3 focus-visible:outline-brand";

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
          className={`${barItemClass} ${here ? "font-semibold text-brand" : "text-muted"}`}
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
      className="tend-bar fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface shadow-[0_-10px_30px_-22px_rgb(0_0_0/45%)] lg:hidden print:hidden"
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
            className={`${barItemClass} text-brand`}
          >
            <span className="primary grid h-7 w-12 place-items-center rounded-full">
              <Icon name="add" />
            </span>
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
      className="mt-6 rounded-2xl border-2 border-danger bg-danger-soft p-5 [overflow-wrap:anywhere] print:hidden"
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
            <Link href="/settings/backups" className={`${textLinkClass} underline`}>
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

/** How much of the window a screen wants: forms are read, lists and pictures are looked over. */
const WIDTHS = {
  form: "max-w-200",
  wide: "",
};

export function AdminLayout({
  me,
  screen,
  title,
  intro,
  actions,
  width = "form",
  focusHeading = true,
  currentEntryId,
  writing = false,
  beside,
  children,
}: {
  me: Me;
  screen: string;
  /** Replaces the `<screen>.title` message, for headings with a name in them. */
  title?: string;
  /** A line under the heading. */
  intro?: ReactNode;
  /** What can be done here, beside the heading. */
  actions?: ReactNode;
  width?: keyof typeof WIDTHS;
  focusHeading?: boolean;
  /** The entry open on this screen, whose unsaved text doesn't need a notice. */
  currentEntryId?: string;
  /**
   * A screen for writing: the menu is only its drawings, phones have neither bar, and the
   * heading is for screen readers, because the title being written is the biggest thing.
   */
  writing?: boolean;
  /** What a form has beside it, on a window wide enough for both. */
  beside?: ReactNode;
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
        className="absolute top-2 left-2 z-40 inline-flex min-h-11 -translate-y-20 items-center rounded-lg bg-brand px-4 font-medium text-on-brand focus:translate-y-0 print:hidden"
      >
        <FormattedMessage id="nav.skip" />
      </a>
      <SideMenu me={me} narrow={writing} />
      <div className="flex min-w-0 flex-1 flex-col">
        {!writing && <TopBar me={me} />}
        <main id={contentId} className="flex w-full flex-1">
          <div
            className={
              writing
                ? "min-w-0 flex-1"
                : `mx-auto w-full max-w-6xl min-w-0 px-4 py-8 max-lg:pb-24 sm:px-8 lg:px-11 ${
                    beside
                      ? "xl:mx-0 xl:w-112 xl:shrink-0 xl:border-r xl:border-line xl:bg-surface xl:px-7 xl:pb-0"
                      : ""
                  }`
            }
          >
            <div className={writing ? "" : WIDTHS[width]}>
              <div className={writing ? "mx-auto max-w-4xl px-4 *:mt-4" : "contents"}>
                <OpenConnection address={me.site.address} />
              </div>
              <div className={writing ? "" : "flex flex-wrap items-end gap-x-6 gap-y-4"}>
                <div className={writing ? "sr-only" : "min-w-0 flex-1 basis-72"}>
                  <h1
                    ref={headingRef}
                    tabIndex={-1}
                    className="text-3xl font-bold tracking-tight break-words outline-none sm:text-[2.125rem]"
                  >
                    {title ?? <FormattedMessage id={`${screen}.title`} />}
                  </h1>
                  {intro && <div className="mt-1.5 text-muted">{intro}</div>}
                </div>
                {actions && <div className="flex flex-wrap items-center gap-3">{actions}</div>}
              </div>
              <div className={writing ? "mx-auto max-w-4xl px-4 *:last:mb-6" : "contents"}>
                {me.dataRisk && <DataRiskNotice risk={me.dataRisk} isOwner={me.user.isOwner} />}
                {heldDrafts.length > 0 && (
                  <ul className="mt-6 grid gap-2">
                    {heldDrafts.map((held) => (
                      <li
                        key={held.key}
                        className="flex flex-wrap items-center justify-between gap-x-4 rounded-2xl border border-danger bg-danger-soft px-5 py-1.5"
                      >
                        <span className="[overflow-wrap:anywhere]">
                          <FormattedMessage
                            id={onDevice ? "held.notice" : "held.noticeTab"}
                            values={{
                              title:
                                held.draft.title || intl.formatMessage({ id: "list.untitled" }),
                            }}
                          />
                        </span>
                        <Link
                          href={`/${held.type === "post" ? "posts" : "pages"}/${held.id}`}
                          className={`${textLinkClass} underline`}
                        >
                          <FormattedMessage id="held.open" />
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {children}
            </div>
          </div>
          {/* By the window's own width, which is there before anything here hears of a new one. */}
          {beside && <div className="min-w-0 flex-1 max-xl:hidden">{beside}</div>}
        </main>
      </div>
      {!writing && <BottomBar me={me} />}
    </div>
  );
}
