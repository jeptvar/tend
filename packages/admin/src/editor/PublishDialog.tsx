import { useEffect, useId, useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { primaryButtonClass, secondaryButtonClass } from "../components/AuthLayout.tsx";
import { Dialog } from "../components/Dialog.tsx";
import type { EntryFull, EntryType } from "../lib/queries.ts";
import type { Check } from "./checks.ts";

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

/** The review before something goes on the site, and the screen after it does (PLAN.md J2). */
export function PublishDialog({
  entry,
  type,
  checks,
  summary,
  done,
  busy,
  problem,
  onPublish,
  onFix,
  onClose,
  onWriteAnother,
}: {
  entry: EntryFull;
  type: EntryType;
  checks: Check[];
  summary: string;
  done: boolean;
  busy: boolean;
  problem: string | null;
  onPublish: () => void;
  onFix: (field: "title" | "slug") => void;
  onClose: () => void;
  onWriteAnother: () => void;
}) {
  const intl = useIntl();
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [copied, setCopied] = useState<"copied" | "failed" | null>(null);
  const fullAddress = new URL(entry.url ?? entry.address.path, window.location.origin).href;
  const noTitle = entry.title.trim() === "";
  const addressProblem = entry.address.problem;

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
          <p role="status" className="empty:sr-only">
            {copied === "failed" ? intl.formatMessage({ id: "publish.copyFailed" }) : ""}
            {copied === "copied" ? intl.formatMessage({ id: "publish.copied" }) : ""}
          </p>
          <p role="alert" className="font-medium text-danger empty:sr-only">
            {problem}
          </p>
          <div className="flex flex-wrap gap-3">
            <a href={fullAddress} target="_blank" rel="noopener" className={primaryButtonClass}>
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
            {new URL(entry.address.path, window.location.origin).href}
          </p>
        </div>

        <div>
          <p className="text-sm text-muted">
            <FormattedMessage id="publish.social" />
          </p>
          <div className="mt-1 rounded-lg border border-muted p-3">
            <p className="font-medium [overflow-wrap:anywhere]">
              {entry.title || intl.formatMessage({ id: "list.untitled" })}
            </p>
            {summary && <p className="mt-1 line-clamp-3 text-sm text-muted">{summary}</p>}
            <p className="mt-1 text-sm text-muted">{window.location.host}</p>
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
            <ul className="mt-1 grid list-disc gap-1 ps-5">
              {checks.map((check, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the same check can appear twice
                <li key={index}>
                  <FormattedMessage
                    id={check.id}
                    {...(check.values ? { values: check.values } : {})}
                  />
                </li>
              ))}
            </ul>
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
              if (!blocked && !busy) onPublish();
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
