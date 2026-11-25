import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { primaryButtonClass, secondaryButtonClass } from "../components/AuthLayout.tsx";
import { Dialog } from "../components/Dialog.tsx";
import { Field } from "../components/fields.tsx";
import { api, errorText } from "../lib/api.ts";
import { toHref } from "../lib/href.ts";
import type { LinkTarget } from "../lib/queries.ts";

const ENTRY_PREFIX = "entry:";
const SEARCH_DELAY_MS = 200;

/** Picks where a link or button goes: one of this site's pages, or any address. */
export function LinkDialog({
  heading,
  initialHref,
  label,
  onSubmit,
  onRemove,
  onClose,
}: {
  heading: string;
  initialHref: string;
  /** For a button, which has words of its own. Leave out for a link. */
  label?: string | undefined;
  onSubmit: (result: { href: string; title: string | null; label: string }) => void;
  onRemove?: (() => void) | undefined;
  onClose: () => void;
}) {
  const intl = useIntl();
  const headingId = useId();
  const resultsId = useId();
  const initialEntry = initialHref.startsWith(ENTRY_PREFIX)
    ? initialHref.slice(ENTRY_PREFIX.length)
    : null;
  const [typed, setTyped] = useState(initialEntry ? "" : initialHref);
  const [query, setQuery] = useState(initialEntry ? "" : initialHref);
  const [picked, setPicked] = useState<LinkTarget | null>(null);
  const [unpickedInitial, setUnpickedInitial] = useState(initialEntry === null);
  const [words, setWords] = useState(label ?? "");
  const [problem, setProblem] = useState<{ field: "address" | "label"; message: string } | null>(
    null,
  );
  const withLabel = label !== undefined;
  const chosenRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const movedByPerson = useRef(false);

  useEffect(() => {
    const timer = setTimeout(() => setQuery(typed), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [typed]);

  const current = useQuery({
    queryKey: ["link-target", initialEntry],
    enabled: initialEntry !== null && !unpickedInitial,
    queryFn: () =>
      api<{ targets: LinkTarget[] }>(`/admin/link-targets?ids=${initialEntry}`).then(
        (reply) => reply.targets[0] ?? null,
      ),
  });
  const chosen = picked ?? (unpickedInitial ? null : (current.data ?? null));

  const search = useQuery({
    queryKey: ["link-targets", query.trim()],
    enabled: chosen === null,
    staleTime: 10_000,
    queryFn: () =>
      api<{ targets: LinkTarget[] }>(
        `/admin/link-targets?q=${encodeURIComponent(query.trim())}`,
      ).then((reply) => reply.targets),
  });
  const results = search.data ?? [];

  // What was just pressed has been replaced, and focus shouldn't vanish with it. The opening
  // state is left alone, because a field's autoFocus has already dealt with that.
  const chosenId = chosen?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: follows what's been chosen
  useEffect(() => {
    const dialog = (chosenRef.current ?? searchRef.current)?.closest("dialog");
    const active = document.activeElement;
    // Also when the page being linked to arrives after opening and replaces the search box
    // that had focus, which leaves focus nowhere.
    const lost = !active || active === document.body || !dialog?.contains(active);
    if (!movedByPerson.current && !lost) return;
    movedByPerson.current = false;
    (chosenRef.current ?? searchRef.current)?.focus();
  }, [chosenId]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (withLabel && words.trim() === "") {
      setProblem({ field: "label", message: intl.formatMessage({ id: "link.labelRequired" }) });
      return;
    }
    const finish = (href: string, title: string | null) =>
      onSubmit({ href, title, label: words.trim() });
    if (chosen) {
      finish(`${ENTRY_PREFIX}${chosen.id}`, chosen.title);
      return;
    }
    // The link in the document points to something this search can't see, like a page
    // that's since been deleted. It stays as it was unless someone changes it.
    if (initialEntry && !unpickedInitial) {
      finish(initialHref, null);
      return;
    }
    const href = toHref(typed);
    if (href) {
      finish(href, null);
      return;
    }
    // A button can wait for its address. It's flagged before publishing.
    if (typed.trim() === "") {
      if (withLabel) finish("", null);
      else setProblem({ field: "address", message: intl.formatMessage({ id: "link.badAddress" }) });
      return;
    }
    // Pressing Enter on words: asks about exactly these words, not what the list last showed.
    let best: LinkTarget | undefined;
    try {
      const reply = await api<{ targets: LinkTarget[] }>(
        `/admin/link-targets?q=${encodeURIComponent(typed.trim())}`,
      );
      best = reply.targets[0];
    } catch (error) {
      setProblem({
        field: "address",
        message: errorText(error, intl.formatMessage({ id: "offline.body" })),
      });
      return;
    }
    if (best) finish(`${ENTRY_PREFIX}${best.id}`, best.title);
    else setProblem({ field: "address", message: intl.formatMessage({ id: "link.badAddress" }) });
  }

  return (
    <Dialog labelledBy={headingId} onClose={onClose}>
      <form onSubmit={submit} noValidate className="grid gap-4">
        <h2 id={headingId} className="text-xl font-bold">
          {heading}
        </h2>
        {withLabel && (
          <Field
            label={intl.formatMessage({ id: "link.label" })}
            value={words}
            maxLength={200}
            autoFocus
            error={problem?.field === "label" ? problem.message : undefined}
            onChange={(event) => {
              setWords(event.target.value);
              setProblem(null);
            }}
          />
        )}
        {chosen ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-sunken p-4">
            <span role="status">
              <FormattedMessage
                id="link.goesTo"
                values={{ title: chosen.title || intl.formatMessage({ id: "list.untitled" }) }}
              />
            </span>
            <button
              ref={chosenRef}
              type="button"
              className={secondaryButtonClass}
              onClick={() => {
                movedByPerson.current = true;
                setPicked(null);
                setUnpickedInitial(true);
                setTyped("");
                setQuery("");
              }}
            >
              <FormattedMessage id="link.change" />
            </button>
          </div>
        ) : (
          <>
            <Field
              ref={searchRef}
              label={intl.formatMessage({ id: "link.search" })}
              hint={intl.formatMessage({ id: "link.searchHint" })}
              value={typed}
              autoFocus={!withLabel}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              aria-controls={resultsId}
              error={problem?.field === "address" ? problem.message : undefined}
              onChange={(event) => {
                setTyped(event.target.value);
                setProblem(null);
              }}
            />
            <p role="status" className="sr-only">
              {search.data && query.trim() !== ""
                ? intl.formatMessage({ id: "link.found" }, { count: results.length })
                : ""}
            </p>
            <ul id={resultsId} className="grid gap-1 empty:hidden">
              {results.map((target) => (
                <li key={target.id}>
                  <button
                    type="button"
                    onClick={() => {
                      movedByPerson.current = true;
                      setPicked(target);
                      setProblem(null);
                    }}
                    className="flex min-h-11 w-full flex-wrap items-center justify-between gap-x-3 rounded-xl px-3 py-1 text-start hover:bg-ink/5 focus-visible:outline-3 focus-visible:outline-brand"
                  >
                    <span className="font-medium">
                      {target.title || intl.formatMessage({ id: "list.untitled" })}
                    </span>
                    <span className="text-sm text-muted">
                      {target.url ?? intl.formatMessage({ id: "link.notOnSite" })}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        <div className="flex flex-wrap gap-3">
          <button type="submit" className={primaryButtonClass}>
            <FormattedMessage id="link.apply" />
          </button>
          {onRemove && (
            <button type="button" onClick={onRemove} className={secondaryButtonClass}>
              <FormattedMessage id={withLabel ? "link.removeButton" : "link.remove"} />
            </button>
          )}
          <button type="button" onClick={onClose} className={secondaryButtonClass}>
            <FormattedMessage id="common.cancel" />
          </button>
        </div>
      </form>
    </Dialog>
  );
}
