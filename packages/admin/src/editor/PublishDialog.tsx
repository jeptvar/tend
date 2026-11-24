import { useEffect, useId, useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { primaryButtonClass, secondaryButtonClass } from "../components/AuthLayout.tsx";
import { Dialog } from "../components/Dialog.tsx";
import { onThisComputer } from "../lib/hosts.ts";
import { useMediaItems } from "../lib/media.ts";
import type { EntryFull, EntryType, Me } from "../lib/queries.ts";
import type { Check, CheckTarget } from "./checks.ts";

/** Copying only has a modern way to do it on https and localhost, so this falls back. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const box = document.createElement("textarea");
    box.value = text;
    box.setAttribute("readonly", "");
    box.style.position = "fixed";
    box.style.opacity = "0";
    const active = document.activeElement as HTMLElement | null;
    // Inside the dialog, because everything outside a modal dialog can't be selected.
    (active?.closest("dialog") ?? document.body).append(box);
    box.select();
    try {
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      box.remove();
      active?.focus();
    }
  }
}

/** Who can see it once it's published, when that isn't everyone (PLAN.md P15). */
function WhoSees({ me }: { me: Me }) {
  const id = onThisComputer()
    ? "publish.sees.local"
    : me.site.visibility === "public"
      ? null
      : `publish.sees.${me.site.visibility}`;
  return id && <FormattedMessage id={id} />;
}

/** The review before something goes on the site, and the screen after it does (PLAN.md J2). */
export function PublishDialog({
  me,
  entry,
  type,
  checks,
  summary,
  shareTitle,
  sharePicture,
  done,
  busy,
  problem,
  canEditMenu,
  onPublish,
  onFix,
  onGoTo,
  onClose,
  onWriteAnother,
}: {
  me: Me;
  entry: EntryFull;
  type: EntryType;
  checks: Check[];
  summary: string;
  /** The title shown when it's shared: the one for search results, if there is one. */
  shareTitle?: string;
  /** The picture shown with it, if it has one. */
  sharePicture: string | null;
  done: boolean;
  busy: boolean;
  problem: string | null;
  /** Whether this person can change the site menu. */
  canEditMenu: boolean;
  onPublish: (options: { addToMenu: boolean }) => void;
  onFix: (field: "title" | "slug") => void;
  /** Leads to what a check is about. */
  onGoTo: (target: CheckTarget) => void;
  onClose: () => void;
  onWriteAnother: () => void;
}) {
  const intl = useIntl();
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [copied, setCopied] = useState<"copied" | "failed" | null>(null);
  // The site's own address, when it has one: the admin may be open at another.
  const origin = me.site.address ?? window.location.origin;
  const fullAddress = new URL(entry.url ?? entry.address.path, origin).href;
  const picture = useMediaItems(sharePicture ? [sharePicture] : []).found.get(sharePicture ?? "");
  const noTitle = entry.title.trim() === "";
  const addressProblem = entry.address.problem;
  // Only a page that isn't linked yet, from a menu someone has set up: an automatic menu
  // has every page already. Ticked while the menu is short (PLAN.md J4).
  const offerMenu =
    canEditMenu &&
    type === "page" &&
    // Only the first time: a page that's been on the site may have been left out on purpose.
    entry.url === null &&
    !entry.isHome &&
    entry.menu !== undefined &&
    !entry.menu.automatic &&
    !entry.menu.inMenu &&
    // A full menu has no room: making some is for the Site menu screen.
    entry.menu.size < 30;
  const [addToMenu, setAddToMenu] = useState(() => (entry.menu?.size ?? 0) < 6);
  const menuHintId = useId();

  // The button that was just pressed has gone, so the good news gets the focus.
  useEffect(() => {
    if (done) headingRef.current?.focus();
  }, [done]);

  if (done) {
    return (
      <Dialog labelledBy={headingId} onClose={onClose}>
        <div className="grid gap-4">
          <h2
            ref={headingRef}
            id={headingId}
            tabIndex={-1}
            className="text-xl font-semibold outline-none"
          >
            <FormattedMessage id={type === "post" ? "publish.donePost" : "publish.donePage"} />
          </h2>
          <p className="[overflow-wrap:anywhere]">{fullAddress}</p>
          <p className="text-muted empty:hidden">
            <WhoSees me={me} />
          </p>
          <p role="status" className="empty:sr-only">
            {copied === "failed" ? intl.formatMessage({ id: "publish.copyFailed" }) : ""}
            {copied === "copied" ? intl.formatMessage({ id: "publish.copied" }) : ""}
          </p>
          <p role="alert" className="font-medium text-danger empty:sr-only">
            {problem}
          </p>
          <div className="flex flex-wrap gap-3">
            <a
              href={entry.url ?? entry.address.path}
              target="_blank"
              rel="noopener"
              className={`${primaryButtonClass} inline-flex items-center`}
            >
              <FormattedMessage id={type === "post" ? "publish.viewPost" : "publish.viewPage"} />
            </a>
            <button
              type="button"
              className={secondaryButtonClass}
              onClick={() => {
                void copyText(fullAddress).then((worked) =>
                  setCopied(worked ? "copied" : "failed"),
                );
              }}
            >
              <FormattedMessage id="publish.copy" />
            </button>
            <button type="button" className={secondaryButtonClass} onClick={onWriteAnother}>
              <FormattedMessage
                id={type === "post" ? "publish.anotherPost" : "publish.anotherPage"}
              />
            </button>
            <button type="button" className={secondaryButtonClass} onClick={onClose}>
              <FormattedMessage id="publish.keepEditing" />
            </button>
          </div>
        </div>
      </Dialog>
    );
  }

  const blocked = noTitle || addressProblem !== null;
  return (
    <Dialog labelledBy={headingId} onClose={onClose}>
      <div className="grid gap-4">
        <h2 id={headingId} className="text-xl font-semibold">
          <FormattedMessage id="publish.heading" />
        </h2>

        <div>
          <p className="text-sm text-muted">
            <FormattedMessage id="publish.address" />
          </p>
          <p className="font-medium [overflow-wrap:anywhere]">
            {new URL(entry.address.path, origin).href}
          </p>
          <p className="text-sm text-muted empty:hidden">
            <WhoSees me={me} />
          </p>
        </div>

        <div>
          <p className="text-sm text-muted">
            <FormattedMessage id="publish.social" />
          </p>
          <div className="mt-1 overflow-hidden rounded-lg border border-muted">
            {picture?.previewUrl && picture.trashedAt === null && (
              <img
                src={picture.previewUrl}
                alt={picture.alt ?? ""}
                style={{ backgroundColor: picture.dominantColor ?? undefined }}
                className="aspect-[1.91] w-full object-cover"
              />
            )}
            <div className="p-3">
              <p className="font-medium [overflow-wrap:anywhere]">
                {shareTitle || entry.title || intl.formatMessage({ id: "list.untitled" })}
              </p>
              {summary && <p className="mt-1 line-clamp-3 text-sm text-muted">{summary}</p>}
              <p className="mt-1 text-sm [overflow-wrap:anywhere] text-muted">
                {new URL(origin).host}
              </p>
            </div>
          </div>
        </div>

        {noTitle && (
          <div className="grid gap-2 rounded-lg border border-danger p-3">
            <p>
              <FormattedMessage id="publish.needsTitle" />
            </p>
            <div>
              <button type="button" className={secondaryButtonClass} onClick={() => onFix("title")}>
                <FormattedMessage id="publish.fix" />
              </button>
            </div>
          </div>
        )}
        {addressProblem && (
          <div className="grid gap-2 rounded-lg border border-danger p-3">
            <p>
              {addressProblem.message} {addressProblem.fix}
            </p>
            <div>
              <button type="button" className={secondaryButtonClass} onClick={() => onFix("slug")}>
                <FormattedMessage id="publish.fix" />
              </button>
            </div>
          </div>
        )}

        {checks.length > 0 && (
          <div>
            <p className="font-medium">
              <FormattedMessage id="publish.checks" />
            </p>
            <ul className="mt-1 grid gap-2">
              {checks.map((check, index) => {
                const { target } = check;
                const id = `${headingId}-check-${index}`;
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: the same check can appear twice
                  <li key={index} className="flex items-start justify-between gap-3">
                    <span id={id} className="min-w-0 py-2 [overflow-wrap:anywhere]">
                      <FormattedMessage
                        id={check.id}
                        {...(check.values ? { values: check.values } : {})}
                      />
                    </span>
                    {target && (
                      <button
                        type="button"
                        aria-describedby={id}
                        onClick={() => onGoTo(target)}
                        className={`${secondaryButtonClass} shrink-0`}
                      >
                        <FormattedMessage id="publish.fixCheck" />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {offerMenu && (
          <div className="grid gap-1">
            <label className="flex min-h-11 items-center gap-3">
              <input
                type="checkbox"
                checked={addToMenu}
                aria-describedby={menuHintId}
                onChange={(event) => setAddToMenu(event.target.checked)}
                className="h-5 w-5 accent-brand"
              />
              <FormattedMessage id="publish.showInMenu" />
            </label>
            <p id={menuHintId} className="text-sm text-muted">
              <FormattedMessage id="publish.showInMenuHint" />
            </p>
          </div>
        )}

        <p role="alert" className="font-medium text-danger empty:sr-only">
          {problem}
        </p>

        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            aria-disabled={blocked || busy}
            onClick={() => {
              if (!blocked && !busy) onPublish({ addToMenu: offerMenu && addToMenu });
            }}
            className={`${primaryButtonClass} aria-disabled:opacity-60`}
          >
            <FormattedMessage
              id={
                busy
                  ? "editor.publishing"
                  : entry.url
                    ? "editor.publishChanges"
                    : type === "post"
                      ? "publish.postNow"
                      : "publish.pageNow"
              }
            />
          </button>
          <button type="button" className={secondaryButtonClass} onClick={onClose}>
            <FormattedMessage id="publish.notYet" />
          </button>
        </div>
      </div>
    </Dialog>
  );
}
